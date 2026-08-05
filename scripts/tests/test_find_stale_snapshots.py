"""Tests for scripts/find-stale-snapshots.sh.

This decides which coverage snapshots get refreshed, so the two errors are not
symmetric. Missing a stale snapshot leaves a wrong number published on the
dashboard, where it gets believed; flagging a current one costs one redundant
refresh that no-ops. The suite pins that asymmetry, and pins the exclusion of
workspaces that cannot produce browser coverage at all — without it the job
would retry them on every run, forever.

Each case builds a throwaway git repo so the assertions do not depend on the
real repository's history, which changes under them.
"""

import os
import subprocess

import pytest

from tests.shell_harness import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "find-stale-snapshots.sh"


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def commit(repo, path, content, when):
    """Commit `content` at `path` with a fixed committer date."""
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    git(repo, "add", "-A")
    env = {"GIT_COMMITTER_DATE": when, "GIT_AUTHOR_DATE": when}
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-q", "-m", f"touch {path}"],
        check=True,
        capture_output=True,
        env={**os.environ, **env},
    )


@pytest.fixture
def repo(tmp_path):
    """A minimal repo laid out the way the script expects to find one."""
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / SCRIPT.name).symlink_to(SCRIPT)
    git(root.parent, "init", "-q", str(root))
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "t")
    return root


def add_workspace(repo, ws, *, frontend=True):
    role = "frontend-plugin" if frontend else "backend-plugin"
    (repo / "workspaces" / ws / "coverage-anchors").mkdir(parents=True, exist_ok=True)
    (repo / "workspaces" / ws / "coverage-anchors" / f"a.{ws}").write_text("")
    (repo / "workspaces" / ws / "metadata").mkdir(parents=True, exist_ok=True)
    (repo / "workspaces" / ws / "metadata" / "p.yaml").write_text(
        f"spec:\n  backstage:\n    role: {role}\n"
    )


def run(repo):
    r = subprocess.run(
        [str(repo / "scripts" / SCRIPT.name)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode == 0, r.stderr
    return set(r.stdout.split())


class TestStaleness:
    def test_workspace_changed_after_its_snapshot(self, repo):
        add_workspace(repo, "alpha")
        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", "2026-01-01T00:00:00Z")
        commit(repo, "workspaces/alpha/source.json", "{}", "2026-02-01T00:00:00Z")
        assert run(repo) == {"alpha"}

    def test_snapshot_newer_than_the_workspace_is_current(self, repo):
        add_workspace(repo, "alpha")
        commit(repo, "workspaces/alpha/source.json", "{}", "2026-01-01T00:00:00Z")
        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", "2026-02-01T00:00:00Z")
        assert run(repo) == set()

    def test_missing_snapshot_is_stale(self, repo):
        """A snapshot that never landed is the case the fork skip produces."""
        add_workspace(repo, "alpha")
        commit(repo, "workspaces/alpha/source.json", "{}", "2026-01-01T00:00:00Z")
        assert run(repo) == {"alpha"}

    def test_reports_each_stale_workspace_independently(self, repo):
        add_workspace(repo, "alpha")
        add_workspace(repo, "beta")
        commit(repo, "workspaces/alpha/source.json", "{}", "2026-01-01T00:00:00Z")
        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", "2026-02-01T00:00:00Z")
        commit(repo, "workspaces/beta/source.json", "{}", "2026-03-01T00:00:00Z")
        assert run(repo) == {"beta"}


class TestWorkspacesThatCannotProduceCoverage:
    def test_backend_only_workspace_is_never_reported(self, repo):
        """Browser coverage comes from instrumented bundles executing in the
        page. A backend-only workspace never puts one there, so refreshing it
        can only ever come back empty — every run, forever."""
        add_workspace(repo, "backendish", frontend=False)
        commit(repo, "workspaces/backendish/source.json", "{}", "2026-01-01T00:00:00Z")
        assert run(repo) == set()

    def test_a_workspace_with_any_frontend_plugin_still_counts(self, repo):
        add_workspace(repo, "mixed", frontend=False)
        (repo / "workspaces" / "mixed" / "metadata" / "front.yaml").write_text(
            "spec:\n  backstage:\n    role: frontend-plugin\n"
        )
        commit(repo, "workspaces/mixed/source.json", "{}", "2026-01-01T00:00:00Z")
        assert run(repo) == {"mixed"}


class TestScope:
    def test_workspace_without_anchors_is_ignored(self, repo):
        """No anchors means coverage was never wired up for it; that is an
        onboarding step, not a stale snapshot."""
        (repo / "workspaces" / "unwired" / "metadata").mkdir(parents=True)
        (repo / "workspaces" / "unwired" / "metadata" / "p.yaml").write_text(
            "spec:\n  backstage:\n    role: frontend-plugin\n"
        )
        commit(repo, "workspaces/unwired/source.json", "{}", "2026-01-01T00:00:00Z")
        assert run(repo) == set()

    def test_no_workspaces_at_all_is_silent(self, repo):
        commit(repo, "README.md", "x", "2026-01-01T00:00:00Z")
        assert run(repo) == set()
