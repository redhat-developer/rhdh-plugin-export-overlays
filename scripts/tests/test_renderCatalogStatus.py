"""Tests for renderCatalogStatus.py — the generated catalog-index status page."""

from renderCatalogStatus import (
    compute_cross_branch_flags,
    version_marker,
    render_status_page,
    render_tier,
    version_regression_warning,
)


def test_source_links_to_exact_commit():
    sha = "dd328e13fb0412de1914c5398a33c1d2c839f44c"
    text = render_status_page(
        {}, {}, "https://github.com/org/repo", "main", sha, "", "", "", "catalog-index-main"
    )

    assert (
        f"**Source:** [main @ dd328e1](https://github.com/org/repo/commit/{sha})"
        in text
    )
    assert (
        "**Catalog index branch:** "
        "[catalog-index-main](https://github.com/org/repo/tree/catalog-index-main)"
        in text
    )


def test_source_without_commit_is_not_linked_to_mutable_branch():
    text = render_status_page({}, {}, "https://github.com/org/repo", "main", "", "", "", "")

    assert "**Source:** main  " in text


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


UPSTREAM_TAGS = (
    "https://quay.io/repository/rhdh-community/plugin-catalog-index?tab=tags"
)
DOWNSTREAM_TAGS = "https://quay.io/repository/rhdh/plugin-catalog-index?tab=tags"
SOURCE_REPO = "https://github.com/org/repo"


def _supported_report(oci_ref: str, metadata=None):
    return {
        "summary": {"total": 1, "succeeded": 1, "failed": 0},
        "metadata": metadata or {},
        "plugins": {
            "plugin-a": {
                "overall": "pass",
                "package": "@scope/plugin-a",
                "version": "1.0.0",
                "workspace": "workspaces/plugin-a",
                "stages": {"bootstrap": {"oci_ref": oci_ref}},
            }
        },
    }


def _render(supported, community=None):
    return render_status_page(
        supported,
        community or {},
        SOURCE_REPO,
        "main",
        "abc1234",
        "",
        "",
        "",
    )


def test_downstream_null_image_links_production_tags():
    text = _render(_supported_report("quay.io/rhdh/plugin-a:1.0.0"))
    assert f"[quay.io/rhdh/plugin-catalog-index]({DOWNSTREAM_TAGS})" in text
    assert "rhdh-community" not in text

    rhec = _render(
        _supported_report("registry.access.redhat.com/rhdh/plugin-a:1.0.0")
    )
    assert f"[quay.io/rhdh/plugin-catalog-index]({DOWNSTREAM_TAGS})" in rhec
    assert "rhdh-community" not in rhec


def test_upstream_null_image_links_community_tags():
    supported = _supported_report(
        "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/plugin-a:1.0.0"
    )
    community = _supported_report(
        "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/plugin-b:1.0.0"
    )
    text = _render(supported, community)
    assert f"[quay.io/rhdh-community/plugin-catalog-index]({UPSTREAM_TAGS})" in text
    assert DOWNSTREAM_TAGS not in text
    assert "| Community | 1 | 1 | 0 | 0 | 0 | — | — |" in text


def test_unrecognized_ref_falls_back_to_upstream_tags():
    text = _render(_supported_report(""))
    assert f"[quay.io/rhdh-community/plugin-catalog-index]({UPSTREAM_TAGS})" in text
    assert DOWNSTREAM_TAGS not in text


def test_published_catalog_image_is_kept():
    image = "quay.io/rhdh-community/plugin-catalog-index:2.2-bs_1.54.9-abc1234"
    report = _supported_report(
        "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/plugin-a:1.0.0",
        metadata={
            "last-successful-publish": "abc1234def",
            "catalog-index-image": image,
        },
    )
    text = _render(report)
    assert f"[{image}](https://{image})" in text
    assert UPSTREAM_TAGS not in text
    assert DOWNSTREAM_TAGS not in text



def _tagged_plugin(name, version, tag, digest=""):
    plugin = _plugin(name, version=version)
    plugin["stages"]["bootstrap"]["oci_ref"] = f"ghcr.io/org/{name}:{tag}"
    if digest:
        plugin["stages"]["image-metadata-fetch"] = {"digest": digest}
    return plugin


class TestCrossBranchFlags:
    def test_same_tag_is_flagged(self):
        own = {"plugins": {"p": _tagged_plugin("p", "1.0.4", "bs_1.54.9__1.0.4")}}
        peer = {"plugins": {"p": _tagged_plugin("p", "1.0.4", "bs_1.54.9__1.0.4")}}

        assert compute_cross_branch_flags(own, peer)["p"]["kind"] == "same-tag"

    def test_lower_version_is_flagged_older_with_both_tags(self):
        own = {"plugins": {"p": _tagged_plugin("p", "6.2.4", "bs_1.54.9__6.2.4")}}
        peer = {"plugins": {"p": _tagged_plugin("p", "6.2.5", "bs_1.54.9__6.2.5")}}

        flag = compute_cross_branch_flags(own, peer)["p"]

        assert flag["kind"] == "older"
        assert flag["own_tag"] == "bs_1.54.9__6.2.4"
        assert flag["peer_tag"] == "bs_1.54.9__6.2.5"

    def test_newer_version_is_not_flagged(self):
        own = {"plugins": {"p": _tagged_plugin("p", "6.2.5", "bs_1.54.9__6.2.5")}}
        peer = {"plugins": {"p": _tagged_plugin("p", "6.2.4", "bs_1.54.9__6.2.4")}}

        assert compute_cross_branch_flags(own, peer) == {}

    def test_version_ordering_is_numeric(self):
        own = {"plugins": {"p": _tagged_plugin("p", "1.9.0", "bs_1.54.9__1.9.0")}}
        peer = {"plugins": {"p": _tagged_plugin("p", "1.10.0", "bs_1.54.9__1.10.0")}}

        assert compute_cross_branch_flags(own, peer)["p"]["kind"] == "older"

    def test_plugin_absent_from_release_is_not_flagged(self):
        own = {"plugins": {"p": _tagged_plugin("p", "0.1.0", "bs_1.54.9__0.1.0")}}

        assert compute_cross_branch_flags(own, {"plugins": {}}) == {}


class TestVersionMarker:
    def test_same_tag_is_a_warning_icon_only(self):
        flags = {"p": {"kind": "same-tag", "own_tag": "bs__1.0.0", "peer_tag": "bs__1.0.0"}}

        assert version_marker(flags, "p") == "⚠️ "

    def test_older_shows_both_tags(self):
        flags = {"p": {"kind": "older", "own_tag": "bs__1.0.0", "peer_tag": "bs__1.1.0"}}

        assert version_marker(flags, "p") == "⛔ `bs__1.0.0 < bs__1.1.0` "

    def test_unflagged_plugin_has_no_marker(self):
        assert version_marker({}, "p") == ""


class TestCrossBranchRendering:
    def test_marker_sits_in_the_version_cell(self):
        plugin = _tagged_plugin("plugin-a", "1.0.0", "bs_1.54.9__1.0.0")
        report = {"status": "ok", "plugins": {"plugin-a": plugin}}
        flags = {"plugin-a": {"kind": "older", "own_tag": "a", "peer_tag": "b"}}

        lines = render_tier(
            "Supported", report, SOURCE_REPO, "main", cross_flags=flags
        )
        row = next(line for line in lines if "`@scope/plugin-a`" in line)

        assert row.startswith("| [plugin-a]")
        assert "| ⛔ `a < b` 1.0.0 |" in row

    def test_no_marker_without_flags(self):
        plugin = _tagged_plugin("plugin-a", "1.0.0", "bs_1.54.9__1.0.0")
        report = {"status": "ok", "plugins": {"plugin-a": plugin}}

        lines = render_tier("Supported", report, SOURCE_REPO, "main")
        row = next(line for line in lines if "`@scope/plugin-a`" in line)

        assert "⚠️" not in row and "⛔" not in row

    def test_page_marks_rows_when_peer_reports_given(self):
        own = _tagged_plugin("plugin-a", "1.0.0", "bs_1.54.9__1.0.0")
        peer = _tagged_plugin("plugin-a", "1.0.0", "bs_1.54.9__1.0.0")

        text = render_status_page(
            {"status": "ok", "plugins": {"plugin-a": own}},
            {},
            SOURCE_REPO,
            "main",
            "abc1234",
            "",
            "",
            "",
            peer_reports={"supported": {"plugins": {"plugin-a": peer}}},
            peer_branch="release-2.1",
        )

        assert "| ⚠️ 1.0.0 |" in text
        assert "Cross-branch" not in text

    def test_page_has_no_markers_without_peer_branch(self):
        plugin = _tagged_plugin("plugin-a", "1.0.0", "bs_1.54.9__1.0.0")

        text = _render({"status": "ok", "plugins": {"plugin-a": plugin}})

        assert "⚠️ 1.0.0" not in text


class TestSummaryComparisonCounts:
    def _page(self, supported, peer):
        return render_status_page(
            supported,
            {},
            SOURCE_REPO,
            "main",
            "abc1234",
            "",
            "",
            "",
            peer_reports={"supported": peer},
            peer_branch="release-2.1",
        )

    def test_counts_appear_as_summary_columns(self):
        own = {
            "status": "ok",
            "summary": {"total": 2, "succeeded": 2, "failed": 0},
            "plugins": {
                "same": _tagged_plugin("same", "1.0.0", "bs_1.54.9__1.0.0"),
                "behind": _tagged_plugin("behind", "1.0.0", "bs_1.54.9__1.0.0"),
            },
        }
        peer = {
            "plugins": {
                "same": _tagged_plugin("same", "1.0.0", "bs_1.54.9__1.0.0"),
                "behind": _tagged_plugin("behind", "2.0.0", "bs_1.54.9__2.0.0"),
            }
        }

        text = self._page(own, peer)

        assert "| ⚠️ Same Tag | ⛔ Older |" in text
        assert "| Supported | 2 | 2 | 0 | 0 | 1 | 1 | 0 |" in text

    def test_columns_absent_without_peer_branch(self):
        plugin = _tagged_plugin("plugin-a", "1.0.0", "bs_1.54.9__1.0.0")

        text = _render({"status": "ok", "plugins": {"plugin-a": plugin}})

        assert "⚠️ Same Tag" not in text
        assert "⛔ Older" not in text
