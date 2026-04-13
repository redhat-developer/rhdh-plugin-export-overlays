#!/usr/bin/env python3
"""
Validate Package metadata: each workspaces/*/metadata/*.yaml must either
include a non-empty first appConfigExamples[].content or declare opt-out via
spec.appConfigNotRequired: true with appConfigExamples: [].

Empty mapping content ({}) is treated as missing (fail), per RHIDP-12590.
"""

from __future__ import annotations

import argparse
import glob
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    print("PyYAML is required: pip install pyyaml", file=sys.stderr)
    sys.exit(2)


def _is_empty_content(content: Any) -> bool:
    if content is None:
        return True
    if isinstance(content, dict) and len(content) == 0:
        return True
    if isinstance(content, list) and len(content) == 0:
        return True
    if isinstance(content, str) and content.strip() == "":
        return True
    return False


def _git_changed_metadata(since: str) -> list[str]:
    """Paths changed between since and HEAD under workspaces/*/metadata/*.yaml."""
    try:
        out = subprocess.run(
            [
                "git",
                "diff",
                "--name-only",
                "--diff-filter=ACMR",
                f"{since}...HEAD",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError as e:
        print(e.stderr or str(e), file=sys.stderr)
        sys.exit(2)
    paths: list[str] = []
    for line in out.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        p = Path(line)
        if (
            len(p.parts) >= 4
            and p.parts[0] == "workspaces"
            and p.parts[2] == "metadata"
            and p.suffix == ".yaml"
            and p.is_file()
        ):
            paths.append(line)
    return sorted(paths)


def _load(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: root must be a mapping")
    return data


def _evaluate_file(path: str) -> tuple[str, str]:
    """
    Returns (status, detail) where status is PASS | FAIL | SKIP.
    """
    try:
        doc = _load(path)
    except Exception as e:
        return "FAIL", f"YAML error: {e}"

    if doc.get("kind") != "Package":
        return "SKIP", "kind is not Package"

    spec = doc.get("spec")
    if not isinstance(spec, dict):
        return "FAIL", "missing or invalid spec"

    not_required = spec.get("appConfigNotRequired") is True
    examples = spec.get("appConfigExamples")

    if examples is None:
        examples = []

    if not isinstance(examples, list):
        return "FAIL", "appConfigExamples must be a list"

    if len(examples) == 0:
        if not_required:
            return "PASS", "opt-out (appConfigNotRequired)"
        return "FAIL", "empty appConfigExamples without spec.appConfigNotRequired: true"

    first = examples[0]
    if not isinstance(first, dict):
        return "FAIL", "appConfigExamples[0] must be a mapping"

    content = first.get("content")
    if _is_empty_content(content):
        return "FAIL", "appConfigExamples[0].content is empty or {}"

    return "PASS", "has non-empty first example content"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--since",
        metavar="SHA",
        help=(
            "Only validate metadata YAML files changed in git range SHA...HEAD. "
            "If no matching files changed, exit 0."
        ),
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    os.chdir(repo_root)

    if args.since:
        paths = _git_changed_metadata(args.since)
        if not paths:
            print("No workspaces/*/metadata/*.yaml changes in range; nothing to validate.")
            return 0
    else:
        paths = sorted(glob.glob("workspaces/*/metadata/*.yaml"))

    rows: list[tuple[str, str, str]] = []
    failures = 0
    for path in paths:
        status, detail = _evaluate_file(path)
        rows.append((status, path, detail))
        if status == "FAIL":
            failures += 1

    # Summary table
    w_status = max(len("STATUS"), max((len(r[0]) for r in rows), default=4))
    print(f"{'STATUS'.ljust(w_status)}  FILE")
    print("-" * (w_status + 3 + 72))
    for status, path, detail in rows:
        line = f"{status.ljust(w_status)}  {path}"
        if status != "PASS":
            line += f"  # {detail}"
        print(line)

    print()
    print(f"Total: {len(rows)}  PASS: {sum(1 for r in rows if r[0] == 'PASS')}  FAIL: {failures}")
    if failures:
        print("\nValidation failed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
