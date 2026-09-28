"""Tests for renderCatalogStatus.py — the generated catalog-index status page."""

from renderCatalogStatus import render_tier, version_regression_warning


def _plugin(name, *, warnings=None, overall="pass", **extra):
    stages = {
        "bootstrap": {"oci_ref": f"quay.io/rhdh/{name}@sha256:{'a' * 64}"},
        "validate": {"status": "pass"},
    }
    if warnings:
        stages["validate"]["warnings"] = warnings
    plugin = {
        "overall": overall,
        "package": f"@scope/{name}",
        "version": extra.pop("version", "1.0.0"),
        "workspace": f"workspaces/{name}",
        "stages": stages,
    }
    plugin.update(extra)
    return plugin


class TestVersionRegressionSection:
    def test_warnings_are_rendered_and_excluded_from_passed(self):
        report = {
            "status": "ok",
            "plugins": {
                "plugin-a": _plugin(
                    "plugin-a",
                    version="5.4.1",
                    warnings=[
                        "[version-regression] 'plugin-a' version regressed "
                        "from 5.7.12 to 5.4.1"
                    ],
                ),
                "plugin-b": _plugin("plugin-b", version="2.0.0"),
            },
        }
        text = "\n".join(
            render_tier("Supported", report, "https://github.com/org/repo", "main")
        )
        assert "Version regression (1)" in text
        assert "`5.7.12`" in text
        assert "`5.4.1`" in text
        assert "### Passed (1)" in text
        assert "plugin-b" in text
        passed_block = text.split("### Passed (1)", 1)[1]
        assert "plugin-a" not in passed_block

    def test_no_section_when_validate_has_no_regression_warning(self):
        report = {
            "status": "ok",
            "plugins": {
                "plugin-b": _plugin(
                    "plugin-b",
                    warnings=["[fallback-tag] older"],
                )
            },
        }
        text = "\n".join(
            render_tier("Supported", report, "https://github.com/org/repo", "main")
        )
        assert "Version regression" not in text

    def test_version_regression_warning_helper(self):
        plugin = _plugin(
            "plugin-a",
            warnings=[
                "[fallback-tag] older",
                "[version-regression] 'plugin-a' version regressed from 2.0.0 to 1.0.0",
            ],
        )
        warning = version_regression_warning(plugin)
        assert warning is not None
        assert warning.startswith("[version-regression]")
        assert version_regression_warning(_plugin("plugin-b")) is None
