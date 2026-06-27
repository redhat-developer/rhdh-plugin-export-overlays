#!/usr/bin/env python3
"""Find, map, and fix Playwright trace files for pwtrace analysis.

Traces live in two locations (same content, different naming):
  1. e2e-test-results/specs-<slug>/trace.zip — named by test, easy to identify
  2. playwright-report/data/<hash>.zip — hash-named, referenced by results.json

Newer Playwright versions use `0-trace.trace` instead of `trace.trace` inside the zip,
which pwtrace can't read. This script identifies traces, maps them to test names,
and creates fixed copies that pwtrace can consume.

Usage:
    python3 find-traces.py <ARTIFACTS_DIR> [--project <name>] [--fix]

Arguments:
    ARTIFACTS_DIR   Path to the artifacts directory containing playwright-report/ and e2e-test-results/
    --project       Filter to a specific project name (case-insensitive substring)
    --fix           Create pwtrace-compatible copies in <ARTIFACTS_DIR>/fixed-traces/

Without --fix, shows trace locations and whether they need fixing.
With --fix, creates fixed copies and prints ready-to-use pwtrace commands.
"""

import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


def check_trace_format(zip_path: Path) -> tuple[str, bool]:
    """Check trace format. Returns (format_description, needs_fix)."""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            if "trace.trace" in names:
                return "standard", False
            if "0-trace.trace" in names:
                return "0-trace.trace (needs fix for pwtrace)", True
            trace_files = [n for n in names if "trace" in n.lower()]
            if trace_files:
                return f"non-standard: {trace_files}", True
            return "no trace data found", True
    except zipfile.BadZipFile:
        return "INVALID ZIP", True


def fix_trace(zip_path: Path, output_path: Path) -> bool:
    """Create a pwtrace-compatible copy by adding trace.trace alongside 0-trace.trace."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        try:
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(tmp)
        except zipfile.BadZipFile:
            return False

        src = tmp / "0-trace.trace"
        dst = tmp / "trace.trace"
        if src.exists() and not dst.exists():
            shutil.copy2(src, dst)
        elif not src.exists():
            return False

        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(tmp):
                for f in files:
                    file_path = Path(root) / f
                    arcname = file_path.relative_to(tmp)
                    zf.write(file_path, arcname)

    return True


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <ARTIFACTS_DIR> [--project <name>] [--fix]", file=sys.stderr)
        sys.exit(1)

    artifacts = Path(sys.argv[1])
    project_filter = None
    do_fix = "--fix" in sys.argv
    if "--project" in sys.argv:
        idx = sys.argv.index("--project")
        if idx + 1 < len(sys.argv):
            project_filter = sys.argv[idx + 1].lower()

    results_file = artifacts / "playwright-report" / "results.json"
    if not results_file.exists():
        print(f"ERROR: {results_file} not found", file=sys.stderr)
        sys.exit(1)

    r = json.loads(results_file.read_text())

    # Collect all specs from results.json
    all_specs = []
    def walk(suite):
        for spec in suite.get("specs", []):
            all_specs.append(spec)
        for child in suite.get("suites", []):
            walk(child)
    for s in r.get("suites", []):
        walk(s)

    fixed_dir = artifacts / "fixed-traces"
    if do_fix:
        fixed_dir.mkdir(exist_ok=True)

    # Map each failed test to its trace file
    print("=" * 70)
    print("TRACE FILES FOR FAILED TESTS")
    print("=" * 70)

    traces_found = 0
    for spec in all_specs:
        for test in spec.get("tests", []):
            proj = test.get("projectName", "?")
            if project_filter and project_filter not in proj.lower():
                continue

            for result in test.get("results", []):
                status = result.get("status", "?")
                if status in ("passed", "skipped"):
                    continue

                title = spec["title"]
                print(f"\nFAILED [{proj}] {title}")

                # Find trace from attachment
                attachments = result.get("attachments", [])
                trace_att = [a for a in attachments if a.get("name") == "trace"]
                if not trace_att:
                    print("  No trace attachment recorded")
                    continue

                ci_path = trace_att[0].get("path", "")
                if not ci_path:
                    print("  Trace attachment has no path")
                    continue

                # Find local trace via the CI slug
                slug = Path(ci_path).parent.name
                local_trace = artifacts / "e2e-test-results" / slug / "trace.zip"

                if not local_trace.exists():
                    print(f"  Trace not found at: {local_trace}")
                    continue

                size = local_trace.stat().st_size
                if size < 1000:
                    print(f"  Trace stub ({size} bytes) — no usable trace data")
                    continue

                traces_found += 1
                fmt, needs_fix = check_trace_format(local_trace)
                print(f"  Trace: {local_trace}")
                print(f"  Size: {size:,} bytes | Format: {fmt}")

                if needs_fix and do_fix:
                    # Use a descriptive name based on the test slug
                    fixed_name = f"{slug}.zip"
                    fixed_path = fixed_dir / fixed_name
                    if fix_trace(local_trace, fixed_path):
                        print(f"  ✓ Fixed: {fixed_path}")
                        print(f"  → npx pwtrace show {fixed_path}")
                    else:
                        print(f"  ✗ Failed to fix trace")
                elif needs_fix:
                    print(f"  ⚠ Needs --fix to work with pwtrace")
                else:
                    print(f"  → npx pwtrace show {local_trace}")

    if traces_found == 0:
        print("\nNo traces found for failed tests.")
    elif do_fix:
        print(f"\n{'='*70}")
        print(f"Fixed {traces_found} trace(s) in: {fixed_dir}")


if __name__ == "__main__":
    main()
