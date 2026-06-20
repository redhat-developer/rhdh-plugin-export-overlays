#!/usr/bin/env python3
"""Extract test results, deployment warnings, and config dumps from results.json.

Usage:
    python3 diagnostics.py <ARTIFACTS_DIR> [--project <name>]

Arguments:
    ARTIFACTS_DIR   Path to the artifacts directory containing playwright-report/results.json
    --project       Filter output to a specific Playwright project name (case-insensitive substring match)

Output sections:
    1. TEST RESULTS — pass/fail/skip counts and failed test details
    2. DIAGNOSTICS PER FAILED PROJECT — config table dumps and filtered warnings/errors
"""

import json
import re
import sys
from pathlib import Path


def walk_suites(suite, specs=None):
    if specs is None:
        specs = []
    for spec in suite.get("specs", []):
        specs.append(spec)
    for child in suite.get("suites", []):
        walk_suites(child, specs)
    return specs


WARNING_PATTERNS = re.compile(
    r"YAML file.*does not exist|"
    r"error|Error|ERROR|"
    r"WARN|warn|Warning|"
    r"does not exist|not found|"
    r"missing|Missing|"
    r"failed|Failed|FAILED|"
    r"CrashLoopBackOff|ImagePullBackOff|"
    r"secret.*not|Secret.*not",
    re.IGNORECASE,
)
NOISE = re.compile(r"node_modules|trace_id|Download|Extracting|integrity checksum")


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <ARTIFACTS_DIR> [--project <name>]", file=sys.stderr)
        sys.exit(1)

    artifacts = Path(sys.argv[1])
    project_filter = None
    if "--project" in sys.argv:
        idx = sys.argv.index("--project")
        if idx + 1 < len(sys.argv):
            project_filter = sys.argv[idx + 1].lower()

    results_file = artifacts / "playwright-report" / "results.json"
    if not results_file.exists():
        print(f"ERROR: {results_file} not found", file=sys.stderr)
        sys.exit(1)

    r = json.loads(results_file.read_text())
    stats = r.get("stats", {})
    all_specs = []
    for s in r.get("suites", []):
        walk_suites(s, all_specs)

    # Section 1: Test Results
    print("=" * 70)
    print("TEST RESULTS")
    print("=" * 70)
    print(
        f"Passed: {stats.get('expected', 0)}  "
        f"Failed: {stats.get('unexpected', 0)}  "
        f"Skipped: {stats.get('skipped', 0)}  "
        f"Flaky: {stats.get('flaky', 0)}"
    )
    print()

    failed_projects = set()
    for spec in all_specs:
        for test in spec.get("tests", []):
            proj = test.get("projectName", "?")
            if project_filter and project_filter not in proj.lower():
                continue
            for result in test.get("results", []):
                status = result["status"]
                if status not in ("passed", "skipped"):
                    failed_projects.add(proj)
                    err = result.get("error", {}).get("message", "no error")
                    print(f"FAILED [{proj}] {spec['title']}")
                    print(f"  {err[:400]}")
                    print()
                elif project_filter:
                    print(f"{status.upper()} [{proj}] {spec['title']}")

    # Section 2: Diagnostics per failed project
    for proj in sorted(failed_projects):
        print("=" * 70)
        print(f"DIAGNOSTICS FOR PROJECT: {proj}")
        print("=" * 70)
        for spec in all_specs:
            for test in spec.get("tests", []):
                if test.get("projectName") != proj:
                    continue
                for result in test.get("results", []):
                    stdout = "".join(
                        s.get("text", "") for s in result.get("stdout", [])
                    )
                    if not stdout:
                        continue

                    title = spec["title"][:50]

                    # Config tables
                    for match in re.finditer(
                        r"(┌─[^\n]*(?:Config|Plugins|Deployment|Value|Backstage)[^\n]*\n)(.*?)(└─+)",
                        stdout,
                        re.DOTALL,
                    ):
                        header = match.group(1).strip()
                        body = match.group(2)
                        if len(body) < 5000:
                            print(f"--- {header} [{title}] ---")
                            print(body.rstrip())
                            print()

                    # Warnings and errors
                    warnings = []
                    for line in stdout.split("\n"):
                        if WARNING_PATTERNS.search(line) and not NOISE.search(line):
                            warnings.append(line.rstrip())
                    if warnings:
                        print(f"--- Warnings/Errors [{title}] ---")
                        for w in warnings[-40:]:
                            print(w)
                        print()


if __name__ == "__main__":
    main()
