"""Tests for scripts/upload-coverage-upstream.sh.

The contract under test is what reaches the Codecov CLI: which slug, which
SHAs, which flag, and from which working directory. Those are exactly the four
things that are silently wrong in a cross-repo upload — an upload with a bad
slug or a bad CWD is still accepted by the API and simply never displays.

Every run is hermetic: UPSTREAM_CLONE_DIR stands in for the shallow clone so no
test reaches GitHub, and CODECOV_BIN points at a stub so none reaches Codecov.
"""

import json
from pathlib import Path

import pytest

from tests.shell_harness import (
    SCRIPTS_DIR,
    call_count,
    git,
    run_script,
    write_stub_cli,
)

UPSTREAM_SCRIPT = SCRIPTS_DIR / "upload-coverage-upstream.sh"

PINNED_REF = "a" * 40
WORKSPACE = "intelligent-assistant"
UPSTREAM_SLUG = "redhat-developer/rhdh-plugins"


def build_overlay(tmp_path: Path, repo_url=f"https://github.com/{UPSTREAM_SLUG}"):
    """An overlay checkout with one workspace and its source.json.

    The script derives its repo root from its own location, so symlinking it
    into <root>/scripts/ relocates every path it reads.
    """
    root = tmp_path / "overlay"
    (root / "scripts").mkdir(parents=True)
    for name in (
        "upload-coverage-upstream.sh",
        "remap-lcov.sh",
        "remap-coverage.cjs",
        "ensure-codecov-cli.sh",
    ):
        (root / "scripts" / name).symlink_to(SCRIPTS_DIR / name)

    ws = root / "workspaces" / WORKSPACE
    ws.mkdir(parents=True)
    (ws / "source.json").write_text(
        json.dumps({"repo": repo_url, "repo-ref": PINNED_REF})
    )
    return root


def build_upstream_clone(tmp_path: Path, branch: str = "main") -> Path:
    """A stand-in for the shallow clone, with a git remote the script can read.

    `git ls-remote origin HEAD` is how the script finds main's HEAD; pointing
    origin at a local repo keeps that resolution real without a network.
    """
    upstream = tmp_path / "upstream-origin"
    upstream.mkdir()
    git(upstream, "init", "-q", "-b", branch, ".")
    (upstream / "workspaces").mkdir()
    src = upstream / "workspaces" / WORKSPACE / "plugins" / "ia" / "src"
    src.mkdir(parents=True)
    (src / "Chat.tsx").write_text("export const a = 1;\n")
    git(upstream, "add", "-A")
    git(upstream, "commit", "-q", "-m", "seed")

    clone = tmp_path / "clone"
    clone.mkdir()
    git(clone, "init", "-q", ".")
    git(clone, "remote", "add", "origin", str(upstream))
    return clone


def write_stub_remap(path: Path) -> Path:
    """A remap that writes a well-formed lcov without npm-installing istanbul.

    The real remap-lcov.sh installs four istanbul packages per run. That belongs
    in a test of the remap itself, against a fixture; these tests are about what
    the upload does with whatever the remap produced.
    """
    path.write_text(
        "#!/usr/bin/env bash\n"
        'set -euo pipefail\n'
        'mkdir -p "$2"\n'
        'printf "TN:\\nSF:workspaces/x/src/a.ts\\nDA:1,1\\nend_of_record\\n" > "$2/lcov.info"\n'
    )
    path.chmod(0o755)
    return path


def base_env(stub: Path, clone: Path, remap: Path, **extra):
    env = {
        "CODECOV_BIN": str(stub),
        "UPSTREAM_CLONE_DIR": str(clone),
        "REMAP_BIN": str(remap),
        "CODECOV_UPSTREAM_TOKEN": "test-token",
    }
    env.update(extra)
    return env


@pytest.fixture
def coverage_dir(tmp_path: Path) -> Path:
    """A directory that exists — the remap is what consumes it.

    Tests that stop before the remap only need the directory to be present;
    those that get past it are marked and skipped when node/npm is unavailable.
    """
    d = tmp_path / "coverage-json"
    d.mkdir()
    (d / "out.json").write_text("{}")
    return d


def test_rejects_unknown_workspace(tmp_path, coverage_dir):
    root = build_overlay(tmp_path)
    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        "nope",
        str(coverage_dir),
        env={"CODECOV_UPSTREAM_TOKEN": "t"},
        cwd=root,
    )
    assert result.returncode == 1
    assert "unknown workspace" in result.stderr


def test_rejects_workspace_name_that_would_forge_a_flag(tmp_path, coverage_dir):
    """A bad name becomes a ghost e2e-<typo> flag carryforward keeps alive."""
    root = build_overlay(tmp_path)
    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        "../evil",
        str(coverage_dir),
        env={"CODECOV_UPSTREAM_TOKEN": "t"},
        cwd=root,
    )
    assert result.returncode == 1
    assert "invalid workspace name" in result.stderr


def test_skips_repo_without_a_codecov_project(tmp_path, coverage_dir):
    """Not an error: most workspaces have nowhere upstream to publish."""
    root = build_overlay(tmp_path, repo_url="https://github.com/someone/elsewhere")
    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        env={"CODECOV_UPSTREAM_TOKEN": "t"},
        cwd=root,
    )
    assert result.returncode == 0
    assert "[SKIP]" in result.stdout
    assert "someone/elsewhere" in result.stdout


def test_requires_token_unless_dry_run(tmp_path, coverage_dir):
    root = build_overlay(tmp_path)
    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        env={},
        cwd=root,
    )
    assert result.returncode == 1
    assert "CODECOV_UPSTREAM_TOKEN" in result.stderr


def test_rejects_non_sha_repo_ref(tmp_path, coverage_dir):
    """Codecov needs a commit that exists on GitHub; a branch name silently
    produces an upload attributed to nothing."""
    root = build_overlay(tmp_path)
    source = root / "workspaces" / WORKSPACE / "source.json"
    source.write_text(
        json.dumps({"repo": f"https://github.com/{UPSTREAM_SLUG}", "repo-ref": "main"})
    )
    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        env={"CODECOV_UPSTREAM_TOKEN": "t"},
        cwd=root,
    )
    assert result.returncode == 1
    assert "not a 40-char SHA" in result.stderr


def test_rejects_a_source_that_is_neither_url_nor_directory(tmp_path):
    root = build_overlay(tmp_path)
    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(tmp_path / "absent"),
        env={"CODECOV_UPSTREAM_TOKEN": "t"},
        cwd=root,
    )
    assert result.returncode == 1
    assert "neither a URL nor a directory" in result.stderr


def test_an_empty_coverage_dir_is_not_a_failure(tmp_path):
    """A backend-only or uninstrumented e2e legitimately produces no coverage.
    Turning that into a red job punishes a run that did nothing wrong."""
    root = build_overlay(tmp_path)
    clone = build_upstream_clone(tmp_path)
    stub = write_stub_cli(tmp_path / "codecov", [0])
    empty = tmp_path / "no-coverage"
    empty.mkdir()

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(empty),
        env=base_env(stub, clone, write_stub_remap(tmp_path / "remap.sh")),
        cwd=root,
    )

    assert result.returncode == 0, result.stderr
    assert call_count(stub) == 0
    assert "nothing to publish upstream" in result.stdout


def test_rejects_unknown_argument(tmp_path, coverage_dir):
    """A typo'd --dry-run must not silently become a real upload."""
    root = build_overlay(tmp_path)
    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        "--dryrun",
        env={"CODECOV_UPSTREAM_TOKEN": "t"},
        cwd=root,
    )
    assert result.returncode == 1
    assert "unknown argument" in result.stderr


def test_uploads_to_both_pinned_ref_and_main_head(tmp_path, coverage_dir):
    """The dual attribution: exact on the pinned ref, visible on main's HEAD."""
    root = build_overlay(tmp_path)
    clone = build_upstream_clone(tmp_path)
    stub = write_stub_cli(tmp_path / "codecov", [0])
    remap = write_stub_remap(tmp_path / "remap.sh")

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        env=base_env(stub, clone, remap),
        cwd=root,
    )

    assert result.returncode == 0, result.stderr
    assert call_count(stub) == 2
    calls = Path(f"{stub}.calls").read_text()
    assert f"--slug {UPSTREAM_SLUG}" in calls
    assert f"--sha {PINNED_REF}" in calls
    assert f"--flag e2e-{WORKSPACE}" in calls
    # Two distinct SHAs: the pinned ref and main's HEAD resolved from origin.
    shas = {line.split("--sha ")[1].split()[0] for line in calls.splitlines()}
    assert len(shas) == 2
    assert PINNED_REF in shas


def test_uploads_run_from_inside_the_upstream_clone(tmp_path, coverage_dir):
    """The load-bearing constraint: the Codecov CLI builds the file network it
    sends from the git repo in the CWD. Uploading from the overlay checkout is
    accepted and then reported as REPORT_EMPTY, so the CWD is part of the
    contract, not an implementation detail."""
    root = build_overlay(tmp_path)
    clone = build_upstream_clone(tmp_path)
    stub = tmp_path / "codecov"
    # Record the working directory each invocation ran from.
    stub.write_text(
        "#!/usr/bin/env bash\n" f'pwd >> "{stub}.cwds"\n' "exit 0\n"
    )
    stub.chmod(0o755)
    remap = write_stub_remap(tmp_path / "remap.sh")

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        env=base_env(stub, clone, remap),
        cwd=root,
    )

    assert result.returncode == 0, result.stderr
    cwds = {
        Path(line).resolve()
        for line in Path(f"{stub}.cwds").read_text().splitlines()
        if line.strip()
    }
    assert cwds == {clone.resolve()}


def test_branch_is_derived_not_assumed(tmp_path, coverage_dir):
    """--branch decides which branch's trend the report joins. Hardcoding "main"
    while resolving the tip of whatever HEAD points at would attach the report to
    a branch that may not exist, and nobody watching the real default branch
    would ever see it."""
    root = build_overlay(tmp_path)
    clone = build_upstream_clone(tmp_path, branch="trunk")
    stub = write_stub_cli(tmp_path / "codecov", [0])
    remap = write_stub_remap(tmp_path / "remap.sh")

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        env=base_env(stub, clone, remap),
        cwd=root,
    )

    assert result.returncode == 0, result.stderr
    calls = Path(f"{stub}.calls").read_text()
    assert "--branch trunk" in calls
    assert "--branch main" not in calls


def test_pinned_only_skips_the_one_way_door(tmp_path, coverage_dir):
    """The main HEAD copy cannot be taken back — once the flag is there,
    carryforward keeps it on every later commit and removal needs Codecov UI
    access. --pinned-only stages a first real run without that."""
    root = build_overlay(tmp_path)
    clone = build_upstream_clone(tmp_path)
    stub = write_stub_cli(tmp_path / "codecov", [0])
    remap = write_stub_remap(tmp_path / "remap.sh")

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        "--pinned-only",
        env=base_env(stub, clone, remap),
        cwd=root,
    )

    assert result.returncode == 0, result.stderr
    assert call_count(stub) == 1
    calls = Path(f"{stub}.calls").read_text()
    assert f"--sha {PINNED_REF}" in calls
    assert calls.count("--sha ") == 1


def test_dry_run_uploads_nothing(tmp_path, coverage_dir):
    root = build_overlay(tmp_path)
    clone = build_upstream_clone(tmp_path)
    stub = write_stub_cli(tmp_path / "codecov", [0])
    remap = write_stub_remap(tmp_path / "remap.sh")

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        "--dry-run",
        env={
            "CODECOV_BIN": str(stub),
            "UPSTREAM_CLONE_DIR": str(clone),
            "REMAP_BIN": str(remap),
        },
        cwd=root,
    )

    assert result.returncode == 0, result.stderr
    assert call_count(stub) == 0
    assert "[DRY-RUN]" in result.stdout


def test_a_failed_upload_is_a_failed_run(tmp_path, coverage_dir):
    """Without this the job goes green while Codecov received nothing."""
    root = build_overlay(tmp_path)
    clone = build_upstream_clone(tmp_path)
    stub = write_stub_cli(tmp_path / "codecov", [1])
    remap = write_stub_remap(tmp_path / "remap.sh")

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        WORKSPACE,
        str(coverage_dir),
        env=base_env(stub, clone, remap),
        cwd=root,
    )

    assert result.returncode == 1
    assert "upload(s) failed" in result.stderr
