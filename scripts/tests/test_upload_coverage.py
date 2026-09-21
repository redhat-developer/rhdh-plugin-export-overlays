"""Tests for scripts/upload-coverage.sh.

The script's whole job is getting a report to Codecov, so what matters is the
exit code it reports back to its caller: a 0 that did not upload anything is the
bug this suite exists to prevent. Every test therefore asserts on the exit code
first, and on log text only where the text itself is the contract (the failure
banner must not claim "non-fatal" while exiting non-zero).
"""

import pytest

from tests.shell_harness import (
    FAKE_SHA,
    UPLOAD_SCRIPT,
    call_count,
    run_script,
    write_stub_cli,
)

# Any workspace with a committed snapshot works; the script validates that
# workspaces/<name>/ exists and reads the lcov it is handed.
WORKSPACE = "tech-radar"
LCOV = f"coverage-snapshots/{WORKSPACE}.lcov"


def upload(tmp_path, exit_codes=(0,), strict=None, token="fake-token", **extra):
    """Run upload-coverage.sh against a stub CLI with the given attempt outcomes."""
    stub = write_stub_cli(tmp_path / "codecov", list(exit_codes))
    env = {"CODECOV_BIN": str(stub), "GITHUB_SHA": FAKE_SHA}
    if token is not None:
        env["CODECOV_TOKEN"] = token
    if strict is not None:
        env["CODECOV_UPLOAD_STRICT"] = strict
    env.update(extra)
    return run_script(UPLOAD_SCRIPT, WORKSPACE, LCOV, env=env), stub


class TestSuccessfulUpload:
    def test_succeeds_and_does_not_retry(self, tmp_path):
        result, stub = upload(tmp_path, exit_codes=(0,))
        assert result.returncode == 0
        assert call_count(stub) == 1, "a successful upload must not be repeated"

    def test_strict_does_not_change_the_happy_path(self, tmp_path):
        result, stub = upload(tmp_path, exit_codes=(0,), strict="true")
        assert result.returncode == 0
        assert call_count(stub) == 1


class TestRetry:
    def test_transient_failure_recovers_on_retry(self, tmp_path):
        result, stub = upload(tmp_path, exit_codes=(1, 0), strict="true")
        assert result.returncode == 0, "a blip on the first attempt must not fail the job"
        assert call_count(stub) == 2

    def test_gives_up_after_two_attempts(self, tmp_path):
        result, stub = upload(tmp_path, exit_codes=(1,), strict="true")
        assert result.returncode == 1
        assert call_count(stub) == 2, "exactly one retry — not an unbounded loop"


class TestStrictExitCodeContract:
    """Strict means 'Codecov did not receive the report', whatever the cause."""

    @pytest.mark.parametrize("strict, expected", [("true", 1), ("false", 0), (None, 0)])
    def test_failed_upload(self, tmp_path, strict, expected):
        result, _ = upload(tmp_path, exit_codes=(1,), strict=strict)
        assert result.returncode == expected

    @pytest.mark.parametrize("strict, expected", [("true", 1), ("false", 0), (None, 0)])
    def test_missing_token_uploads_nothing(self, tmp_path, strict, expected):
        """A missing token skips the upload entirely — strict must still catch it.

        This is the gap that made the contract safe only by accident of which
        caller happened to guard the token separately.
        """
        result, stub = upload(tmp_path, exit_codes=(0,), strict=strict, token=None)
        assert result.returncode == expected
        assert call_count(stub) == 0, "nothing should be uploaded without a token"


class TestStrictValueValidation:
    @pytest.mark.parametrize("value", ["1", "yes", "TRUE", "true "])
    def test_unrecognized_value_is_rejected_not_silently_ignored(self, tmp_path, value):
        """Treating STRICT=1 as non-strict would hand back the silent green the
        flag exists to prevent, and a caller that set it clearly wanted it."""
        result, stub = upload(tmp_path, exit_codes=(0,), strict=value)
        assert result.returncode == 1
        assert "must be 'true' or 'false'" in result.stderr
        assert call_count(stub) == 0

    def test_empty_value_means_unset(self, tmp_path):
        """`${VAR:-false}` treats empty as absent, which is what an unset env var
        in a workflow renders to — that has to stay non-strict, not an error."""
        result, stub = upload(tmp_path, exit_codes=(1,), strict="")
        assert result.returncode == 0
        assert call_count(stub) == 2


class TestFailureBanner:
    def test_does_not_claim_non_fatal_when_it_is_fatal(self, tmp_path):
        result, _ = upload(tmp_path, exit_codes=(1,), strict="true")
        combined = result.stdout + result.stderr
        assert "non-fatal" not in combined.lower(), (
            "under strict the run fails, so the banner must not send whoever "
            "debugs it looking for a non-fatal cause"
        )
        assert "CODECOV_UPLOAD_STRICT=true" in combined

    def test_says_non_fatal_when_it_really_is(self, tmp_path):
        result, _ = upload(tmp_path, exit_codes=(1,), strict=None)
        assert "non-fatal" in (result.stdout + result.stderr).lower()

    def test_all_failure_diagnostics_go_to_stderr(self, tmp_path):
        """Split streams let CI log capture interleave the verdict away from the
        retry notice that led to it, so both belong on the same stream."""
        result, _ = upload(tmp_path, exit_codes=(1,), strict="true")
        verdict = "Codecov upload failed (2 attempts)"
        assert verdict in result.stderr
        assert verdict not in result.stdout
        assert "retrying in" in result.stderr
        assert "retrying in" not in result.stdout


class TestInputValidation:
    def test_unknown_workspace_is_rejected(self, tmp_path):
        stub = write_stub_cli(tmp_path / "codecov", [0])
        result = run_script(
            UPLOAD_SCRIPT,
            "no-such-workspace",
            LCOV,
            env={
                "CODECOV_BIN": str(stub),
                "CODECOV_TOKEN": "fake-token",
                "GITHUB_SHA": FAKE_SHA,
            },
        )
        assert result.returncode == 1
        assert "Unknown workspace" in result.stderr
        assert call_count(stub) == 0

    def test_missing_lcov_is_rejected(self, tmp_path):
        stub = write_stub_cli(tmp_path / "codecov", [0])
        result = run_script(
            UPLOAD_SCRIPT,
            WORKSPACE,
            "coverage-snapshots/does-not-exist.lcov",
            env={
                "CODECOV_BIN": str(stub),
                "CODECOV_TOKEN": "fake-token",
                "GITHUB_SHA": FAKE_SHA,
            },
        )
        assert result.returncode == 1
        assert "No lcov file found" in result.stderr
        assert call_count(stub) == 0

    def test_rejects_a_sha_that_is_not_a_full_commit(self, tmp_path):
        """A short SHA would be accepted by the API and silently misattributed."""
        stub = write_stub_cli(tmp_path / "codecov", [0])
        result = run_script(
            UPLOAD_SCRIPT,
            WORKSPACE,
            LCOV,
            env={
                "CODECOV_BIN": str(stub),
                "CODECOV_TOKEN": "fake-token",
                "GITHUB_SHA": "abc1234",
            },
        )
        assert result.returncode == 1
        assert call_count(stub) == 0


class TestFlagAttribution:
    def test_uploads_under_the_workspace_flag(self, tmp_path):
        """The flag is how a workspace's coverage stays its own on the dashboard."""
        result, stub = upload(tmp_path, exit_codes=(0,))
        assert result.returncode == 0
        args = (tmp_path / "codecov.calls").read_text()
        assert f"--flag e2e-{WORKSPACE}" in args
        assert f"--sha {FAKE_SHA}" in args
