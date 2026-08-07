"""Tests for scripts/seed-main-coverage.sh.

This script is the ONLY path that puts coverage on the Codecov dashboard, so a
green run has to mean "the dashboard was updated". The way that quietly stops
being true is a run that reports success while uploading nothing — which is what
this suite pins down.

Every case runs against a throwaway repo built by build_fake_repo(), never the
real checkout: the seed globs `coverage-snapshots/` and the orphan case has to
put a file there, which would otherwise mean writing into the working tree. It
also fixes the workspace set, so these assertions do not drift as snapshots are
added to the repo.

Uploads go through a stub Codecov CLI, so the tests are hermetic: no network and
no dependence on a real token.
"""

from tests.shell_harness import (
    FAKE_SHA,
    build_fake_repo,
    call_count,
    run_script,
    write_stub_cli,
)

WORKSPACES = ["alpha", "beta", "gamma"]


def seed(tmp_path, exit_codes=(0,), token="fake-token", workspaces=None, orphans=(), **extra):
    """Run seed-main-coverage.sh in a fake repo against a stub Codecov CLI."""
    repo = build_fake_repo(
        tmp_path, workspaces if workspaces is not None else WORKSPACES, orphans
    )
    stub = write_stub_cli(tmp_path / "codecov", list(exit_codes))
    env = {
        "CODECOV_BIN": str(stub),
        "GITHUB_SHA": FAKE_SHA,
        # upload-coverage.sh resolves the upload branch from git when there is no
        # PR number; the fake repo is not a git checkout, so name it explicitly.
        "PULL_BASE_REF": "main",
    }
    if token is not None:
        env["CODECOV_TOKEN"] = token
    env.update(extra)
    result = run_script(
        repo / "scripts" / "seed-main-coverage.sh", env=env, cwd=repo
    )
    return result, stub


class TestTokenGuard:
    def test_missing_token_fails_fast_without_uploading(self, tmp_path):
        """A tokenless run would upload nothing — that must be red, not green."""
        result, stub = seed(tmp_path, token=None)
        assert result.returncode == 1
        assert "no Codecov token" in result.stderr
        assert call_count(stub) == 0


class TestSeedOutcome:
    def test_all_uploads_succeed(self, tmp_path):
        result, stub = seed(tmp_path, exit_codes=(0,))
        assert result.returncode == 0
        assert f"Done: {len(WORKSPACES)}/{len(WORKSPACES)} seeded" in result.stdout
        assert call_count(stub) == len(WORKSPACES)

    def test_one_failed_workspace_fails_the_run_and_is_named(self, tmp_path):
        """2/3 green would strand the third behind a stale carried-forward
        number, which is the silent staleness this job exists to prevent."""
        target = WORKSPACES[1]
        repo = build_fake_repo(tmp_path, WORKSPACES)
        stub = tmp_path / "codecov"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            f'echo "$*" >> "{stub}.calls"\n'
            f'[[ "$*" == *"e2e-{target}"* ]] && exit 1\n'
            "exit 0\n"
        )
        stub.chmod(0o755)
        result = run_script(
            repo / "scripts" / "seed-main-coverage.sh",
            env={
                "CODECOV_BIN": str(stub),
                "CODECOV_TOKEN": "fake-token",
                "GITHUB_SHA": FAKE_SHA,
                "PULL_BASE_REF": "main",
            },
            cwd=repo,
        )
        assert result.returncode == 1
        assert target in result.stderr
        assert "Not seeded" in result.stderr
        # One bad workspace must not abort the rest: every workspace is still
        # attempted, and the failing one twice because upload-coverage.sh retries.
        calls = (tmp_path / "codecov.calls").read_text()
        for ws in WORKSPACES:
            assert f"--flag e2e-{ws}" in calls
        assert calls.count(f"--flag e2e-{target}") == 2
        assert call_count(stub) == len(WORKSPACES) + 1

    def test_every_workspace_is_uploaded_under_its_own_flag(self, tmp_path):
        """Each workspace's lcov has to reach its own flag; pairing them up wrong
        would put one workspace's coverage on another's dashboard entry."""
        result, stub = seed(tmp_path, exit_codes=(0,))
        assert result.returncode == 0
        calls = (tmp_path / "codecov.calls").read_text().splitlines()
        for ws in WORKSPACES:
            assert any(
                f"--flag e2e-{ws}" in c and f"coverage-snapshots/{ws}.lcov" in c
                for c in calls
            ), f"{ws}.lcov must be uploaded under e2e-{ws}"

    def test_strict_is_passed_through_to_every_upload(self, tmp_path):
        """Without strict the child returns 0 on a failed upload, and the seed
        reports every snapshot as seeded while Codecov received nothing."""
        result, _ = seed(tmp_path, exit_codes=(1,), UPLOAD_RETRY_DELAY_SECONDS="0")
        assert result.returncode == 1, "a Codecov-side failure must fail the seed"

    def test_no_snapshots_is_a_no_op(self, tmp_path):
        result, stub = seed(tmp_path, workspaces=[])
        assert result.returncode == 0
        assert "nothing to seed" in result.stdout
        assert call_count(stub) == 0


class TestOrphanedSnapshot:
    """A snapshot left behind by a renamed workspace has no workspace directory,
    so upload-coverage.sh would reject it on every run. It is reported up front,
    naming the file to delete, rather than surfacing as one buried per-workspace
    failure."""

    def test_healthy_workspaces_are_still_seeded(self, tmp_path):
        """The orphan is one workspace's bookkeeping problem. Aborting the run
        over it would hold every other flag at its last value until someone
        cleans up — punishing flags with nothing wrong with them."""
        result, stub = seed(tmp_path, orphans=["no-such-workspace"])
        assert call_count(stub) == len(WORKSPACES)
        calls = (tmp_path / "codecov.calls").read_text()
        for ws in WORKSPACES:
            assert f"--flag e2e-{ws}" in calls
        assert "e2e-no-such-workspace" not in calls

    def test_run_still_fails_and_names_the_orphan(self, tmp_path):
        """Seeding the rest must not make the run green: nothing was uploaded
        for the orphan either, which is the staleness this job exists to catch."""
        result, _ = seed(tmp_path, orphans=["no-such-workspace"])
        assert result.returncode == 1
        assert "no-such-workspace" in result.stderr

    def test_every_snapshot_orphaned_fails_without_uploading(self, tmp_path):
        result, stub = seed(tmp_path, workspaces=[], orphans=["gone-a", "gone-b"])
        assert result.returncode == 1
        assert "every snapshot is orphaned" in result.stderr
        assert call_count(stub) == 0
