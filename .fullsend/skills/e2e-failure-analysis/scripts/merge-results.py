#!/usr/bin/env python3
"""merge-results.py — Combine per-workspace JSON results into agent-result.json

Usage:
    python3 merge-results.py --target-branch <branch> --output <path> <workspace-results-dir>
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

FIX_CATEGORIES = ["infra_flake", "test_fix", "product_bug", "environment"]
VALID_CATEGORIES = set(FIX_CATEGORIES)
VALID_ACTIONS = {"create", "comment", "skip"}

# root_cause_slug pattern — mirrors the schema's. If the schema's pattern
# changes, update it here too.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")


def _js_typeof(v: Any) -> str:
    """JS `typeof` for the JSON value types, so error messages match the
    previous TS implementation (e.g. a string reads as "string", null as
    "object")."""
    if v is None:
        return "object"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    return "object"  # list / dict


def _is_js_number(v: Any) -> bool:
    """True for JSON numbers (int or float) but not booleans — matching JS
    `typeof v === "number"`. Note bool is an int subclass in Python."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# --- Per-file parsing ---
# Catches the most common LLM authoring mistakes (wrong enum casing, a
# string where an integer is required, a slug that isn't kebab-case) at the
# individual workspace file, with the file name in the error. This is
# separate from schema conformance — the harness's validation_loop already
# validates the final agent-result.json against
# e2e-triage-result.schema.json, but that runs after umbrella merging, so an
# error there can't always be traced back to the input file that caused it.
# Re-encoding the *entire* schema here would just create a second copy that
# can drift; this only checks the handful of fields an LLM is most likely
# to get subtly wrong.
def parse_workspace_result(file: str, raw: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"{file}: failed to parse JSON: {e}")
    if not isinstance(parsed, dict):
        raise ValueError(f"{file}: must be a JSON object")

    workspace = parsed.get("workspace")
    if not isinstance(workspace, str) or len(workspace) == 0:
        raise ValueError(f'{file}: missing or invalid "workspace"')

    fix_category = parsed.get("fix_category")
    if fix_category not in VALID_CATEGORIES:
        raise ValueError(
            f'{file}: invalid fix_category "{fix_category}" '
            f'(expected: {", ".join(FIX_CATEGORIES)})'
        )

    slug = parsed.get("root_cause_slug")
    if not isinstance(slug, str) or not _SLUG_RE.match(slug):
        raise ValueError(f'{file}: invalid root_cause_slug "{slug}"')

    issue = parsed.get("issue")
    if isinstance(issue, dict):
        if issue.get("action") not in VALID_ACTIONS:
            raise ValueError(f'{file}: invalid issue.action "{issue.get("action")}"')
        if issue.get("action") == "comment" and not _is_js_number(issue.get("number")):
            raise ValueError(
                f'{file}: issue.action is "comment" but issue.number is '
                f"{_js_typeof(issue.get('number'))} (expected integer)"
            )

    return parsed


# --- Truncate long text at a line (or word) boundary instead of
# mid-sentence/mid-fence ---
def truncate_at_boundary(s: str, max_len: int) -> str:
    marker = "\n\n_(truncated)_"
    if len(s) <= max_len:
        return s
    budget = max_len - len(marker)
    half = budget * 0.5

    # rfind(sub, 0, budget + 1) mirrors JS lastIndexOf(sub, budget):
    # highest index <= budget, or -1 if not found.
    cut = s.rfind("\n", 0, budget + 1)
    if cut <= half:
        # No newline in the back half of the budget (e.g. one very long line) —
        # fall back to a word boundary so we don't split a token/URL.
        cut = s.rfind(" ", 0, budget + 1)
    if cut <= half:
        cut = budget

    return s[:cut] + marker


# --- Category dominance ---
# When >=3 workspaces share a root_cause_slug, they merge into one umbrella
# entry with a single fix_category. Rank favors actionable categories over
# infra_flake so a single misclassified sibling can't cause a real bug to be
# silently skipped — the tradeoff is that one bad classification can pull an
# otherwise-transient group into "create issue" territory. That's considered
# the safer failure mode (a human closes a spurious issue) vs the reverse
# (a real bug never gets filed).
CATEGORY_RANK = {
    "test_fix": 3,
    "product_bug": 2,
    "environment": 1,
    "infra_flake": 0,
}


def dominant_category(categories: list[str]) -> str:
    best = categories[0]
    for c in categories[1:]:
        if CATEGORY_RANK[c] > CATEGORY_RANK[best]:
            best = c
    return best


# --- Umbrella merge ---
def apply_umbrella_rule(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for ws in results:
        groups.setdefault(ws["root_cause_slug"], []).append(ws)

    merged: list[dict[str, Any]] = []
    for slug, members in groups.items():
        if len(members) >= 3:
            # Merge into one umbrella entry
            tests = [t for m in members for t in m["tests"]]
            category = dominant_category([m["fix_category"] for m in members])
            root_cause = "\n".join(f'[{m["workspace"]}] {m["root_cause"]}' for m in members)
            first_desc = members[0]["root_cause"][:100]

            issue: dict[str, Any] | None = None
            issue_members = [
                m for m in members if m.get("issue") and m["issue"].get("action") != "skip"
            ]
            if issue_members:
                body = "\n\n---\n\n".join(
                    f'## {m["workspace"]}\n\n{m["issue"]["body"]}' for m in issue_members
                )
                all_labels: list[str] = []
                for m in issue_members:
                    for lbl in m["issue"].get("labels", []):
                        if lbl not in all_labels:
                            all_labels.append(lbl)

                # Siblings may already have separate open issues (found during
                # dedup) before the group was recognized as sharing one root
                # cause. Comment on the oldest one and flag the rest — don't
                # silently drop them.
                comment_numbers = sorted(
                    {
                        m["issue"]["number"]
                        for m in issue_members
                        if m["issue"].get("action") == "comment"
                        and m["issue"].get("number") is not None
                    }
                )

                if len(comment_numbers) > 1:
                    others = ", ".join(f"#{n}" for n in comment_numbers[1:])
                    body = (
                        f"**Note:** Related existing issues found for other "
                        f"workspaces in this group: {others} — review for manual "
                        f"dedup.\n\n{body}"
                    )

                issue = {
                    "action": "comment" if comment_numbers else "create",
                    **(
                        {"number": comment_numbers[0]}
                        if comment_numbers
                        else {"title": f"[fullsend] E2E: {slug} — {first_desc}"}
                    ),
                    "labels": all_labels,
                    "body": truncate_at_boundary(body, 16384),
                    "cycle_ready_to_code": any(
                        m["issue"].get("cycle_ready_to_code") for m in issue_members
                    ),
                }

            entry: dict[str, Any] = {
                "workspace": slug,
                "fix_category": category,
                "tests": tests,
                "root_cause": truncate_at_boundary(root_cause, 4096),
                "root_cause_slug": slug,
            }
            if issue is not None:
                entry["issue"] = issue
            merged.append(entry)
        else:
            merged.extend(members)

    return sorted(merged, key=lambda w: w["workspace"])


# --- Summary generation ---
def generate_summary(results: list[dict[str, Any]]) -> str:
    lines: list[str] = [f"Workspaces classified: {len(results)}", ""]
    for ws in results:
        lines.append(f'  [{ws["workspace"]}]')
        lines.append(f'    Category:  {ws["fix_category"]}')
        lines.append(f'    Slug:      {ws["root_cause_slug"]}')
        lines.append(f'    Tests:     {len(ws["tests"])}')
        action = ws["issue"]["action"] if ws.get("issue") else "skip"
        lines.append(f"    Action:    {action}")
        lines.append("")
    return truncate_at_boundary("\n".join(lines), 4096)


# --- JSON Schema validation ---
# Validates the final agent-result.json against e2e-triage-result.schema.json
# using the jsonschema library (available in the sandbox image). This catches
# constraints the ad-hoc checks in parse_workspace_result() don't cover:
# additionalProperties, length limits, conditional allOf rules, etc.
def validate_against_schema(result_path: str) -> list[str]:
    schema_path = os.environ.get("FULLSEND_OUTPUT_SCHEMA") or str(
        (
            Path(__file__).resolve().parent
            / "../../../../.fullsend/rhdh/schemas/e2e-triage-result.schema.json"
        ).resolve()
    )

    if not os.path.exists(schema_path):
        sys.stderr.write(
            f"Schema file not found at {schema_path} — skipping JSON Schema validation\n"
        )
        return []

    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        sys.stderr.write("jsonschema not installed — skipping JSON Schema validation\n")
        return []

    with open(result_path) as f:
        instance = json.load(f)
    with open(schema_path) as f:
        schema = json.load(f)

    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
    return [e.message for e in errors]


# --- Cross-workspace validation ---
# Full schema conformance (required fields, enums, length limits, the
# create/comment allOf rules) is now also enforced in-process by
# validate_against_schema(). The harness's validation_loop
# (validate-output-schema.sh) and fullsend-check-output remain as additional
# downstream checks. This function checks an invariant the schema can't
# express because it spans multiple workspace entries.
def validate(result: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    # dict.fromkeys preserves first-seen order (like a JS Set) so the error
    # message lists categories in encounter order, matching the previous TS.
    slug_categories: dict[str, dict[str, None]] = {}
    for ws in result["workspaces"]:
        slug = ws.get("root_cause_slug")
        if not slug:
            continue
        slug_categories.setdefault(slug, {})[ws["fix_category"]] = None
    for slug, categories in slug_categories.items():
        if len(categories) > 1:
            # Applies regardless of group size: dominant_category() only runs
            # for groups of >=3, but two workspaces sharing a slug with
            # different categories is the same underlying problem — a slug is
            # supposed to mean "same root cause," which implies "same
            # fix_category."
            errors.append(
                f'root_cause_slug "{slug}" has different fix_category values across '
                f'workspaces ({", ".join(categories)}). Workspaces sharing a '
                f"slug should share a fix_category — reconcile them to the same "
                f"category, or use different slugs if they aren't actually the same cause."
            )

    return errors


def main() -> None:
    args = sys.argv[1:]
    target_branch = ""
    output_path = ""
    input_dir = ""

    i = 0
    while i < len(args):
        if args[i] == "--target-branch" and i + 1 < len(args):
            i += 1
            target_branch = args[i]
        elif args[i] == "--output" and i + 1 < len(args):
            i += 1
            output_path = args[i]
        elif not args[i].startswith("--"):
            input_dir = args[i]
        i += 1

    if not target_branch or not output_path or not input_dir:
        sys.stderr.write(
            "Usage: merge-results.py --target-branch <branch> --output <path> "
            "<workspace-results-dir>\n"
        )
        sys.exit(1)

    files = sorted(f for f in os.listdir(input_dir) if f.endswith(".json"))
    if not files:
        sys.stderr.write(f"No .json files found in {input_dir}\n")
        sys.exit(1)

    workspaces: list[dict[str, Any]] = []
    for f in files:
        with open(os.path.join(input_dir, f)) as fh:
            raw = fh.read()
        try:
            workspaces.append(parse_workspace_result(f, raw))
        except ValueError as e:
            sys.stderr.write(f"{e}\n")
            sys.exit(1)

    names = [w["workspace"] for w in workspaces]
    dup_workspaces = sorted({n for n in names if names.count(n) > 1})
    if dup_workspaces:
        sys.stderr.write(
            f"Duplicate workspace result(s) found: {', '.join(dup_workspaces)} — "
            f"each workspace should be written once. Check for stale files from a "
            f"previous run.\n"
        )
        sys.exit(1)

    final_workspaces = apply_umbrella_rule(workspaces)
    summary = generate_summary(final_workspaces)

    result = {
        "target_branch": target_branch,
        "workspaces": final_workspaces,
        "summary": summary,
    }

    validation_errors = validate(result)
    if validation_errors:
        sys.stderr.write("Validation failed:\n")
        for e in validation_errors:
            sys.stderr.write(f"  - {e}\n")
        sys.exit(1)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        # ensure_ascii=False so non-ASCII (e.g. the em-dash in issue titles)
        # is written as raw UTF-8, matching JSON.stringify and keeping the
        # output byte-identical to the previous TS implementation.
        f.write(json.dumps(result, indent=2, ensure_ascii=False) + "\n")

    schema_errors = validate_against_schema(output_path)
    if schema_errors:
        sys.stderr.write("JSON Schema validation failed:\n")
        for e in schema_errors:
            sys.stderr.write(f"  - {e}\n")
        sys.stderr.write(f"\nOutput: {output_path}\n")
        sys.exit(1)

    print(f"Wrote {output_path}")
    print("\n=== E2E Triage Results ===")
    print(summary)


if __name__ == "__main__":
    main()
