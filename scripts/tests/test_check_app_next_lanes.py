"""Tests for scripts/check_app_next_lanes.py — does an app-next lane have anything to prove?

An ``-app-next`` Playwright project claims an OpenShift namespace to demonstrate that a
workspace works under the new frontend system. When none of the workspace's published
frontend artifacts exposes an NFS entry point there is nothing to mount, and the lane
neither proves nor disproves anything: a plugin that contributes nothing still boots
cleanly, so the suite passes against an empty page or dies much later on a missing
element. Two lane attempts were spent finding that out by hand (RHIDP-16463).

The distinction these tests exist to pin is ``blocked`` versus ``unknown``. The readiness
report only classifies artifacts when run with ``--oci``; without it every frontend
package is ``unknown``. Treating that as ``blocked`` would let the cheap invocation
condemn every lane in the repo, and treating ``blocked`` as ``unknown`` would make the
check silent exactly when it has something to say.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from check_app_next_lanes import (  # noqa: E402
    BLOCKED,
    READY,
    UNKNOWN,
    app_next_workspaces,
    evaluate,
    main,
    render,
)


def make_workspace(root: Path, name: str, projects: list[str]) -> None:
    config = root / "workspaces" / name / "e2e-tests"
    config.mkdir(parents=True, exist_ok=True)
    body = ",\n".join(f'    {{\n      name: "{p}",\n    }}' for p in projects)
    (config / "playwright.config.ts").write_text(
        f"export default defineConfig({{\n  projects: [\n{body}\n  ],\n}});\n"
    )


def pkg(workspace: str, name: str, status: str, frontend: bool = True) -> dict:
    return {
        "workspace": workspace,
        "packageName": name,
        "role": "frontend-plugin" if frontend else "backend-plugin",
        "frontend": frontend,
        "status": status,
    }


def verdict_for(verdicts, workspace):
    return next(v for v in verdicts if v.workspace == workspace)


class TestLaneDiscovery:
    def test_finds_only_projects_whose_name_ends_in_app_next(self, tmp_path):
        make_workspace(tmp_path, "acr", ["acr", "acr-app-next"])
        make_workspace(tmp_path, "rbac", ["rbac"])
        assert app_next_workspaces(tmp_path) == {"acr": ["acr-app-next"]}

    def test_finds_a_workspace_whose_only_lane_is_app_next(self, tmp_path):
        # keycloak and app-defaults replaced the legacy lane rather than adding beside it.
        make_workspace(tmp_path, "keycloak", ["keycloak-app-next"])
        assert app_next_workspaces(tmp_path) == {"keycloak": ["keycloak-app-next"]}

    def test_ignores_a_name_that_merely_contains_app_next(self, tmp_path):
        # A substring match would silently pull in lanes that are not app-next at all.
        make_workspace(tmp_path, "ws", ["ws-app-next-legacy"])
        assert app_next_workspaces(tmp_path) == {}

    def test_returns_nothing_when_no_workspace_has_a_lane(self, tmp_path):
        make_workspace(tmp_path, "ws", ["ws"])
        assert app_next_workspaces(tmp_path) == {}


class TestVerdicts:
    def test_one_nfs_ready_package_is_enough(self, tmp_path):
        make_workspace(tmp_path, "acr", ["acr-app-next"])
        rows = [
            pkg("acr", "@c/plugin-acr", "nfs-ready"),
            pkg("acr", "@c/plugin-acr-extra", "no-features"),
        ]
        v = verdict_for(evaluate(tmp_path, rows), "acr")
        assert v.verdict == READY

    def test_no_package_exposing_an_entry_point_blocks_the_lane(self, tmp_path):
        # The roadie case: every frontend package classified, none of them NFS.
        make_workspace(tmp_path, "roadie", ["roadie-app-next"])
        rows = [
            pkg("roadie", "@r/plugin-jira", "no-features"),
            pkg("roadie", "@r/plugin-datadog", "no-features"),
        ]
        v = verdict_for(evaluate(tmp_path, rows), "roadie")
        assert v.verdict == BLOCKED
        assert "none of 2" in v.reason
        assert v.packages == ["@r/plugin-datadog", "@r/plugin-jira"]

    def test_unclassified_is_not_blocked(self, tmp_path):
        # Without --oci nothing is pulled and every frontend package is "unknown".
        # Calling that blocked would condemn every lane in the repo.
        make_workspace(tmp_path, "acr", ["acr-app-next"])
        rows = [pkg("acr", "@c/plugin-acr", "unknown")]
        v = verdict_for(evaluate(tmp_path, rows), "acr")
        assert v.verdict == UNKNOWN
        assert "unclassified" in v.reason

    def test_one_unclassified_package_holds_back_a_blocked_verdict(self, tmp_path):
        # Two packages establish no NFS surface, one is unjudged — so the workspace
        # might still have one, and blocking would be a guess.
        make_workspace(tmp_path, "ws", ["ws-app-next"])
        rows = [
            pkg("ws", "@c/a", "no-features"),
            pkg("ws", "@c/b", "no-features"),
            pkg("ws", "@c/c", "unknown"),
        ]
        assert verdict_for(evaluate(tmp_path, rows), "ws").verdict == UNKNOWN

    def test_a_ready_package_wins_over_an_unclassified_sibling(self, tmp_path):
        # One artifact that demonstrably exposes an entry point is enough to justify the
        # lane; not knowing about a second does not take that away.
        make_workspace(tmp_path, "acr", ["acr-app-next"])
        rows = [
            pkg("acr", "@c/a", "unknown"),
            pkg("acr", "@c/b", "nfs-ready"),
        ]
        assert verdict_for(evaluate(tmp_path, rows), "acr").verdict == READY

    def test_backend_only_workspace_is_not_blocked(self, tmp_path):
        # keycloak ships only backend modules and still runs keycloak-app-next: that
        # lane tests the modules under an NFS shell, which is a different claim.
        make_workspace(tmp_path, "keycloak", ["keycloak-app-next"])
        rows = [pkg("keycloak", "@c/module", "backend-only", frontend=False)]
        v = verdict_for(evaluate(tmp_path, rows), "keycloak")
        assert v.verdict == READY
        assert "shell" in v.reason

    def test_a_workspace_absent_from_the_report_is_unknown_not_ready(self, tmp_path):
        # It used to share the backend-only branch, so an empty or truncated readiness
        # file passed every lane in the repo — the check failing open, silently.
        make_workspace(tmp_path, "ghost", ["ghost-app-next"])
        v = verdict_for(evaluate(tmp_path, []), "ghost")
        assert v.verdict == UNKNOWN
        assert "absent from the readiness report" in v.reason

    def test_an_empty_report_does_not_pass_a_workspace_that_ships_frontends(
        self, tmp_path
    ):
        make_workspace(tmp_path, "acr", ["acr-app-next"])
        make_workspace(tmp_path, "roadie", ["roadie-app-next"])
        assert all(v.verdict == UNKNOWN for v in evaluate(tmp_path, []))

    def test_mixed_counts_as_an_nfs_surface(self, tmp_path):
        # Some entry points NFS and some not is enough for a lane to mount something,
        # so it must not fall through to "none of them exposes an NFS entry point".
        make_workspace(tmp_path, "ws", ["ws-app-next"])
        rows = [pkg("ws", "@c/p", "mixed")]
        assert verdict_for(evaluate(tmp_path, rows), "ws").verdict == READY

    def test_an_unrecognised_status_is_unclassified_rather_than_blocked(self, tmp_path):
        # A status this check has never seen is not evidence that NFS is absent.
        make_workspace(tmp_path, "ws", ["ws-app-next"])
        rows = [pkg("ws", "@c/p", "some-future-status")]
        assert verdict_for(evaluate(tmp_path, rows), "ws").verdict == UNKNOWN

    def test_the_unclassified_message_does_not_blame_a_missing_oci_flag_alone(
        self, tmp_path
    ):
        # In CI --oci is always passed, so unknown there means the pull failed. Advice
        # to "run with --oci" would send the reader somewhere with nothing to find.
        make_workspace(tmp_path, "acr", ["acr-app-next"])
        v = verdict_for(evaluate(tmp_path, [pkg("acr", "@c/a", "unknown")]), "acr")
        assert "or the pull failed" in v.reason

    def test_another_workspace_s_packages_do_not_count(self, tmp_path):
        make_workspace(tmp_path, "roadie", ["roadie-app-next"])
        rows = [
            pkg("acr", "@c/plugin-acr", "nfs-ready"),
            pkg("roadie", "@r/plugin-jira", "no-features"),
        ]
        assert verdict_for(evaluate(tmp_path, rows), "roadie").verdict == BLOCKED


class TestOutput:
    def test_blocked_lanes_are_listed_first_and_name_the_ticket(self, tmp_path):
        make_workspace(tmp_path, "acr", ["acr-app-next"])
        make_workspace(tmp_path, "roadie", ["roadie-app-next"])
        rows = [
            pkg("acr", "@c/plugin-acr", "nfs-ready"),
            pkg("roadie", "@r/plugin-jira", "no-features"),
        ]
        text = render(evaluate(tmp_path, rows))
        assert text.index("roadie") < text.index("acr")
        assert "RHIDP-16463" in text

    def test_exit_code_is_one_only_when_a_lane_is_blocked(self, tmp_path, capsys):
        make_workspace(tmp_path, "roadie", ["roadie-app-next"])
        readiness = tmp_path / "r.json"
        readiness.write_text(json.dumps([pkg("roadie", "@r/j", "no-features")]))
        assert (
            main(["--readiness", str(readiness), "--repo-root", str(tmp_path)]) == 1
        )
        capsys.readouterr()

        readiness.write_text(json.dumps([pkg("roadie", "@r/j", "nfs-ready")]))
        assert (
            main(["--readiness", str(readiness), "--repo-root", str(tmp_path)]) == 0
        )
        capsys.readouterr()

    def test_unknown_alone_does_not_fail_the_check(self, tmp_path, capsys):
        make_workspace(tmp_path, "acr", ["acr-app-next"])
        readiness = tmp_path / "r.json"
        readiness.write_text(json.dumps([pkg("acr", "@c/a", "unknown")]))
        assert main(["--readiness", str(readiness), "--repo-root", str(tmp_path)]) == 0
        capsys.readouterr()

    def test_a_repo_with_no_lanes_says_so_and_passes(self, tmp_path, capsys):
        make_workspace(tmp_path, "ws", ["ws"])
        readiness = tmp_path / "r.json"
        readiness.write_text("[]")
        assert main(["--readiness", str(readiness), "--repo-root", str(tmp_path)]) == 0
        assert "no -app-next lanes" in capsys.readouterr().out

    def test_a_non_array_input_is_rejected_rather_than_misread(self, tmp_path, capsys):
        make_workspace(tmp_path, "ws", ["ws-app-next"])
        readiness = tmp_path / "r.json"
        readiness.write_text(json.dumps({"packages": []}))
        assert main(["--readiness", str(readiness), "--repo-root", str(tmp_path)]) == 2
        assert "JSON array" in capsys.readouterr().err


@pytest.mark.parametrize("status", ["no-features", "legacy-only"])
def test_a_status_that_establishes_no_nfs_surface_blocks(tmp_path, status):
    # These two are the report's way of saying it looked and there is nothing. Only
    # they may produce a blocked verdict; anything else is not that claim.
    make_workspace(tmp_path, "ws", ["ws-app-next"])
    rows = [pkg("ws", "@c/p", status)]
    assert verdict_for(evaluate(tmp_path, rows), "ws").verdict == BLOCKED
