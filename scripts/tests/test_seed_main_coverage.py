"""Tests for scripts/seed-main-coverage.sh.

This script is the ONLY path that puts coverage on the Codecov dashboard, so a
green run has to mean "the dashboard was updated". The way that quietly stops
being true is a run that reports success while uploading nothing — which is what
this suite pins down.

Uploads are driven through a stub Codecov CLI, so the tests are hermetic: no
network, and no dependence on a real token or on a shared /tmp binary.
"""

from tests.shell_harness import (
    FAKE_SHA,
    SEED_SCRIPT,
    call_count,
    run_script,
    write_stub_cli,
)

SNAPSHOT_DIR = SEED_SCRIPT.parent.parent / "coverage-snapshots"


def committed_workspaces():
    """Workspaces the seed would upload — one per committed snapshot."""
    return sorted(p.stem for p in SNAPSHOT_DIR.glob("*.lcov"))


def seed(tmp_path, exit_codes=(0,), token="fake-token", **extra):
    """Run seed-main-coverage.sh against a stub Codecov CLI."""
    stub = write_stub_cli(tmp_path / "codecov", list(exit_codes))
    env = {"CODECOV_BIN": str(stub), "GITHUB_SHA": FAKE_SHA}
    if token is not None:
        env["CODECOV_TOKEN"] = token
    env.update(extra)
    return run_script(SEED_SCRIPT, env=env), stub


class TestTokenGuard:
    def test_missing_token_fails_fast_without_uploading(self, tmp_path):
        """A tokenless run would upload nothing — that must be red, not green."""
        result, stub = seed(tmp_path, token=None)
        assert result.returncode == 1
        assert "no Codecov token" in result.stderr
        assert call_count(stub) == 0


class TestSeedOutcome:
    def test_all_uploads_succeed(self, tmp_path):
        expected = len(committed_workspaces())
        result, stub = seed(tmp_path, exit_codes=(0,))
        assert result.returncode == 0
        assert f"Done: {expected}/{expected} seeded" in result.stdout
        assert call_count(stub) == expected

    def test_one_failed_workspace_fails_the_run_and_is_named(self, tmp_path):
        """6/7 green would strand the 7th behind a stale carried-forward number,
        which is exactly the silent staleness this job exists to prevent."""
        target = committed_workspaces()[0]
        stub = tmp_path / "codecov"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            f'echo "$*" >> "{stub}.calls"\n'
            f'[[ "$*" == *"e2e-{target}"* ]] && exit 1\n'
            "exit 0\n"
        )
        stub.chmod(0o755)
        result = run_script(
            SEED_SCRIPT,
            env={
                "CODECOV_BIN": str(stub),
                "CODECOV_TOKEN": "fake-token",
                "GITHUB_SHA": FAKE_SHA,
            },
        )
        assert result.returncode == 1
        assert target in result.stderr
        assert "Not seeded" in result.stderr

    def test_every_workspace_is_uploaded_under_its_own_flag(self, tmp_path):
        result, stub = seed(tmp_path, exit_codes=(0,))
        assert result.returncode == 0
        args = (tmp_path / "codecov.calls").read_text()
        for ws in committed_workspaces():
            assert f"--flag e2e-{ws}" in args

    def test_strict_is_passed_through_to_every_upload(self, tmp_path):
        """Without strict the child returns 0 on a failed upload, and the seed
        reports every snapshot as seeded while Codecov received nothing."""
        stub = write_stub_cli(tmp_path / "codecov", [1])
        result = run_script(
            SEED_SCRIPT,
            env={
                "CODECOV_BIN": str(stub),
                "CODECOV_TOKEN": "fake-token",
                "GITHUB_SHA": FAKE_SHA,
                "UPLOAD_RETRY_DELAY_SECONDS": "0",
            },
        )
        assert result.returncode == 1, "a Codecov-side failure must fail the seed"


class TestOrphanedSnapshot:
    def test_snapshot_without_a_workspace_fails_before_uploading(self, tmp_path):
        """A snapshot left behind by a renamed workspace would fail its upload on
        every run, turning the scheduled job permanently red with the cause
        buried in one workspace's log. It should fail once, up front, naming the
        fix.

        The snapshot is created in the real directory because the script derives
        it from its own location; it is removed again in teardown.
        """
        orphan = SNAPSHOT_DIR / "no-such-workspace-xyz.lcov"
        orphan.write_text("TN:\nend_of_record\n")
        try:
            stub = write_stub_cli(tmp_path / "codecov", [0])
            result = run_script(
                SEED_SCRIPT,
                env={
                    "CODECOV_BIN": str(stub),
                    "CODECOV_TOKEN": "fake-token",
                    "GITHUB_SHA": FAKE_SHA,
                },
            )
            assert result.returncode == 1
            assert "no-such-workspace-xyz" in result.stderr
            assert call_count(stub) == 0, "nothing should upload while a snapshot is orphaned"
        finally:
            orphan.unlink()
