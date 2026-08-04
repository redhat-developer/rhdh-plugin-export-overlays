"""Shared helpers for driving the coverage shell scripts from pytest.

The scripts are exercised as subprocesses rather than sourced, because their
contract with CI *is* the exit code and the stdout/stderr they emit — that is
what makes a seed run green or red. Testing the observable contract keeps these
tests honest about the behaviour the workflow depends on.

Two seams keep the runs hermetic (no network, no shared /tmp state):
  CODECOV_BIN       - path to a stub standing in for the Codecov CLI
  CODECOV_API_BASE  - base URL for the skip check, pointed at a local stub server
"""

import os
import subprocess
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent

UPLOAD_SCRIPT = SCRIPTS_DIR / "upload-coverage.sh"
SEED_SCRIPT = SCRIPTS_DIR / "seed-main-coverage.sh"

# A real-looking 40-char SHA. upload-coverage.sh rejects anything else, so the
# tests must not use a short or placeholder value.
FAKE_SHA = "1" * 40


def write_stub_cli(path: Path, exit_codes) -> Path:
    """Write a stub Codecov CLI that exits with `exit_codes` on successive calls.

    Each invocation appends to a sibling `.calls` file, so a test can assert how
    many attempts were made — that is how the retry behaviour is verified rather
    than inferred from log text.

    `exit_codes` is a list; the stub uses the last entry for any call beyond the
    list, so `[1]` means "always fail" and `[1, 0]` means "fail once then work".
    """
    codes = " ".join(str(c) for c in exit_codes)
    path.write_text(
        "#!/usr/bin/env bash\n"
        f'CALLS="{path}.calls"\n'
        'echo "$*" >> "$CALLS"\n'
        f'CODES=({codes})\n'
        'n=$(wc -l < "$CALLS" | tr -d " ")\n'
        'idx=$((n - 1))\n'
        '[[ $idx -ge ${#CODES[@]} ]] && idx=$((${#CODES[@]} - 1))\n'
        'exit "${CODES[$idx]}"\n'
    )
    path.chmod(0o755)
    return path


def call_count(stub: Path) -> int:
    """How many times the stub CLI was invoked."""
    calls = Path(f"{stub}.calls")
    if not calls.exists():
        return 0
    return len([line for line in calls.read_text().splitlines() if line.strip()])


def run_script(script: Path, *args, env=None, cwd=None):
    """Run one of the coverage scripts with a controlled environment.

    The environment is built from scratch rather than inherited so a developer's
    real CODECOV_TOKEN or a stale /tmp/codecov cannot change the outcome.
    """
    base = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        # Keep the retry fast; the delay is behaviour we assert elsewhere, not
        # something every test should pay for in wall-clock time.
        "UPLOAD_RETRY_DELAY_SECONDS": "0",
    }
    base.update(env or {})
    return subprocess.run(
        [str(script), *args],
        env=base,
        cwd=str(cwd or SCRIPTS_DIR.parent),
        capture_output=True,
        text=True,
        timeout=60,
    )
