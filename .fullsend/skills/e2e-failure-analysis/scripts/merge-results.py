#!/usr/bin/env python3
"""merge-results.py — Collect per-cause JSON results into agent-result.json

Each input file is one root CAUSE (which the agent may have grouped across
several workspaces and authored as a single deduplicated issue body). This
script does NOT group or author — it collects, generates a log summary, and
validates. Grouping and dedup are the agent's job.

Usage:
    python3 merge-results.py --target-branch <branch> --output <path> <results-dir>
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

FIX_CATEGORIES = ["infra_flake", "test_fix", "product_bug", "environment", "upstream_test_utils"]
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
# individual result file, with the file name in the error. This is separate
# from schema conformance — validate_against_schema() checks the final
# agent-result.json against e2e-triage-result.schema.json, but these per-file
# checks pin an error to the input file that caused it. Re-encoding the
# *entire* schema here would just create a second copy that can drift; this
# only checks the handful of fields an LLM is most likely to get subtly wrong.
def parse_result(file: str, raw: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"{file}: failed to parse JSON: {e}")
    if not isinstance(parsed, dict):
        raise ValueError(f"{file}: must be a JSON object")

    workspaces = parsed.get("affected_workspaces")
    if not isinstance(workspaces, list) or not workspaces:
        raise ValueError(f'{file}: missing or empty "affected_workspaces"')
    if not all(isinstance(w, str) and w for w in workspaces):
        raise ValueError(f'{file}: "affected_workspaces" must be non-empty strings')

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


# --- Summary generation (stdout/context log only — not posted to GitHub) ---
def generate_summary(results: list[dict[str, Any]]) -> str:
    lines: list[str] = [f"Causes classified: {len(results)}", ""]
    for r in results:
        lines.append(f'  [{", ".join(r["affected_workspaces"])}]')
        lines.append(f'    Category:  {r["fix_category"]}')
        lines.append(f'    Slug:      {r["root_cause_slug"]}')
        lines.append(f'    Tests:     {len(r["tests"])}')
        action = r["issue"]["action"] if r.get("issue") else "skip"
        lines.append(f"    Action:    {action}")
        lines.append("")
    return truncate_at_boundary("\n".join(lines), 4096)


# --- JSON Schema validation ---
# Validates the final agent-result.json against e2e-triage-result.schema.json
# using the jsonschema library (available in the sandbox image). This catches
# constraints the ad-hoc checks in parse_result() don't cover:
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


# --- Cross-entry invariant: slugs must be unique across entries ---
# Grouping is the agent's job now, so the schema (validate_against_schema)
# covers each entry on its own. The one cross-entry invariant a dumb script can
# still enforce is that no two entries share a root_cause_slug: either the agent
# missed a merge (same cause, should be one issue) or its slugs drift (different
# causes reusing a slug, which breaks cross-run dedup). This must be FATAL, not a
# warning — the harness validation loop (validation_loop.max_iterations) re-runs
# the agent on a non-zero exit but ignores stderr, so only a hard failure gives
# the agent a second pass to reconcile. A warning would let the last-written
# file silently win and drop every workspace unique to the overwritten entry.
def slug_uniqueness_errors(result: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    slugs: dict[str, list[str]] = {}
    for entry in result["issues"]:
        slug = entry.get("root_cause_slug")
        if not slug:
            continue
        slugs.setdefault(slug, []).extend(entry.get("affected_workspaces", []))
    for slug, workspaces in slugs.items():
        if len([e for e in result["issues"] if e.get("root_cause_slug") == slug]) > 1:
            errors.append(
                f'slug "{slug}" appears on more than one entry (workspaces: '
                f'{", ".join(workspaces)}). If these share a cause, merge them into '
                f"one entry; if they don't, give them distinct slugs so cross-run "
                f"dedup stays reliable."
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
            "<results-dir>\n"
        )
        sys.exit(1)

    files = sorted(f for f in os.listdir(input_dir) if f.endswith(".json"))
    if not files:
        sys.stderr.write(f"No .json files found in {input_dir}\n")
        sys.exit(1)

    entries: list[dict[str, Any]] = []
    for f in files:
        with open(os.path.join(input_dir, f)) as fh:
            raw = fh.read()
        try:
            entries.append(parse_result(f, raw))
        except ValueError as e:
            sys.stderr.write(f"{e}\n")
            sys.exit(1)

    # Stable ordering by first affected workspace.
    entries.sort(key=lambda e: e["affected_workspaces"][0])
    summary = generate_summary(entries)

    result = {
        "target_branch": target_branch,
        "issues": entries,
        "summary": summary,
    }

    # Fatal: two entries must never share a slug (missed merge / slug drift).
    # Fail before writing so the validation loop re-runs the agent to reconcile.
    slug_errors = slug_uniqueness_errors(result)
    if slug_errors:
        sys.stderr.write("Duplicate root_cause_slug across entries:\n")
        for e in slug_errors:
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
