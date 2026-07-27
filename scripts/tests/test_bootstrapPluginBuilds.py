"""Tests for bootstrapPluginBuilds module."""

import json

import pytest

from bootstrapPluginBuilds import (
    get_outdated_workspaces,
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
