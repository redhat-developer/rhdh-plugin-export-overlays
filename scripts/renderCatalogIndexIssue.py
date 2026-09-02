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


def load_report(path: Path) -> dict | None:
    """The report, or None. A missing or unparseable file is itself worth an issue —
    the harness not reaching its report stage is a failure, not a reason to stay silent."""
    try:
        with open(path, encoding="utf-8") as handle:
            report = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return report if isinstance(report, dict) else None


def _plugin_failures(entries: object) -> list[str]:
    """`name: error` lines from one PluginError list.

    `.plugin` is an object, so a bare fallback would put the whole thing in the issue —
    the trap the job summary's jq already carries a comment about.
    """
    lines = []
    for item in entries or []:
        if not isinstance(item, dict):
            continue
        name = ((item.get("plugin") or {}).get("name")) or "?"
        lines.append(f"{name}: {item.get('error') or '?'}")
    return lines


def _config_key_failures(entries: object) -> list[str]:
    """The same, for mismatches — which carry a metadata file rather than a plugin.

    The field arrives with RHIDP-16690; reading it before then is harmless, because a
    report without it yields an empty list like any other.
    """
    return [
        f"{item.get('source') or '?'}: configured key "
        f"'{item.get('key') or '?'}' matches no bundle name"
        for item in entries or []
        if isinstance(item, dict)
    ]


def collect_failures(report: dict | None) -> list[str]:
    """Every per-package failure the report holds.

    All four lists, not just the two the job summary prints: a plugin that failed to
    load and one whose bundle lost its config schema are both reasons this ran red, and
    an issue naming only some of them sends the reader back to the artifact.
    """
    if report is None:
        return []
    backend = report.get("backend") or {}
    frontend = report.get("frontend") or {}
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


def render_body(
    report: dict | None, image: str, digest: str, run_url: str
) -> str:
    failures = collect_failures(report)
    status = (report or {}).get("status") or "unknown"
    lines = [
        f"The scheduled catalog index sanity check failed against `{image}`.",
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
        lines += [
            "The report holds no per-package failure, so the job failed outside the "
            "per-plugin checks (an install shortfall, or the backend not starting). "
            "See the run and the `catalog-index-sanity` artifact.",
        ]
    else:
        lines += [f"### Failing packages ({len(failures)})", ""]
        lines += [f"- {line}" for line in failures[:MAX_LISTED]]
        if len(failures) > MAX_LISTED:
            lines += [
                "",
                f"…and {len(failures) - MAX_LISTED} more — the full list is in the "
                "`catalog-index-sanity` artifact.",
            ]
    lines += [
        "",
        "The catalog index is built outside this repo and changes on its own, so this "
        "is not tied to any commit here. See RHIDP-16470 for where each half of the "
        "plugin-sanity check runs and why.",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
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
