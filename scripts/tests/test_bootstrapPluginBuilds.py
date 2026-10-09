"""Tests for bootstrapPluginBuilds module."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from bootstrapPluginBuilds import (
    clear_fallback_markers,
    construct_registry_reference,
    get_outdated_workspaces,
    remove_stale_plugin_builds,
    versions_match_minor,
)


# ---------------------------------------------------------------------------
# versions_match_minor
# ---------------------------------------------------------------------------

class TestVersionsMatchMinor:
    def test_exact_match(self):
        assert versions_match_minor("1.49.4", "1.49.4") is True

    def test_patch_differs(self):
        assert versions_match_minor("1.49.2", "1.49.4") is True

    def test_minor_differs(self):
        assert versions_match_minor("1.48.3", "1.49.4") is False

    def test_major_differs(self):
        assert versions_match_minor("2.49.4", "1.49.4") is False

    def test_empty_first(self):
        assert versions_match_minor("", "1.49.4") is False

    def test_empty_second(self):
        assert versions_match_minor("1.49.4", "") is False

    def test_both_empty(self):
        assert versions_match_minor("", "") is False

    def test_malformed_single_segment(self):
        assert versions_match_minor("1", "1.49.4") is False

    def test_two_segments_match(self):
        assert versions_match_minor("1.49", "1.49.4") is True


# ---------------------------------------------------------------------------
# get_outdated_workspaces
# ---------------------------------------------------------------------------

class TestGetOutdatedWorkspaces:
    def _create_workspace(self, tmp_path, name, source_version=None, backstage_version=None):
        ws_dir = tmp_path / name
        metadata_dir = ws_dir / "metadata"
        metadata_dir.mkdir(parents=True)

        if source_version is not None:
            (ws_dir / "source.json").write_text(json.dumps({
                "repo": "https://github.com/example/repo",
                "repo-ref": "abc123",
                "repo-flat": False,
                "repo-backstage-version": source_version,
            }))

        if backstage_version is not None:
            (ws_dir / "backstage.json").write_text(json.dumps({
                "version": backstage_version,
            }))

        return ws_dir

    def test_matching_source_json(self, tmp_path):
        ws = self._create_workspace(tmp_path, "my-plugin", source_version="1.49.2")
        result = get_outdated_workspaces([ws], "1.49.4")
        assert result == {}

    def test_mismatching_source_json(self, tmp_path):
        ws = self._create_workspace(tmp_path, "my-plugin", source_version="1.45.3")
        result = get_outdated_workspaces([ws], "1.49.4")
        assert "my-plugin" in result
        assert result["my-plugin"]["expected"] == "1.49.4"
        assert result["my-plugin"]["found"] == "1.45.3"

    def test_backstage_json_override_matches(self, tmp_path):
        ws = self._create_workspace(
            tmp_path, "my-plugin",
            source_version="1.45.3",
            backstage_version="1.49.4",
        )
        result = get_outdated_workspaces([ws], "1.49.4")
        assert result == {}

    def test_backstage_json_override_mismatches(self, tmp_path):
        ws = self._create_workspace(
            tmp_path, "my-plugin",
            source_version="1.45.3",
            backstage_version="1.47.0",
        )
        result = get_outdated_workspaces([ws], "1.49.4")
        assert "my-plugin" in result
        assert result["my-plugin"]["found"] == "1.47.0"

    def test_no_source_or_backstage_json(self, tmp_path):
        ws = self._create_workspace(tmp_path, "my-plugin")
        result = get_outdated_workspaces([ws], "1.49.4")
        assert "my-plugin" in result
        assert result["my-plugin"]["found"] == "missing"

    def test_multiple_workspaces_mixed(self, tmp_path):
        ws_good = self._create_workspace(tmp_path, "good", source_version="1.49.2")
        ws_bad = self._create_workspace(tmp_path, "bad", source_version="1.43.1")
        ws_override = self._create_workspace(
            tmp_path, "override",
            source_version="1.45.3",
            backstage_version="1.49.0",
        )
        result = get_outdated_workspaces([ws_good, ws_bad, ws_override], "1.49.4")
        assert "good" not in result
        assert "bad" in result
        assert "override" not in result

    def test_malformed_source_json(self, tmp_path):
        ws_dir = tmp_path / "broken"
        (ws_dir / "metadata").mkdir(parents=True)
        (ws_dir / "source.json").write_text("not valid json")
        result = get_outdated_workspaces([ws_dir], "1.49.4")
        assert "broken" in result
        assert result["broken"]["found"] == "missing"


# ---------------------------------------------------------------------------
# remove_stale_plugin_builds
# ---------------------------------------------------------------------------

class TestRemoveStalePluginBuilds:
    def test_removes_json_not_in_expected_set(self, tmp_path):
        keep_dir = tmp_path / "intelligent-assistant"
        keep_dir.mkdir()
        (keep_dir / "keep.json").write_text("{}")

        stale_dir = tmp_path / "lightspeed"
        stale_dir.mkdir()
        (stale_dir / "stale.json").write_text("{}")

        deleted = remove_stale_plugin_builds(
            tmp_path,
            {Path("intelligent-assistant") / "keep.json"},
        )
        assert deleted == 1
        assert (keep_dir / "keep.json").exists()
        assert not (stale_dir / "stale.json").exists()
        assert not stale_dir.exists()

    def test_noop_when_all_expected(self, tmp_path):
        ws = tmp_path / "backstage"
        ws.mkdir()
        (ws / "plugin.json").write_text("{}")
        deleted = remove_stale_plugin_builds(
            tmp_path,
            {Path("backstage") / "plugin.json"},
        )
        assert deleted == 0
        assert (ws / "plugin.json").exists()

    def test_missing_plugin_builds_dir(self, tmp_path):
        assert remove_stale_plugin_builds(tmp_path / "missing", set()) == 0


# ---------------------------------------------------------------------------
# construct_registry_reference
# ---------------------------------------------------------------------------

class TestConstructRegistryReference:
    def test_ghcr_uses_given_backstage_version_in_tag(self):
        ref = construct_registry_reference(
            "ghcr.io/redhat-developer/rhdh-plugin-export-overlays",
            "backstage-community-plugin-foo",
            "2.0.0",
            "1.45.3",
            "",
            "",
        )
        assert ref.endswith(":bs_1.45.3__2.0.0")
        assert "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-foo" in ref

    def test_quay_uses_rhdh_version_not_backstage(self):
        ref = construct_registry_reference(
            "quay.io/rhdh",
            "red-hat-developer-hub-backstage-plugin-bar",
            "1.5.4",
            "1.52.0",
            "1.11",
            "",
        )
        assert ref.endswith(":1.11--1.5.4")
        assert "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-bar" in ref


class TestCommunityRegistryDefault:
    def test_omitting_community_registry_uses_ghcr_default(self, tmp_path):
        overlays = tmp_path / "overlays"
        metadata_dir = overlays / "workspaces" / "community-plugin" / "metadata"
        metadata_dir.mkdir(parents=True)
        (overlays / "versions.json").write_text(
            json.dumps({"backstage": "1.54.6"}), encoding="utf-8"
        )
        (metadata_dir / "plugin-foo.yaml").write_text(
            "kind: Package\n"
            "metadata:\n"
            "  name: plugin-foo\n"
            "spec:\n"
            "  packageName: '@backstage-community/plugin-foo'\n"
            "  version: 1.2.3\n"
            "  support: community\n",
            encoding="utf-8",
        )
        builds = tmp_path / "plugin_builds"
        registry = "registry.access.redhat.com/rhdh"
        script = Path(__file__).resolve().parents[1] / "bootstrapPluginBuilds.py"

        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--overlays-dir", str(overlays),
                "--plugin-builds-dir", str(builds),
                "--registry", registry,
                "--rhdh-version", "1.10",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        assert result.returncode == 0, result.stderr
        build = json.loads(
            (builds / "community-plugin" / "backstage-community-plugin-foo.json").read_text()
        )["backstage-community-plugin-foo"]
        assert build["registryReference"].startswith(
            "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/"
            "backstage-community-plugin-foo:"
        )


class TestClearFallbackMarkers:
    def test_drops_fallback_and_requested_tag(self):
        entry = {
            "registryReference": "quay.io/rhdh/plugin:2.1.0--2.0.0",
            "fallback": True,
            "requestedTag": "2.0.0--1.31.1",
            "digest": "sha256:abc",
        }
        clear_fallback_markers(entry)
        assert "fallback" not in entry
        assert "requestedTag" not in entry
        assert entry["digest"] == "sha256:abc"
        assert entry["registryReference"].endswith(":2.1.0--2.0.0")

    def test_noop_when_markers_absent(self):
        entry = {"registryReference": "quay.io/rhdh/plugin:2.2.0--1.0.0"}
        clear_fallback_markers(entry)
        assert entry == {"registryReference": "quay.io/rhdh/plugin:2.2.0--1.0.0"}
