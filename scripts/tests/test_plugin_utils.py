"""Tests for plugin_utils module."""

import json

import pytest

from plugin_utils import (
    BuildReport,
    WorkspaceMappings,
    _match_workspace_metadata,
    build_workspace_mappings,
    detect_file_format,
    load_and_resolve_to_stems,
    load_filtered_packages_from_yaml,
    load_packages_from_txt,
)


# ---------------------------------------------------------------------------
# detect_file_format
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "file_path, expected",
    [
        ("file.yaml", "yaml"),
        ("file.yml", "yaml"),
        ("file.txt", "txt"),
        ("file.json", "txt"),
    ],
)
def test_detect_file_format(file_path, expected):
    assert detect_file_format(file_path) == expected


# ---------------------------------------------------------------------------
# load_filtered_packages_from_yaml
# ---------------------------------------------------------------------------

class TestLoadFilteredPackagesFromYaml:
    def test_returns_all_packages_from_enabled_and_disabled(self, sample_packages_yaml):
        result = load_filtered_packages_from_yaml(sample_packages_yaml)
        assert result == {
            "@backstage/plugin-catalog-backend-module-github",
            "@backstage-community/plugin-analytics-provider-segment",
            "@backstage-community/plugin-acr",
        }

    def test_empty_packages_section(self, tmp_path):
        yaml_file = tmp_path / "empty.yaml"
        yaml_file.write_text("packages:\n  enabled: []\n  disabled: []\n")
        result = load_filtered_packages_from_yaml(str(yaml_file))
        assert result == set()

    def test_missing_file_exits(self):
        with pytest.raises(SystemExit) as exc_info:
            load_filtered_packages_from_yaml("/nonexistent/path.yaml")
        assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# load_packages_from_txt
# ---------------------------------------------------------------------------

class TestLoadPackagesFromTxt:
    def test_skips_comments_and_blank_lines(self, sample_packages_txt):
        result = load_packages_from_txt(sample_packages_txt)
        assert result == [
            "3scale/plugins/3scale-backend",
            "backstage/plugins/catalog-backend-module-github",
        ]

    def test_missing_file_exits(self):
        with pytest.raises(SystemExit) as exc_info:
            load_packages_from_txt("/nonexistent/path.txt")
        assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# _match_workspace_metadata
# ---------------------------------------------------------------------------

class TestMatchWorkspaceMetadata:
    def test_exact_match(self):
        result = _match_workspace_metadata(
            "ws",
            [("plugin-techdocs", "@backstage-community/plugin-techdocs")],
            ["plugins/techdocs"],
        )
        assert result == {"plugin-techdocs": "ws/plugins/techdocs"}

    def test_suffix_match_with_dash(self):
        result = _match_workspace_metadata(
            "ws",
            [("backstage-community-plugin-techdocs", "@backstage-community/plugin-techdocs")],
            ["plugins/techdocs"],
        )
        assert result == {"backstage-community-plugin-techdocs": "ws/plugins/techdocs"}

    def test_no_plugin_paths_fallback(self):
        result = _match_workspace_metadata(
            "ws",
            [
                ("plugin-a", "@scope/plugin-a"),
                ("plugin-b", "@scope/plugin-b"),
            ],
            [],
        )
        assert result == {
            "plugin-a": "ws/plugin-a",
            "plugin-b": "ws/plugin-b",
        }

    def test_multiple_stems_multiple_paths_no_collision(self):
        result = _match_workspace_metadata(
            "ws",
            [
                ("backstage-community-plugin-techdocs", "@backstage-community/plugin-techdocs"),
                ("backstage-community-plugin-catalog", "@backstage-community/plugin-catalog"),
            ],
            ["plugins/techdocs", "plugins/catalog"],
        )
        assert result == {
            "backstage-community-plugin-techdocs": "ws/plugins/techdocs",
            "backstage-community-plugin-catalog": "ws/plugins/catalog",
        }

    def test_unmatched_stems_fallback(self):
        result = _match_workspace_metadata(
            "ws",
            [
                ("backstage-community-plugin-techdocs", "@backstage-community/plugin-techdocs"),
                ("totally-unrelated-name", "@scope/totally-unrelated-name"),
            ],
            ["plugins/techdocs"],
        )
        assert result["backstage-community-plugin-techdocs"] == "ws/plugins/techdocs"
        assert result["totally-unrelated-name"] == "ws/totally-unrelated-name"


# ---------------------------------------------------------------------------
# build_workspace_mappings
# ---------------------------------------------------------------------------

class TestBuildWorkspaceMappings:
    def test_npm_to_stem_mapping(self, sample_workspace_dir):
        mappings = build_workspace_mappings(sample_workspace_dir)
        assert mappings.npm_to_stem["@backstage/plugin-catalog-backend-module-github"] == "backstage-plugin-catalog-backend-module-github"
        assert mappings.npm_to_stem["@backstage-community/plugin-3scale-backend"] == "backstage-community-plugin-3scale-backend"

    def test_stem_to_npm_mapping(self, sample_workspace_dir):
        mappings = build_workspace_mappings(sample_workspace_dir)
        assert mappings.stem_to_npm["backstage-plugin-catalog-backend-module-github"] == "@backstage/plugin-catalog-backend-module-github"
        assert mappings.stem_to_npm["backstage-community-plugin-3scale-backend"] == "@backstage-community/plugin-3scale-backend"

    def test_ws_path_to_npm_mapping(self, sample_workspace_dir):
        mappings = build_workspace_mappings(sample_workspace_dir)
        assert mappings.ws_path_to_npm["backstage/plugins/catalog-backend-module-github"] == "@backstage/plugin-catalog-backend-module-github"

    def test_ws_path_to_stem_mapping(self, sample_workspace_dir):
        mappings = build_workspace_mappings(sample_workspace_dir)
        assert mappings.ws_path_to_stem["backstage/plugins/catalog-backend-module-github"] == "backstage-plugin-catalog-backend-module-github"

    def test_empty_workspaces_dir(self, tmp_path):
        mappings = build_workspace_mappings(tmp_path)
        assert mappings.npm_to_stem == {}
        assert mappings.stem_to_npm == {}
        assert mappings.ws_path_to_npm == {}
        assert mappings.ws_path_to_stem == {}


# ---------------------------------------------------------------------------
# load_and_resolve_to_stems
# ---------------------------------------------------------------------------

class TestLoadAndResolveToStems:
    def _create_workspace(self, base_dir):
        """Helper: create a minimal workspace for resolution tests."""
        ws_dir = base_dir / "workspaces" / "backstage"
        metadata_dir = ws_dir / "metadata"
        metadata_dir.mkdir(parents=True)

        (ws_dir / "plugins-list.yaml").write_text(
            "plugins/techdocs\nplugins/catalog\n"
        )

        (metadata_dir / "backstage-community-plugin-techdocs.yaml").write_text(
            "apiVersion: extensions.backstage.io/v1alpha1\n"
            "kind: Package\n"
            "metadata:\n"
            "  name: backstage-community-plugin-techdocs\n"
            "spec:\n"
            '  packageName: "@backstage-community/plugin-techdocs"\n'
        )

        (metadata_dir / "backstage-community-plugin-catalog.yaml").write_text(
            "apiVersion: extensions.backstage.io/v1alpha1\n"
            "kind: Package\n"
            "metadata:\n"
            "  name: backstage-community-plugin-catalog\n"
            "spec:\n"
            '  packageName: "@backstage-community/plugin-catalog"\n'
        )

    def test_yaml_input_resolves_npm_to_stems(self, tmp_path):
        self._create_workspace(tmp_path)

        yaml_file = tmp_path / "packages.yaml"
        yaml_file.write_text(
            "packages:\n"
            "  enabled:\n"
            '    - package: "@backstage-community/plugin-techdocs"\n'
        )

        result = load_and_resolve_to_stems([str(yaml_file)], tmp_path)
        assert result == {"backstage-community-plugin-techdocs"}

    def test_txt_input_resolves_workspace_paths_to_stems(self, tmp_path):
        self._create_workspace(tmp_path)

        txt_file = tmp_path / "packages.txt"
        txt_file.write_text("backstage/plugins/techdocs\n")

        result = load_and_resolve_to_stems([str(txt_file)], tmp_path)
        assert result == {"backstage-community-plugin-techdocs"}

    def test_multi_file_union(self, tmp_path):
        self._create_workspace(tmp_path)

        yaml_file = tmp_path / "a.yaml"
        yaml_file.write_text(
            "packages:\n"
            "  enabled:\n"
            '    - package: "@backstage-community/plugin-techdocs"\n'
        )

        txt_file = tmp_path / "b.txt"
        txt_file.write_text("backstage/plugins/catalog\n")

        result = load_and_resolve_to_stems(
            [str(yaml_file), str(txt_file)], tmp_path
        )
        assert result == {
            "backstage-community-plugin-techdocs",
            "backstage-community-plugin-catalog",
        }

    def test_empty_list_returns_empty(self, tmp_path):
        result = load_and_resolve_to_stems([], tmp_path)
        assert result == set()


# ---------------------------------------------------------------------------
# BuildReport
# ---------------------------------------------------------------------------

class TestBuildReport:
    def test_disabled_report(self):
        report = BuildReport(None)
        assert not report.enabled
        # save is a no-op, should not raise
        report.save()

    def test_enabled_report_creates_file(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        assert report.enabled

        report.add_plugin("plugin-a", package="@scope/plugin-a")
        report.set_stage("plugin-a", "bootstrap", "pass")
        report.save()

        assert report_path.exists()
        data = json.loads(report_path.read_text())
        assert data["plugins"]["plugin-a"]["stages"]["bootstrap"]["status"] == "pass"

    def test_overall_all_pass(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.set_stage("p1", "export", "pass")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["plugins"]["p1"]["overall"] == "pass"

    def test_overall_any_fail(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.set_stage("p1", "export", "fail")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["plugins"]["p1"]["overall"] == "fail"

    def test_overall_mixed(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.set_stage("p1", "export", "pass")
        report.add_plugin("p2")
        report.set_stage("p2", "bootstrap", "fail")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["plugins"]["p1"]["overall"] == "pass"
        assert data["plugins"]["p2"]["overall"] == "fail"

    def test_summary_counts(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.add_plugin("p2")
        report.set_stage("p2", "bootstrap", "fail")
        report.add_plugin("p3")
        report.set_stage("p3", "bootstrap", "pass")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["summary"]["total"] == 3
        assert data["summary"]["succeeded"] == 2
        assert data["summary"]["failed"] == 1

    def test_status_success_when_no_failures(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["status"] == "success"

    def test_status_partial_when_some_fail(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.add_plugin("p2")
        report.set_stage("p2", "bootstrap", "fail")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["status"] == "partial"

    def test_overall_outdated(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "outdated",
                         expected_version="1.49.4", found_version="1.45.3")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["plugins"]["p1"]["overall"] == "outdated"

    def test_summary_includes_outdated_count(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.add_plugin("p2")
        report.set_stage("p2", "bootstrap", "outdated")
        report.add_plugin("p3")
        report.set_stage("p3", "bootstrap", "fail")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["summary"]["total"] == 3
        assert data["summary"]["succeeded"] == 1
        assert data["summary"]["failed"] == 1
        assert data["summary"]["outdated"] == 1

    def test_outdated_does_not_count_as_failed(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.add_plugin("p2")
        report.set_stage("p2", "bootstrap", "outdated")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["summary"]["failed"] == 0
        assert data["summary"]["outdated"] == 1

    def test_status_partial_when_outdated(self, tmp_path):
        report_path = tmp_path / "report.json"
        report = BuildReport(str(report_path))
        report.add_plugin("p1")
        report.set_stage("p1", "bootstrap", "pass")
        report.add_plugin("p2")
        report.set_stage("p2", "bootstrap", "outdated")
        report.save()

        data = json.loads(report_path.read_text())
        assert data["status"] == "partial"
