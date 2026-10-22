"""Tests for scripts/find-stale-snapshots.sh.

This decides which coverage snapshots get refreshed, and the two errors are not
symmetric. Missing a stale snapshot leaves a wrong number published on the
dashboard, where it gets believed; flagging a current one costs one redundant
refresh that no-ops. The suite pins that asymmetry, and pins the exclusions —
a workspace that cannot produce browser coverage must never be queued, or the
job retries it on every run, forever.

Each case builds a throwaway git repo through the shared harness, whose git
helper scrubs the environment. Without that the suite inherits the developer's
global config: a `commit.gpgsign` with an unusable key or a global
`core.hooksPath` fails every test, and an inherited GIT_DIR commits into
whatever repo it points at instead of the fixture.
"""

import pytest

from tests.shell_harness import SCRIPTS_DIR, git, link_script, run_script

SCRIPT = SCRIPTS_DIR / "find-stale-snapshots.sh"

# Instants, not dates. The script compares epoch seconds precisely because a
# wall-clock reading without its offset is meaningless, so the fixtures spell
# the offset out.
T_EARLY = "2026-01-01T00:00:00+00:00"
T_LATE = "2026-02-01T00:00:00+00:00"
ALPHA_SOURCE = "workspaces/alpha/source.json"


@pytest.fixture
def repo(tmp_path):
    """A minimal repo laid out the way the script expects to find one."""
    root = tmp_path / "repo"
    root.mkdir()
    git(root.parent, "init", "-q", str(root))
    link_script(root, SCRIPT.name)
    return root


def add_workspace(repo, ws, *, roles=("frontend-plugin",), metadata=True):
    (repo / "workspaces" / ws / "coverage-anchors").mkdir(parents=True, exist_ok=True)
    (repo / "workspaces" / ws / "coverage-anchors" / f"a.{ws}").write_text("")
    if metadata:
        meta = repo / "workspaces" / ws / "metadata"
        meta.mkdir(parents=True, exist_ok=True)
        for i, role in enumerate(roles):
            (meta / f"p{i}.yaml").write_text(
                f"spec:\n  backstage:\n    role: {role}\n"
            )


def commit(repo, path, content, when):
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", f"touch {path}", when=when)


def stale(repo, **env):
    """Workspaces the script reports, in order."""
    result = run_script(repo / "scripts" / SCRIPT.name, env=env, cwd=repo)
    assert result.returncode == 0, result.stderr
    return result.stdout.split()


class TestStaleness:
    def test_workspace_changed_after_its_snapshot(self, repo):
        add_workspace(repo, "alpha")
        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", T_EARLY)
        commit(repo, ALPHA_SOURCE, "{}", T_LATE)
        assert stale(repo) == ["alpha"]

    def test_snapshot_newer_than_the_workspace_is_current(self, repo):
        add_workspace(repo, "alpha")
        commit(repo, ALPHA_SOURCE, "{}", T_EARLY)
        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", T_LATE)
        assert stale(repo) == []

    def test_same_commit_is_not_stale(self, repo):
        """The per-PR refresh path lands the snapshot in the workspace's own
        commit, so equal timestamps are the normal healthy shape."""
        add_workspace(repo, "alpha")
        (repo / "coverage-snapshots").mkdir()
        (repo / "coverage-snapshots" / "alpha.lcov").write_text("TN:\n")
        commit(repo, ALPHA_SOURCE, "{}", T_EARLY)
        assert stale(repo) == []

    def test_missing_snapshot_is_stale(self, repo):
        """A snapshot that never landed is what the fork skip produces."""
        add_workspace(repo, "alpha")
        commit(repo, ALPHA_SOURCE, "{}", T_EARLY)
        assert stale(repo) == ["alpha"]

    def test_deleted_snapshot_is_stale(self, repo):
        """A deletion is itself a commit touching the path, and its date is
        newer than the workspace's — so reading history alone reports a deleted
        snapshot as current, forever. seed-main-coverage.sh tells operators to
        delete orphaned snapshots, so this is reachable on purpose."""
        add_workspace(repo, "alpha")
        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", T_EARLY)
        commit(repo, ALPHA_SOURCE, "{}", T_LATE)
        git(repo, "rm", "-q", "coverage-snapshots/alpha.lcov")
        git(repo, "commit", "-q", "-m", "drop snapshot", when="2026-03-01T00:00:00+00:00")
        assert stale(repo) == ["alpha"]

    def test_reports_every_stale_workspace(self, repo):
        add_workspace(repo, "alpha")
        add_workspace(repo, "beta")
        commit(repo, ALPHA_SOURCE, "{}", T_EARLY)
        commit(repo, "workspaces/beta/source.json", "{}", T_EARLY)
        assert sorted(stale(repo)) == ["alpha", "beta"]


class TestTimezones:
    """Commit timestamps carry each committer's own offset — this repo's history
    holds +02:00, -04:00, +05:30 and -03:00 — so comparing the rendered strings
    compares wall clocks from different zones. Both directions were wrong."""

    def test_stale_even_when_the_wall_clock_reads_earlier(self, repo):
        # workspace 01:00-04:00 = 05:00Z, snapshot 04:00Z -> snapshot is older.
        add_workspace(repo, "alpha")
        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", "2026-01-01T04:00:00+00:00")
        commit(repo, ALPHA_SOURCE, "{}", "2026-01-01T01:00:00-04:00")
        assert stale(repo) == ["alpha"]

    def test_current_even_when_the_wall_clock_reads_later(self, repo):
        # workspace 09:00+05:30 = 03:30Z, snapshot 04:00Z -> snapshot is newer.
        add_workspace(repo, "alpha")
        commit(repo, ALPHA_SOURCE, "{}", "2026-01-01T09:00:00+05:30")
        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", "2026-01-01T04:00:00+00:00")
        assert stale(repo) == []


class TestWorkspacesThatCannotProduceCoverage:
    def test_backend_only_workspace_is_never_reported(self, repo):
        """Browser coverage comes from instrumented bundles executing in the
        page. A backend-only workspace never puts one there, so refreshing it
        can only come back empty — every run, forever."""
        add_workspace(repo, "backendish", roles=("backend-plugin",))
        commit(repo, "workspaces/backendish/source.json", "{}", T_EARLY)
        assert stale(repo) == []

    def test_frontend_plugin_module_alone_does_not_count(self, repo):
        """instrument-plugin.sh instruments only an exact `frontend-plugin`
        role and SKIPS `-module`, so a substring match here would queue a
        workspace that can never come back with coverage."""
        add_workspace(repo, "moduleish", roles=("frontend-plugin-module",))
        commit(repo, "workspaces/moduleish/source.json", "{}", T_EARLY)
        assert stale(repo) == []

    def test_a_workspace_with_any_frontend_plugin_still_counts(self, repo):
        add_workspace(repo, "mixed", roles=("backend-plugin", "frontend-plugin"))
        commit(repo, "workspaces/mixed/source.json", "{}", T_EARLY)
        assert stale(repo) == ["mixed"]


class TestScope:
    def test_workspace_without_anchors_is_ignored(self, repo):
        """No anchors means coverage was never wired up — an onboarding step,
        not a stale snapshot."""
        (repo / "workspaces" / "unwired" / "metadata").mkdir(parents=True)
        (repo / "workspaces" / "unwired" / "metadata" / "p.yaml").write_text(
            "spec:\n  backstage:\n    role: frontend-plugin\n"
        )
        commit(repo, "workspaces/unwired/source.json", "{}", T_EARLY)
        assert stale(repo) == []

    def test_workspace_without_metadata_is_ignored(self, repo):
        """Pins today's behaviour rather than endorsing it: an anchored
        workspace whose metadata has not landed reads as backend-only and is
        excluded silently. Worth revisiting — the exclusion is meant for
        workspaces that cannot produce coverage, not ones mid-onboarding."""
        add_workspace(repo, "nometa", metadata=False)
        commit(repo, "workspaces/nometa/source.json", "{}", T_EARLY)
        assert stale(repo) == []

    def test_no_workspaces_at_all_is_silent(self, repo):
        """Also covers bash 3.2 (macOS /bin/bash), where expanding an empty
        array under `set -u` is an unbound-variable error."""
        commit(repo, "README.md", "x", T_EARLY)
        assert stale(repo) == []


class TestCompareRef:
    def test_an_earlier_ref_changes_the_verdict(self, repo):
        """The workflow's whole deferred-workspace fix rests on this knob: it
        measures against the accumulation branch so already-refreshed
        workspaces are not redone."""
        add_workspace(repo, "alpha")
        commit(repo, ALPHA_SOURCE, "{}", T_EARLY)
        before_snapshot = run_script(
            repo / "scripts" / SCRIPT.name, env={}, cwd=repo
        ).stdout.split()
        assert before_snapshot == ["alpha"]

        commit(repo, "coverage-snapshots/alpha.lcov", "TN:\n", T_LATE)
        assert stale(repo) == []
        assert stale(repo, STALE_COMPARE_REF="HEAD~1") == ["alpha"]

    def test_an_unresolvable_ref_fails_loudly(self, repo):
        """Silently reporting every workspace would burn the caller's whole
        refresh budget on a list produced by a typo."""
        add_workspace(repo, "alpha")
        commit(repo, ALPHA_SOURCE, "{}", T_EARLY)
        result = run_script(
            repo / "scripts" / SCRIPT.name,
            env={"STALE_COMPARE_REF": "origin/does-not-exist"},
            cwd=repo,
        )
        assert result.returncode == 1
        assert "is not a commit" in result.stderr
        assert result.stdout.strip() == ""
