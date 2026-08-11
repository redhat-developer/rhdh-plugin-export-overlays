"""Tests for scripts/upload-coverage-upstream.sh.

The contract under test is what reaches the Codecov CLI: which slug, which SHAs,
which branch, which flag, which session name, and from which working directory.
Those are exactly the things that are silently wrong in a cross-repo upload — an
upload with a bad slug, a bad branch or a bad CWD is still accepted by the API
and simply never displays.

Every run is hermetic. UPSTREAM_CHECKOUT_DIR stands in for the shallow clone and
REMAP_BIN for the remap, so nothing reaches GitHub, Codecov or npm. The one
exception is documented on the test that needs it.
"""

import json
import os
from pathlib import Path

import pytest

from tests.shell_harness import (
    SCRIPTS_DIR,
    call_count,
    git,
    link_script,
    run_script,
    write_stub_cli,
)

PINNED_REF = "a" * 40
WORKSPACE = "intelligent-assistant"
UPSTREAM_SLUG = "redhat-developer/rhdh-plugins"

# Symlinked into the fixture so the script finds its own helpers next to it.
LINKED_SCRIPTS = (
    "upload-coverage-upstream.sh",
    "download-coverage-json.sh",
    "remap-lcov.sh",
    "remap-coverage.cjs",
    "upstream-paths.cjs",
    "ensure-codecov-cli.sh",
)


def build_overlay(tmp_path: Path, repo_url=f"https://github.com/{UPSTREAM_SLUG}"):
    """An overlay checkout with one workspace and its source.json.

    The script derives its repo root from its own location, so linking it into
    <root>/scripts/ relocates every path it reads.
    """
    root = tmp_path / "overlay"
    for name in LINKED_SCRIPTS:
        link_script(root, name)

    ws = root / "workspaces" / WORKSPACE
    ws.mkdir(parents=True)
    (ws / "source.json").write_text(
        json.dumps({"repo": repo_url, "repo-ref": PINNED_REF})
    )
    return root


def build_upstream_checkout(tmp_path: Path, branch="main", head_sha=None) -> Path:
    """A stand-in for the shallow clone, with a real git remote behind it.

    `git ls-remote --symref origin HEAD` is how the script learns both the
    default branch name and its tip, so origin points at a local repo: the
    resolution stays real without a network.
    """
    upstream = tmp_path / "upstream-origin"
    upstream.mkdir()
    git(upstream, "init", "-q", "-b", branch, ".")
    src = upstream / "workspaces" / WORKSPACE / "plugins" / "ia" / "src"
    src.mkdir(parents=True)
    (src / "Chat.tsx").write_text("export const a = 1;\n")
    git(upstream, "add", "-A")
    git(upstream, "commit", "-q", "-m", "seed")

    checkout = tmp_path / "checkout"
    checkout.mkdir()
    git(checkout, "init", "-q", ".")
    git(checkout, "remote", "add", "origin", str(upstream))
    return checkout


def upstream_head(checkout: Path) -> str:
    """The SHA `ls-remote` will report for the checkout's origin."""
    result = git(checkout, "ls-remote", "origin", "HEAD")
    return result.stdout.split()[0]


def write_stub_remap(path: Path) -> Path:
    """A remap that records its arguments and writes a well-formed lcov.

    The real remap-lcov.sh npm-installs four istanbul packages per run. That
    belongs in a test of the remap itself; these tests are about what the upload
    does with whatever the remap produced — and about the arguments it hands
    over, which is why they are recorded.
    """
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f'echo "$*" >> "{path}.args"\n'
        'mkdir -p "$2"\n'
        'printf "TN:\\nSF:workspaces/x/src/a.ts\\nDA:1,1\\nend_of_record\\n" > "$2/lcov.info"\n'
    )
    path.chmod(0o755)
    return path


def recorded(stub: Path, suffix: str) -> str:
    sidecar = Path(f"{stub}{suffix}")
    return sidecar.read_text() if sidecar.exists() else ""


@pytest.fixture
def coverage_dir(tmp_path: Path) -> Path:
    """A non-empty coverage directory.

    Only its non-emptiness matters: the remap is stubbed, so nothing parses the
    contents.
    """
    d = tmp_path / "coverage-json"
    d.mkdir()
    (d / "out.json").write_text("{}")
    return d


def run_upstream(
    tmp_path: Path,
    coverage_source,
    *flags,
    exit_codes=(0,),
    branch="main",
    repo_url=f"https://github.com/{UPSTREAM_SLUG}",
    workspace=WORKSPACE,
    env=None,
):
    """Drive the script against stubs, returning (result, stub_cli, checkout).

    Collapses the four-part fixture setup every test needs; the sibling suites
    (test_upload_coverage.py, test_seed_main_coverage.py) use the same shape.
    """
    root = build_overlay(tmp_path, repo_url=repo_url)
    checkout = build_upstream_checkout(tmp_path, branch=branch)
    stub = write_stub_cli(tmp_path / "codecov", list(exit_codes))
    remap = write_stub_remap(tmp_path / "remap.sh")

    base = {
        "CODECOV_BIN": str(stub),
        "UPSTREAM_CHECKOUT_DIR": str(checkout),
        "REMAP_BIN": str(remap),
        "CODECOV_RHDH_PLUGINS_TOKEN": "test-token",
    }
    base.update(env or {})

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        workspace,
        str(coverage_source),
        *flags,
        env=base,
        cwd=root,
    )
    return result, stub, checkout, remap


class TestInputValidation:
    def test_rejects_unknown_workspace(self, tmp_path, coverage_dir):
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            "nope",
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "unknown workspace" in result.stderr

    def test_rejects_a_name_that_would_forge_a_flag(self, tmp_path, coverage_dir):
        """A bad name becomes a ghost e2e-<typo> flag carryforward keeps alive."""
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            "../evil",
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "invalid workspace name" in result.stderr

    def test_rejects_a_source_that_is_neither_url_nor_directory(self, tmp_path):
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(tmp_path / "absent"),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "neither a URL nor a directory" in result.stderr

    def test_rejects_unknown_argument(self, tmp_path, coverage_dir):
        """A typo'd --dry-run must not silently become a real upload."""
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            "--dryrun",
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "unknown argument" in result.stderr

    def test_rejects_non_sha_repo_ref(self, tmp_path, coverage_dir):
        """Codecov needs a commit that exists on GitHub; a branch name produces
        an upload attributed to nothing."""
        root = build_overlay(tmp_path)
        (root / "workspaces" / WORKSPACE / "source.json").write_text(
            json.dumps(
                {"repo": f"https://github.com/{UPSTREAM_SLUG}", "repo-ref": "main"}
            )
        )
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "not a 40-char SHA" in result.stderr

    def test_reports_a_source_json_missing_its_fields(self, tmp_path, coverage_dir):
        root = build_overlay(tmp_path)
        (root / "workspaces" / WORKSPACE / "source.json").write_text(json.dumps({}))
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "no 'repo' / 'repo-ref'" in result.stderr

    def test_requires_token_unless_dry_run(self, tmp_path, coverage_dir):
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={},
            cwd=root,
        )
        assert result.returncode == 1
        assert "CODECOV_RHDH_PLUGINS_TOKEN" in result.stderr


class TestEligibility:
    def test_skips_a_repo_without_a_codecov_project(self, tmp_path, coverage_dir):
        """Not an error: most workspaces have nowhere upstream to publish."""
        result, stub, _, _ = run_upstream(
            tmp_path, coverage_dir, repo_url="https://github.com/someone/elsewhere"
        )
        assert result.returncode == 0
        assert "[SKIP]" in result.stdout
        assert call_count(stub) == 0

    @pytest.mark.parametrize(
        "repo_url",
        [
            f"https://github.com/{UPSTREAM_SLUG}",
            f"https://github.com/{UPSTREAM_SLUG}.git",
            f"https://github.com/{UPSTREAM_SLUG}/",
            f"git@github.com:{UPSTREAM_SLUG}.git",
        ],
        ids=["plain", "dot-git", "trailing-slash", "ssh"],
    )
    def test_derives_the_slug_from_every_url_form(
        self, tmp_path, coverage_dir, repo_url
    ):
        """Eligibility is exact string equality, so a URL form the derivation
        mishandles degrades to a silent [SKIP] and exit 0 — an invisible
        failure rather than a loud one."""
        result, stub, _, _ = run_upstream(tmp_path, coverage_dir, repo_url=repo_url)

        assert result.returncode == 0, result.stderr
        assert "[SKIP]" not in result.stdout
        assert f"--slug {UPSTREAM_SLUG}" in recorded(stub, ".calls")


class TestUploadContract:
    def test_uploads_to_both_the_pinned_ref_and_the_branch_tip(
        self, tmp_path, coverage_dir
    ):
        """The dual attribution: exact on the pinned ref, visible on the tip."""
        result, stub, checkout, _ = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 2
        calls = recorded(stub, ".calls")
        assert f"--slug {UPSTREAM_SLUG}" in calls
        assert f"--flag e2e-{WORKSPACE}" in calls
        assert f"--sha {PINNED_REF}" in calls
        # The second SHA is the real tip, not merely "some other 40 chars".
        assert f"--sha {upstream_head(checkout)}" in calls

    def test_uploads_run_from_inside_the_upstream_checkout(
        self, tmp_path, coverage_dir
    ):
        """The load-bearing constraint: the Codecov CLI builds the file network
        it sends from the git repo in the CWD. Uploading from the overlay
        checkout is accepted and then reported as REPORT_EMPTY, so the CWD is
        part of the contract, not an implementation detail."""
        result, stub, checkout, _ = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        cwds = [
            Path(line).resolve()
            for line in recorded(stub, ".cwds").splitlines()
            if line.strip()
        ]
        # Both uploads, both from the checkout — a length check as well as a
        # set check, so this cannot pass when only one upload ran.
        assert len(cwds) == 2
        assert set(cwds) == {checkout.resolve()}

    def test_branch_is_derived_not_assumed(self, tmp_path, coverage_dir):
        """--branch decides which branch's trend the report joins. Hardcoding
        "main" while resolving the tip of whatever HEAD points at would attach
        the report to a branch that may not exist."""
        result, stub, _, _ = run_upstream(tmp_path, coverage_dir, branch="trunk")

        assert result.returncode == 0, result.stderr
        calls = recorded(stub, ".calls")
        assert "--branch trunk" in calls
        assert "--branch main" not in calls

    def test_passes_the_checkout_and_workspace_to_the_remap(
        self, tmp_path, coverage_dir
    ):
        """The remap resolves report paths against this checkout. Handing it the
        wrong root or the slug instead of the workspace produces a report that
        uploads cleanly and attributes to nothing."""
        result, _, checkout, remap = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        args = recorded(remap, ".args")
        assert f"--upstream-root {checkout.resolve()}" in args
        assert f"--upstream-workspace {WORKSPACE}" in args
        assert str(coverage_dir) in args

    def test_the_session_name_follows_the_report_content(
        self, tmp_path, coverage_dir
    ):
        """Codecov treats a matching --name on the same commit as a replacement
        for that session. Deriving it from the report digest is what makes a
        retry idempotent while keeping two different measurements apart."""
        first, stub, _, _ = run_upstream(tmp_path, coverage_dir)
        assert first.returncode == 0, first.stderr

        names = {
            part.split()[0]
            for line in recorded(stub, ".calls").splitlines()
            for part in [line.split("--name ", 1)[1]]
        }
        assert len(names) == 1
        name = names.pop()
        assert name.startswith(f"overlay-e2e-{WORKSPACE}-")
        # Both uploads of one report share a name; the digest is the tail.
        digest = name.rsplit("-", 1)[1]
        assert len(digest) == 8
        assert all(c in "0123456789abcdef" for c in digest)


class TestTargetSelection:
    def test_pinned_only_skips_the_one_way_door(self, tmp_path, coverage_dir):
        """The tip copy cannot be taken back — once the flag is there,
        carryforward keeps it on every later commit and removal needs Codecov UI
        access. --pinned-only stages a first real run without that."""
        result, stub, _, _ = run_upstream(tmp_path, coverage_dir, "--pinned-only")

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 1
        calls = recorded(stub, ".calls")
        assert f"--sha {PINNED_REF}" in calls
        assert calls.count("--sha ") == 1

    def test_a_pinned_ref_that_is_already_the_tip_uploads_once_without_warning(
        self, tmp_path, coverage_dir
    ):
        """The normal state right after update-plugins-repo-refs bumps a
        workspace. One upload covers both roles; claiming the tip could not be
        resolved would be false, and would send a reader looking for a fault
        that is not there."""
        root = build_overlay(tmp_path)
        checkout = build_upstream_checkout(tmp_path)
        head = upstream_head(checkout)
        (root / "workspaces" / WORKSPACE / "source.json").write_text(
            json.dumps({"repo": f"https://github.com/{UPSTREAM_SLUG}", "repo-ref": head})
        )
        stub = write_stub_cli(tmp_path / "codecov", [0])
        remap = write_stub_remap(tmp_path / "remap.sh")

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={
                "CODECOV_BIN": str(stub),
                "UPSTREAM_CHECKOUT_DIR": str(checkout),
                "REMAP_BIN": str(remap),
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            },
            cwd=root,
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 1
        assert "[WARN]" not in result.stderr
        assert "will not be visible" not in result.stderr


class TestFailureHandling:
    def test_a_failed_upload_is_a_failed_run(self, tmp_path, coverage_dir):
        """Without this the job goes green while Codecov received nothing."""
        result, _, _, _ = run_upstream(
            tmp_path, coverage_dir, exit_codes=(1,), env={"UPLOAD_RETRY_DELAY_SECONDS": "0"}
        )

        assert result.returncode == 1
        assert "upload(s) failed" in result.stderr

    def test_a_target_that_exhausts_its_retries_does_not_skip_the_next(
        self, tmp_path, coverage_dir
    ):
        """Each SHA is an independent target. Abandoning the tip copy because the
        pinned-ref copy failed would lose the only one anyone sees — and the run
        must still end red, naming how many of how many failed."""
        # Both attempts on the pinned ref fail; the tip upload then succeeds.
        result, stub, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            exit_codes=(1, 1, 0),
            env={"UPLOAD_RETRY_DELAY_SECONDS": "0"},
        )

        assert result.returncode == 1
        # 2 attempts on the first target + 1 on the second: the second was tried.
        assert call_count(stub) == 3
        assert "1 of 2 upload(s) failed" in result.stderr

    def test_an_interrupted_retry_sleep_does_not_abandon_the_next_target(
        self, tmp_path, coverage_dir
    ):
        """A signalled `sleep` exits non-zero, and under `set -e` that would
        abort the loop — losing the remaining target on nothing more than a
        stray signal. upload-coverage.sh guards the same line for the same
        reason; here the blast radius is larger because there are two targets.

        A `sleep` shim that exits non-zero reproduces the signal case exactly.
        """
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "sleep"
        shim.write_text("#!/usr/bin/env bash\nexit 1\n")
        shim.chmod(0o755)

        result, stub, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            exit_codes=(1, 1, 0),
            env={
                "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
                "UPLOAD_RETRY_DELAY_SECONDS": "0",
            },
        )

        # Without the guard the run dies during the first retry's sleep, so the
        # second target is never attempted and the count stops at 1.
        assert call_count(stub) == 3
        assert result.returncode == 1
        assert "1 of 2 upload(s) failed" in result.stderr

    def test_a_transient_failure_is_retried(self, tmp_path, coverage_dir):
        """Matches upload-coverage.sh: a 5xx or DNS blip should not need a
        human to re-dispatch the job."""
        result, stub, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            "--pinned-only",
            exit_codes=(1, 0),
            env={"UPLOAD_RETRY_DELAY_SECONDS": "0"},
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 2

    def test_a_remap_that_writes_nothing_is_an_error(self, tmp_path, coverage_dir):
        """An empty report would upload cleanly and publish nothing."""
        root = build_overlay(tmp_path)
        checkout = build_upstream_checkout(tmp_path)
        stub = write_stub_cli(tmp_path / "codecov", [0])
        silent = tmp_path / "silent-remap.sh"
        silent.write_text("#!/usr/bin/env bash\nmkdir -p \"$2\"\nexit 0\n")
        silent.chmod(0o755)

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={
                "CODECOV_BIN": str(stub),
                "UPSTREAM_CHECKOUT_DIR": str(checkout),
                "REMAP_BIN": str(silent),
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            },
            cwd=root,
        )

        assert result.returncode == 1
        assert "remap produced no lcov" in result.stderr
        assert call_count(stub) == 0

    def test_an_unreachable_origin_reports_gits_own_error(self, tmp_path, coverage_dir):
        """"could not resolve the default branch" alone never says whether it
        was auth, DNS or a deleted repo, so git's message is kept."""
        root = build_overlay(tmp_path)
        checkout = tmp_path / "checkout"
        checkout.mkdir()
        git(checkout, "init", "-q", ".")
        git(checkout, "remote", "add", "origin", str(tmp_path / "does-not-exist"))
        stub = write_stub_cli(tmp_path / "codecov", [0])

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={
                "CODECOV_BIN": str(stub),
                "UPSTREAM_CHECKOUT_DIR": str(checkout),
                "REMAP_BIN": str(write_stub_remap(tmp_path / "remap.sh")),
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            },
            cwd=root,
        )

        assert result.returncode == 1
        assert "could not query" in result.stderr
        assert "does-not-exist" in result.stderr
        assert call_count(stub) == 0


class TestNoCoverage:
    def test_an_empty_coverage_dir_is_not_a_failure(self, tmp_path):
        """A backend-only or uninstrumented e2e legitimately produces no
        coverage. Turning that into a red job punishes a run that did nothing
        wrong."""
        empty = tmp_path / "no-coverage"
        empty.mkdir()
        result, stub, _, _ = run_upstream(tmp_path, empty)

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 0
        assert "nothing to publish upstream" in result.stdout

    def test_no_coverage_exits_before_cloning(self, tmp_path):
        """The empty check has to come first: cloning a large monorepo and then
        discovering there was nothing to publish is pure waste.

        This is the only test that can pin the order, because it deliberately
        omits UPSTREAM_CHECKOUT_DIR — the seam every other test uses to skip the
        clone. A `git` shim on PATH keeps it hermetic: if the ordering
        regresses, the clone runs and fails loudly instead of reaching GitHub.
        """
        root = build_overlay(tmp_path)
        empty = tmp_path / "no-coverage"
        empty.mkdir()
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "git"
        shim.write_text(
            "#!/usr/bin/env bash\n"
            'echo "git was called: $*" >&2\n'
            "exit 97\n"
        )
        shim.chmod(0o755)

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(empty),
            env={
                "PATH": f"{bin_dir}:/usr/bin:/bin",
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            },
            cwd=root,
        )

        assert result.returncode == 0, result.stderr
        assert "nothing to publish upstream" in result.stdout
        assert "git was called" not in result.stderr


class TestDryRun:
    def test_dry_run_uploads_nothing_and_previews_the_arguments(
        self, tmp_path, coverage_dir
    ):
        """The preview is the whole value of a dry run — it is what a reviewer
        checks before authorising a real publish to a shared project."""
        result, stub, checkout, _ = run_upstream(
            tmp_path, coverage_dir, "--dry-run", env={"CODECOV_RHDH_PLUGINS_TOKEN": ""}
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 0
        assert "[DRY-RUN]" in result.stdout
        assert f"--slug {UPSTREAM_SLUG}" in result.stdout
        assert f"--sha {PINNED_REF}" in result.stdout
        assert f"--sha {upstream_head(checkout)}" in result.stdout
        assert f"--flag e2e-{WORKSPACE}" in result.stdout
        assert "--branch main" in result.stdout

    def test_dry_run_needs_no_token(self, tmp_path, coverage_dir):
        """So the remap can be exercised by anyone, including CI without the
        upstream project's secret."""
        result, _, _, _ = run_upstream(
            tmp_path, coverage_dir, "--dry-run", env={"CODECOV_RHDH_PLUGINS_TOKEN": ""}
        )
        assert result.returncode == 0, result.stderr

    def test_dry_run_composes_with_pinned_only(self, tmp_path, coverage_dir):
        """The documented first step of a staged rollout is both flags at once,
        so the pair has to preview exactly one target and upload nothing."""
        result, stub, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            "--dry-run",
            "--pinned-only",
            env={"CODECOV_RHDH_PLUGINS_TOKEN": ""},
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 0
        assert result.stdout.count("[DRY-RUN] would upload") == 1
        assert f"--sha {PINNED_REF}" in result.stdout


def test_a_caller_supplied_checkout_survives_the_run(tmp_path, coverage_dir):
    """The cleanup trap removes the script's own temp dir. Deleting a checkout
    the caller handed in — or a test fixture — is not its to delete."""
    result, _, checkout, _ = run_upstream(tmp_path, coverage_dir)

    assert result.returncode == 0, result.stderr
    assert checkout.exists()
    assert (checkout / ".git").exists()
