"""Shared helpers for driving the repo's shell scripts from pytest.

The scripts are exercised as subprocesses rather than sourced, because their
contract with CI *is* the exit code and the stdout/stderr they emit — that is
what makes a seed run green or red. Testing the observable contract keeps these
tests honest about the behaviour the workflow depends on.

Seams keep the runs hermetic (no network, no shared /tmp state):
  CODECOV_BIN            - path to a stub standing in for the Codecov CLI
  UPSTREAM_CHECKOUT_DIR  - a local checkout instead of a shallow clone
  REMAP_BIN              - a stub instead of an npm-installing remap
  REPO_ROOT              - a fixture tree instead of the real workspaces/ (nfs-readiness)
"""

import os
import subprocess
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent

UPLOAD_SCRIPT = SCRIPTS_DIR / "upload-coverage.sh"
SEED_SCRIPT = SCRIPTS_DIR / "seed-main-coverage.sh"
NFS_SCRIPT = SCRIPTS_DIR / "nfs-readiness-report.sh"

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

    The working directory of each call is appended to a sibling `.cwds` file.
    The cross-repo upload resolves report paths against the git repo it runs
    from, so where it ran is as much part of the contract as what it was passed.
    """
    codes = " ".join(str(c) for c in exit_codes)
    path.write_text(
        "#!/usr/bin/env bash\n"
        f'CALLS="{path}.calls"\n'
        'echo "$*" >> "$CALLS"\n'
        f'pwd >> "{path}.cwds"\n'
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


# Git run from a test must not see the developer's global config or any ambient
# git state. A `commit.gpgsign = true` with a passphrase-protected key, a global
# `core.hooksPath` with a rejecting pre-commit, or an inherited GIT_DIR (which is
# what any git hook, `git rebase -x` or `git bisect run` exports) all change the
# outcome — the last one silently commits into whatever repo GIT_DIR points at
# rather than the fixture. Building the environment from scratch is the same
# guarantee run_script() gives for the shell scripts.
GIT_ENV = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def git(repo: Path, *args, when=None):
    """Run git against `repo` in a scrubbed environment.

    `when` fixes both author and committer date, which is what makes
    staleness assertions deterministic rather than dependent on how fast the
    test ran.
    """
    env = dict(GIT_ENV)
    if when is not None:
        env["GIT_AUTHOR_DATE"] = when
        env["GIT_COMMITTER_DATE"] = when
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    # Surface git's own stderr. check=True raises with only the exit status,
    # which turns "gpg failed to sign" or "pre-commit hook rejected" into a bare
    # "returned non-zero exit status 128".
    assert result.returncode == 0, f"git {' '.join(args)} failed:\n{result.stderr}"
    return result


def link_script(root: Path, name: str) -> Path:
    """Symlink one of the repo's scripts into `<root>/scripts/`.

    The scripts derive their repo root from their own location (`dirname $0`
    -> `..`), so this is what relocates everything they read and write onto the
    fixture instead of the real checkout.
    """
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    link = root / "scripts" / name
    link.symlink_to(SCRIPTS_DIR / name)
    return link


def build_fake_repo(tmp_path: Path, workspaces, extra_snapshots=()) -> Path:
    """Lay out a throwaway repo the seed will treat as its own checkout.

    Both scripts derive their repo root from their own location
    (`dirname $0` -> `..`), so symlinking them into `<tmp>/scripts/` is enough to
    relocate everything they read and write. That keeps the seed's snapshot
    globbing off the real `coverage-snapshots/`, which a test would otherwise
    have to write into — and makes the fixture set explicit instead of "whatever
    happens to be committed today".

    `extra_snapshots` creates a snapshot with no matching `workspaces/<name>/`,
    which is exactly the orphan the seed is supposed to reject.
    """
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    for name in ("seed-main-coverage.sh", "upload-coverage.sh"):
        (root / "scripts" / name).symlink_to(SCRIPTS_DIR / name)

    (root / "coverage-snapshots").mkdir()
    for ws in [*workspaces, *extra_snapshots]:
        # Minimal but well-formed lcov. Nothing under test parses it — the stub
        # CLI ignores its content and upload-coverage.sh only checks it exists.
        (root / "coverage-snapshots" / f"{ws}.lcov").write_text(
            f"TN:\nSF:workspaces/{ws}/coverage-anchors/plugin-{ws}\nend_of_record\n"
        )
    for ws in workspaces:
        (root / "workspaces" / ws).mkdir(parents=True)
    return root


def run_script(script: Path, *args, env=None, cwd=None):
    """Run one of the repo's shell scripts with a controlled environment.

    The environment is built from scratch rather than inherited so a developer's
    real CODECOV_TOKEN or a stale /tmp/codecov cannot change the outcome.
    """
    base = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        # Keep the retry fast; the delay is behaviour we assert elsewhere, not
        # something every test should pay for in wall-clock time.
        "UPLOAD_RETRY_DELAY_SECONDS": "0",
        # The upload scripts now shell out to git (init, ls-remote, checkout,
        # hash-object), so the same scrubbing GIT_ENV applies to the harness's
        # own git calls has to apply here: a developer's url.*.insteadOf,
        # core.hooksPath or init.defaultBranch would otherwise reach the script
        # under test and change its result.
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
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
