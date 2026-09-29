#!/usr/bin/env python3
#
# Copyright (c) Red Hat, Inc.
#
# Render a catalog-index sanity failure into the GitHub issue the triage path files
# (RHIDP-16694). Rendering only: creating, deduplicating and labelling the issue is the
# workflow's job, so the part with judgement in it is testable without GitHub.
#
# Usage:
#   python3 renderCatalogIndexIssue.py \
#     --results smoke-tests-native/results-catalog-index.json \
#     --image quay.io/rhdh/plugin-catalog-index:next \
#     --digest sha256:... \
#     --run-url https://github.com/.../actions/runs/123 \
#     --title-out title.txt --body-out body.md

import argparse
import json
import sys
from pathlib import Path

from plugin_utils import PathNotContainedError, require_contained

# How many failing packages the body lists before pointing at the artifact. A broken
# index can fail dozens at once, and an issue that opens with sixty identical lines is
# read by nobody; the full list is in results-catalog-index.json either way.
MAX_LISTED = 20

# Per-line ceiling. `PluginError.error` is a raw `err.message`, and Node's
# MODULE_NOT_FOUND — the most common fail-load cause — spans several lines ("Cannot find
# module 'x'\nRequire stack:\n- …"). Embedded newlines break the bullet list into loose
# paragraphs, and twenty multi-KB messages can push the body past GitHub's 65536-character
# limit, at which point `gh issue create` returns 422 and nothing is filed at all. Mirrors
# DETAIL_LIMIT in smoke-tests-native/src/aggregate-report.ts, which flattens for the same
# reason.
LINE_LIMIT = 300


def _one_line(text: str) -> str:
    """Collapse whitespace and cap the length. The full text is in the artifact."""
    flat = " ".join(text.split())
    return flat if len(flat) <= LINE_LIMIT else f"{flat[: LINE_LIMIT - 1]}…"


def load_report(path: Path) -> dict | None:
    """The report, or None. A missing or unparseable file is itself worth an issue —
    the harness not reaching its report stage is a failure, not a reason to stay silent.

    `ValueError` rather than `json.JSONDecodeError`, because the decode happens on read:
    a file whose bytes are not valid UTF-8 raises `UnicodeDecodeError`, which is a
    `ValueError` and not an `OSError`, so naming JSONDecodeError alone let it escape. The
    artifact this reads comes from a job that just died, which is exactly where a write
    truncated mid-character comes from.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            report = json.load(handle)
    except (OSError, ValueError):
        return None
    return report if isinstance(report, dict) else None


def _record(value: object, key: str) -> dict:
    """One property of `value`, when both it and the property are dicts; {} otherwise.

    The rest of this module goes to some length to tolerate whatever is on the disk of a
    job that just died — `load_report` rejects lists and scalars, `_plugin_failures` skips
    non-dict entries. Reading `report["backend"]["errors"]` without the same care was the
    gap: a truthy non-dict raises AttributeError, which kills the render step, and then no
    issue is filed at all.
    """
    if not isinstance(value, dict):
        return {}
    inner = value.get(key)
    return inner if isinstance(inner, dict) else {}


def _plugin_failures(entries: object) -> list[str]:
    """`name: error` lines from one PluginError list.

    `.plugin` is an object, so a bare fallback would put the whole thing in the issue —
    the trap the job summary's jq already carries a comment about.
    """
    lines = []
    for item in entries or []:
        if not isinstance(item, dict):
            continue
        name = _record(item, "plugin").get("name") or "?"
        lines.append(_one_line(f"{name}: {item.get('error') or '?'}"))
    return lines


def _config_key_failures(entries: object) -> list[str]:
    """The same, for mismatches — which carry a metadata file rather than a plugin.

    The field arrives with RHIDP-16690; reading it before then is harmless, because a
    report without it yields an empty list like any other.
    """
    return [
        _one_line(
            f"{item.get('source') or '?'}: configured key "
            f"'{item.get('key') or '?'}' matches no bundle name"
        )
        for item in entries or []
        if isinstance(item, dict)
    ]


def collect_failures(report: dict | None) -> list[str]:
    """Every per-package failure the report holds.

    Every list the report can carry, not just the two the job summary prints: a plugin
    that failed to load and one whose bundle lost its config schema are both reasons this
    ran red, and an issue naming only some of them sends the reader back to the artifact.

    `configKeyMismatches` is read for completeness but is always empty HERE:
    native-smoke.ts records it in workspace mode only, and this workflow runs
    catalog-index mode. It costs nothing and keeps the function honest if the renderer is
    ever pointed at a workspace run.
    """
    if report is None:
        return []
    backend = _record(report, "backend")
    frontend = _record(report, "frontend")
    return [
        *_plugin_failures(backend.get("errors")),
        *_plugin_failures(backend.get("bundleErrors")),
        *_plugin_failures(frontend.get("errors")),
        *_config_key_failures(frontend.get("configKeyMismatches")),
    ]


def render_title(image: str) -> str:
    """Stable across runs, deliberately: the workflow looks an open issue up by this
    exact string to avoid filing a second one every night the index stays broken. Adding
    a date or a digest here would defeat that.

    The empty case is reachable: the job passes `needs.sanity.outputs.image` straight
    through, and that output is "" whenever the sanity job died before its "Resolve the
    catalog index image" step ran — a checkout or a setup failure. A title ending in a
    colon and nothing else names no index at all, so say so instead.
    """
    return f"[fullsend] Catalog index sanity failed: {image or '(image unresolved)'}"


def _no_failure_lines(report: dict) -> list[str]:
    """What a run that failed outside the per-plugin checks can still tell the reader.

    Both causes live in the report. writeErrorReport() in native-smoke.ts — bad args, an
    install-CLI crash, a boot failure before the report is built — emits no per-package
    error at all and puts the whole root cause in backendStart.error.

    The emptiness test is relative, not absolute: an earlier version compared
    `len(lines) == 2` against a list that already carried the header, so the fallback was
    unreachable and a report with neither cause rendered "What it does say:" followed by
    nothing — the content-free issue this branch exists to prevent.
    """
    lines: list[str] = []
    shortfall = report.get("installShortfall")
    start_error = _record(report, "backendStart").get("error")
    if isinstance(shortfall, str) and shortfall:
        lines.append(f"- Install shortfall: {_one_line(shortfall)}")
    if isinstance(start_error, str) and start_error:
        lines.append(f"- Backend start: {_one_line(start_error)}")
    if not lines:
        lines.append(
            "- Nothing beyond the status above — see the run and the "
            "`catalog-index-sanity` artifact."
        )
    return ["The report holds no per-package failure. What it does say:", "", *lines]


def _failure_lines(failures: list[str]) -> list[str]:
    """The failing packages, capped — see MAX_LISTED."""
    lines = [f"### Failing packages ({len(failures)})", ""]
    lines += [f"- {line}" for line in failures[:MAX_LISTED]]
    if len(failures) > MAX_LISTED:
        lines += [
            "",
            f"…and {len(failures) - MAX_LISTED} more — the full list is in the "
            "`catalog-index-sanity` artifact.",
        ]
    return lines


def render_body(
    report: dict | None, image: str, digest: str, run_url: str
) -> str:
    failures = collect_failures(report)
    status = (report or {}).get("status") or "unknown"
    lines = [
        "The scheduled catalog index sanity check failed against "
        f"`{image or '(image unresolved)'}`.",
        "",
        f"- Index digest: `{digest or 'unresolved'}`",
        f"- Harness status: `{status}`",
        f"- Workflow run: {run_url}",
        "",
    ]
    if report is None:
        lines += [
            "No readable `results-catalog-index.json` was produced, so the harness did "
            "not reach its report stage — the failure is before any per-package result. "
            "The workflow run above has the logs.",
        ]
    elif not failures:
        lines += _no_failure_lines(report)
    else:
        lines += _failure_lines(failures)
    lines += [
        "",
        "The catalog index is built outside this repo and changes on its own, so this "
        "is not tied to any commit here. See RHIDP-16470 for where each half of the "
        "plugin-sanity check runs and why.",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render a catalog-index sanity failure into a GitHub issue "
        "title and body."
    )
    parser.add_argument("--results", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--digest", default="")
    parser.add_argument("--run-url", default="")
    parser.add_argument("--title-out", required=True)
    parser.add_argument("--body-out", required=True)
    args = parser.parse_args()

    # Every path here came from argv. Same rule validateCatalogIndex.py applies, through
    # the same helper: resolved and required to stay inside the working directory before
    # any filesystem call (Sonar S8707).
    try:
        results = require_contained("--results", args.results)
        title_out = require_contained("--title-out", args.title_out)
        body_out = require_contained("--body-out", args.body_out)
    except PathNotContainedError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    report = load_report(results)
    # `open()` rather than Path.write_text, matching every other script here — and it is
    # what lets Sonar's taint analysis follow the confinement above through to the write.
    with open(title_out, "w", encoding="utf-8") as handle:
        handle.write(render_title(args.image))
    with open(body_out, "w", encoding="utf-8") as handle:
        handle.write(render_body(report, args.image, args.digest, args.run_url))
    return 0


if __name__ == "__main__":
    sys.exit(main())
