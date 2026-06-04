"""Tests for generatePluginBuildInfo.py — parsing, tag listing, and registry reference transforms."""

from unittest.mock import MagicMock, patch

import pytest

import generatePluginBuildInfo


# ---------------------------------------------------------------------------
# parse_registry_reference
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "ref, expected",
    [
        pytest.param(
            "ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0",
            ("ghcr.io", "org/repo/plugin", "bs_1.45.3__1.2.0"),
            id="ghcr-with-tag",
        ),
        pytest.param(
            "quay.io/rhdh/plugin:1.11--1.5.4",
            ("quay.io", "rhdh/plugin", "1.11--1.5.4"),
            id="quay-with-tag",
        ),
        pytest.param(
            "registry.access.redhat.com/rhdh/plugin:1.11--1.5.4",
            ("quay.io", "rhdh/plugin", "1.11--1.5.4"),
            id="rarc-swapped-to-quay",
        ),
        pytest.param(
            "quay.io/rhdh/plugin@sha256:abc123",
            ("quay.io", "rhdh/plugin", "sha256:abc123"),
            id="digest-reference",
        ),
        pytest.param(
            "invalid",
            None,
            id="invalid-no-slash",
        ),
        pytest.param(
            "quay.io/rhdh/plugin",
            None,
            id="invalid-no-tag-or-digest",
        ),
    ],
)
def test_parse_registry_reference(ref, expected):
    assert generatePluginBuildInfo.parse_registry_reference(ref) == expected


# ---------------------------------------------------------------------------
# VERSION_SUFFIX_RE
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "suffix",
    [
        pytest.param("2.18.0", id="three-part"),
        pytest.param("1.5", id="two-part"),
        pytest.param("0.1.0", id="zero-leading"),
        pytest.param("10.20.30", id="multi-digit"),
    ],
)
def test_version_suffix_re_valid(suffix):
    assert generatePluginBuildInfo.VERSION_SUFFIX_RE.match(suffix) is not None


@pytest.mark.parametrize(
    "suffix",
    [
        pytest.param("2.18.0.att", id="attestation-suffix"),
        pytest.param("2.18.0.sbom", id="sbom-suffix"),
        pytest.param("abc", id="letters-only"),
        pytest.param("", id="empty"),
        pytest.param("2.18.0-rc.1", id="prerelease"),
        pytest.param("sha256:abc", id="digest-like"),
    ],
)
def test_version_suffix_re_invalid(suffix):
    assert generatePluginBuildInfo.VERSION_SUFFIX_RE.match(suffix) is None


# ---------------------------------------------------------------------------
# list_tags_with_prefix — mocked with REAL tag data
#
# Tags below are real samples from:
#   quay.io/rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator
#   ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay
# ---------------------------------------------------------------------------

# Real tags from quay.io (Konflux builds) — mix of valid versions and build artifacts
QUAY_REAL_TAGS = [
    # Valid version tags
    "1.10--1.3.2",
    "1.10--1.3.3",
    "1.10--1.5.3",
    "1.10--1.5.4",
    "1.10.0--1.3.2",
    "1.10.0--1.3.3",
    "1.10.0--1.5.3",
    "1.10.0--1.5.4",
    "1.11--1.5.4",
    "1.11.0--1.5.4",
    "1.9--1.1.0",
    "1.9--1.3.1",
    # Garbage: bare commit SHAs
    "207c0117f535de0eccd735c458086807165a243c",
    "2345f799f480ff5a14f72721672c196023f17f00",
    "08ac113825206cc510c055a1a8a2cf0fb52e5947.git",
    "19534fb5ee72171fd373729f3a90909f6ef67a6c.prefetch",
    # Garbage: Konflux build pipeline tags
    "rhdh-bsp-scaf059cf4428e94deaf092ef2ec86921bc6-build-image-index",
    "rhdh-bsp-scaffo9b56ccf78578652c0a7291cccef26eaa-build-container",
    # Garbage: on-pr- tags from Konflux
    "on-pr-05edbdc5bbaf6059e86697042d65eaa1ab72df48.git",
    "on-pr-05edbdc5bbaf6059e86697042d65eaa1ab72df48.prefetch",
    "on-pr-d13a7e6d0d83b7efd8e4e3cfd7a8e092b7b131b9.git",
    # Garbage: sha256- attestation/sbom/manifest tags
    "sha256-000c59163f40769db932c1d4ecb2871e5cdd1e3437510776f7ad00fadaa44290",
    "sha256-000c59163f40769db932c1d4ecb2871e5cdd1e3437510776f7ad00fadaa44290.att",
    "sha256-000c59163f40769db932c1d4ecb2871e5cdd1e3437510776f7ad00fadaa44290.sbom",
    "sha256-143e13c52e7e1dfbe4abc73653af76f0bac8a02bfc598ee9bffcedef829e12fb.src",
    "sha256-143e13c52e7e1dfbe4abc73653af76f0bac8a02bfc598ee9bffcedef829e12fb.dockerfile",
]

# Real tags from ghcr.io — much cleaner, but still has pr_/next_ prefixes
GHCR_REAL_TAGS = [
    # Valid version tags
    "bs_1.32.6__2.3.0",
    "bs_1.35.1__2.5.0",
    "bs_1.36.1__2.6.2",
    "bs_1.39.1__2.9.1",
    "bs_1.42.5__2.11.0",
    "bs_1.45.3__2.11.0",
    "bs_1.45.3__2.14.0",
    "bs_1.49.4__2.18.0",
    # Not matching bs_ prefix
    "next__2.11.0",
    "next__2.14.0",
    "pr_1168__2.6.2",
    "pr_2457__2.18.0",
]


def _mock_response(tags):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"tags": tags}
    return resp


@patch("generatePluginBuildInfo.requests.get")
def test_list_tags_quay_prefix_filters_garbage(mock_get):
    """Verify only clean version tags survive from real quay.io Konflux output."""
    mock_get.return_value = _mock_response(QUAY_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator",
        "1.10--", None, {}
    )
    assert result == ["1.10--1.3.2", "1.10--1.3.3", "1.10--1.5.3", "1.10--1.5.4"]


@patch("generatePluginBuildInfo.requests.get")
def test_list_tags_quay_three_part_prefix(mock_get):
    """Verify three-part version prefix (1.10.0--) also works."""
    mock_get.return_value = _mock_response(QUAY_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator",
        "1.10.0--", None, {}
    )
    assert result == ["1.10.0--1.3.2", "1.10.0--1.3.3", "1.10.0--1.5.3", "1.10.0--1.5.4"]


@patch("generatePluginBuildInfo.requests.get")
def test_list_tags_ghcr_prefix_filters_other_families(mock_get):
    """Verify only bs_1.45.3__ tags returned, not next__/pr__ tags."""
    mock_get.return_value = _mock_response(GHCR_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "ghcr.io", "redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay",
        "bs_1.45.3__", None, {}
    )
    assert result == ["bs_1.45.3__2.11.0", "bs_1.45.3__2.14.0"]


@patch("generatePluginBuildInfo.requests.get")
def test_list_tags_no_matching_prefix(mock_get):
    """Prefix that doesn't exist in the registry returns empty list."""
    mock_get.return_value = _mock_response(QUAY_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/plugin", "1.12--", None, {}
    )
    assert result == []


@patch("generatePluginBuildInfo.requests.get")
def test_list_tags_empty_response(mock_get):
    mock_get.return_value = _mock_response([])

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/plugin", "1.11--", None, {}
    )
    assert result == []


@patch("generatePluginBuildInfo.requests.get")
def test_list_tags_version_sort_order(mock_get):
    """Verify ascending version sort — latest tag is last."""
    mock_get.return_value = _mock_response(QUAY_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator",
        "1.9--", None, {}
    )
    assert result == ["1.9--1.1.0", "1.9--1.3.1"]
    assert result[-1] == "1.9--1.3.1"


# ---------------------------------------------------------------------------
# get_query_registry_reference
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "ref, expected",
    [
        pytest.param(
            "registry.access.redhat.com/rhdh/plugin:1.11",
            "quay.io/rhdh/plugin:1.11",
            id="rarc-swaps-to-quay",
        ),
        pytest.param(
            "quay.io/rhdh/plugin:1.11",
            "quay.io/rhdh/plugin:1.11",
            id="quay-passes-through",
        ),
        pytest.param(
            "ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0",
            "ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0",
            id="ghcr-passes-through",
        ),
    ],
)
def test_get_query_registry_reference(ref, expected):
    assert generatePluginBuildInfo.get_query_registry_reference(ref) == expected


# ---------------------------------------------------------------------------
# get_output_registry_reference
# ---------------------------------------------------------------------------

class TestGetOutputRegistryReference:
    """Tests that manipulate the module-level REGISTRY_BASE global."""

    def teardown_method(self):
        generatePluginBuildInfo.REGISTRY_BASE = ""

    def test_rarc_base_swaps_quay_rhdh_ref(self):
        generatePluginBuildInfo.REGISTRY_BASE = "registry.access.redhat.com/rhdh"
        ref = "quay.io/rhdh/plugin:1.11--1.5.4"
        assert generatePluginBuildInfo.get_output_registry_reference(ref) == (
            "registry.access.redhat.com/rhdh/plugin:1.11--1.5.4"
        )

    def test_rarc_base_does_not_swap_ghcr_ref(self):
        generatePluginBuildInfo.REGISTRY_BASE = "registry.access.redhat.com/rhdh"
        ref = "ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0"
        assert generatePluginBuildInfo.get_output_registry_reference(ref) == ref

    def test_quay_rhdh_base_passes_through(self):
        generatePluginBuildInfo.REGISTRY_BASE = "quay.io/rhdh"
        ref = "quay.io/rhdh/plugin:1.11--1.5.4"
        assert generatePluginBuildInfo.get_output_registry_reference(ref) == ref

    def test_ghcr_base_passes_through(self):
        generatePluginBuildInfo.REGISTRY_BASE = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays"
        ref = "ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0"
        assert generatePluginBuildInfo.get_output_registry_reference(ref) == ref


# ---------------------------------------------------------------------------
# _fetch_image_metadata — real HTTP calls against fixed known images
#
# These tests use published images with stable digests that won't change.
# ---------------------------------------------------------------------------

# Fixed known images for testing
GHCR_KNOWN_REF = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay:bs_1.49.4__2.18.0"
GHCR_KNOWN_DIGEST = "sha256:15128f76a6edca410f0aa83f48b63fbdbfc5c319404ee9cb577969a2140f2a56"

QUAY_KNOWN_REF = "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator:1.11--1.5.4"
QUAY_KNOWN_DIGEST = "sha256:e8cb33e40f6f846adaf5e0446049d5a2a5e93a2a12cf8b610e3e0e346f98005c"


class TestFetchImageMetadata:
    """Tests for _fetch_image_metadata against real registries."""

    def test_ghcr_returns_digest(self):
        metadata = generatePluginBuildInfo._fetch_image_metadata(GHCR_KNOWN_REF)
        assert metadata is not None
        assert metadata["digest"] == GHCR_KNOWN_DIGEST

    def test_ghcr_returns_dynamic_packages_annotation(self):
        metadata = generatePluginBuildInfo._fetch_image_metadata(GHCR_KNOWN_REF)
        assert metadata is not None
        assert "io.backstage.dynamic-packages" in metadata

    def test_ghcr_community_has_no_build_date(self):
        metadata = generatePluginBuildInfo._fetch_image_metadata(GHCR_KNOWN_REF)
        assert metadata is not None
        assert "build-date" not in metadata

    def test_quay_returns_digest(self):
        metadata = generatePluginBuildInfo._fetch_image_metadata(QUAY_KNOWN_REF)
        assert metadata is not None
        assert metadata["digest"] == QUAY_KNOWN_DIGEST

    def test_quay_downstream_has_build_date(self):
        metadata = generatePluginBuildInfo._fetch_image_metadata(QUAY_KNOWN_REF)
        assert metadata is not None
        assert "build-date" in metadata
        assert metadata["build-date"]  # non-empty

    def test_quay_downstream_has_vcs_ref(self):
        metadata = generatePluginBuildInfo._fetch_image_metadata(QUAY_KNOWN_REF)
        assert metadata is not None
        assert "vcs-ref" in metadata

    def test_quay_downstream_has_upstream_and_midstream(self):
        metadata = generatePluginBuildInfo._fetch_image_metadata(QUAY_KNOWN_REF)
        assert metadata is not None
        assert "upstream" in metadata
        assert "midstream" in metadata

    def test_nonexistent_tag_returns_none(self):
        bad_ref = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay:bs_1.49.4__9999.99.9"
        metadata = generatePluginBuildInfo._fetch_image_metadata(bad_ref)
        assert metadata is None

    def test_nonexistent_repo_returns_none(self):
        bad_ref = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/this-plugin-does-not-exist:bs_1.0.0__1.0.0"
        metadata = generatePluginBuildInfo._fetch_image_metadata(bad_ref)
        assert metadata is None


# ---------------------------------------------------------------------------
# get_image_metadata — fallback chain
# ---------------------------------------------------------------------------

class TestGetImageMetadata:
    """Tests for get_image_metadata including the fallback path."""

    def test_direct_hit_returns_metadata_without_fallback_fields(self):
        """When the exact tag exists, no fallback fields are added."""
        metadata = generatePluginBuildInfo.get_image_metadata(GHCR_KNOWN_REF)
        assert metadata is not None
        assert metadata["digest"] == GHCR_KNOWN_DIGEST
        assert "fallback" not in metadata
        assert "requestedTag" not in metadata

    def test_fallback_to_older_tag(self):
        """When the exact tag doesn't exist, falls back to latest available tag with same prefix."""
        nonexistent_ref = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay:bs_1.49.4__9999.99.9"
        metadata = generatePluginBuildInfo.get_image_metadata(nonexistent_ref)
        assert metadata is not None
        assert metadata.get("fallback") is True
        assert metadata["requestedTag"] == "bs_1.49.4__9999.99.9"
        assert "registryReference" in metadata
        assert "bs_1.49.4__" in metadata["registryReference"]
        assert "9999" not in metadata["registryReference"]
        assert metadata["digest"].startswith("sha256:")

    def test_fallback_no_tags_for_prefix_returns_none(self):
        """When the prefix has zero published tags, fallback returns None."""
        nonexistent_ref = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay:bs_9999.99.9__1.0.0"
        metadata = generatePluginBuildInfo.get_image_metadata(nonexistent_ref)
        assert metadata is None

    def test_fallback_quay_with_nonexistent_version(self):
        """Quay.io fallback with an nonexistent plugin version resolves to the latest real tag."""
        nonexistent_ref = "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator:1.11--9999.99.9"
        metadata = generatePluginBuildInfo.get_image_metadata(nonexistent_ref)
        assert metadata is not None
        assert metadata.get("fallback") is True
        assert metadata["requestedTag"] == "1.11--9999.99.9"
        assert "1.11--" in metadata["registryReference"]
        assert "9999" not in metadata["registryReference"]


# ---------------------------------------------------------------------------
# resolve_fallback_tag
# ---------------------------------------------------------------------------

class TestResolveFallbackTag:
    """Tests for resolve_fallback_tag against real registries."""

    def test_ghcr_nonexistent_version_resolves_to_latest(self):
        """An nonexistent plugin version with a valid prefix resolves to the latest real tag."""
        nonexistent_ref = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay:bs_1.49.4__9999.99.9"
        result = generatePluginBuildInfo.resolve_fallback_tag(nonexistent_ref)
        assert result is not None
        assert "bs_1.49.4__" in result
        assert "9999" not in result

    def test_quay_nonexistent_version_resolves_to_latest(self):
        nonexistent_ref = "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator:1.11--9999.99.9"
        result = generatePluginBuildInfo.resolve_fallback_tag(nonexistent_ref)
        assert result is not None
        assert "1.11--" in result
        assert "9999" not in result

    def test_nonexistent_prefix_returns_none(self):
        """When the prefix itself has no tags, returns None."""
        nonexistent_ref = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay:bs_9999.99.9__1.0.0"
        result = generatePluginBuildInfo.resolve_fallback_tag(nonexistent_ref)
        assert result is None

    def test_exact_tag_exists_returns_none(self):
        """When the requested tag already exists, no fallback needed — returns None."""
        result = generatePluginBuildInfo.resolve_fallback_tag(GHCR_KNOWN_REF)
        assert result is None

    def test_no_separator_in_tag_returns_none(self):
        """Tags without a separator can't be split into prefix — returns None."""
        result = generatePluginBuildInfo.resolve_fallback_tag("ghcr.io/org/repo:latest")
        assert result is None

    def test_unparseable_ref_returns_none(self):
        result = generatePluginBuildInfo.resolve_fallback_tag("invalid")
        assert result is None
