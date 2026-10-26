"""Tests for generatePluginBuildInfo.py — parsing, tag listing, and registry reference transforms."""

import base64
import json
import re
from unittest.mock import MagicMock, patch

import pytest

SHA256_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

import generatePluginBuildInfo
from plugin_utils import BuildReport


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


def _skopeo_completed(tags):
    proc = MagicMock()
    proc.returncode = 0
    proc.stdout = json.dumps({"Tags": tags})
    proc.stderr = ""
    return proc


@pytest.fixture(autouse=True)
def _clear_skopeo_tag_cache():
    generatePluginBuildInfo._SKOPEO_TAG_CACHE.clear()
    yield
    generatePluginBuildInfo._SKOPEO_TAG_CACHE.clear()


@patch("generatePluginBuildInfo.subprocess.run")
def test_list_tags_quay_prefix_filters_garbage(mock_run):
    """Verify only clean version tags survive from real quay.io Konflux output."""
    mock_run.return_value = _skopeo_completed(QUAY_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator",
        "1.10--", None, {}
    )
    assert result == ["1.10--1.3.2", "1.10--1.3.3", "1.10--1.5.3", "1.10--1.5.4"]


@patch("generatePluginBuildInfo.subprocess.run")
def test_list_tags_quay_three_part_prefix(mock_run):
    """Verify three-part version prefix (1.10.0--) also works."""
    mock_run.return_value = _skopeo_completed(QUAY_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator",
        "1.10.0--", None, {}
    )
    assert result == ["1.10.0--1.3.2", "1.10.0--1.3.3", "1.10.0--1.5.3", "1.10.0--1.5.4"]


@patch("generatePluginBuildInfo.subprocess.run")
def test_list_tags_ghcr_prefix_filters_other_families(mock_run):
    """Verify only bs_1.45.3__ tags returned, not next__/pr__ tags."""
    mock_run.return_value = _skopeo_completed(GHCR_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "ghcr.io", "redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay",
        "bs_1.45.3__", None, {}
    )
    assert result == ["bs_1.45.3__2.11.0", "bs_1.45.3__2.14.0"]


@patch("generatePluginBuildInfo.subprocess.run")
def test_list_tags_no_matching_prefix(mock_run):
    """Prefix that doesn't exist in the registry returns empty list."""
    mock_run.return_value = _skopeo_completed(QUAY_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/plugin", "1.12--", None, {}
    )
    assert result == []


@patch("generatePluginBuildInfo.subprocess.run")
def test_list_tags_empty_response(mock_run):
    mock_run.return_value = _skopeo_completed([])

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/plugin", "1.11--", None, {}
    )
    assert result == []


@patch("generatePluginBuildInfo.subprocess.run")
def test_list_tags_version_sort_order(mock_run):
    """Verify ascending version sort — latest tag is last."""
    mock_run.return_value = _skopeo_completed(QUAY_REAL_TAGS)

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator",
        "1.9--", None, {}
    )
    assert result == ["1.9--1.1.0", "1.9--1.3.1"]
    assert result[-1] == "1.9--1.3.1"


@patch("generatePluginBuildInfo.subprocess.run")
def test_list_tags_keeps_only_xyz_release_tags(mock_run):
    """SHA and attestation tags are dropped. Only x.y.z--a.b.c for the prefix remains."""
    mock_run.return_value = _skopeo_completed([
        "sha256-000c59163f40769db932c1d4ecb2871e5cdd1e3437510776f7ad00fadaa44290",
        "sha256-000c59163f40769db932c1d4ecb2871e5cdd1e3437510776f7ad00fadaa44290.att",
        "207c0117f535de0eccd735c458086807165a243c",
        "2.2.0--6.2.4",
        "2.1.0--6.2.4",
        "2.2--6.2.4",
    ])

    result = generatePluginBuildInfo.list_tags_with_prefix(
        "quay.io", "rhdh/red-hat-developer-hub-backstage-plugin-orchestrator",
        "2.2.0--", None, {}
    )
    assert result == ["2.2.0--6.2.4"]
    mock_run.assert_called_once()


@patch("generatePluginBuildInfo.subprocess.run")
def test_alias_prefix_reuses_one_skopeo_list(mock_run):
    """A missing 2.2.0-- tag falls through to 2.2-- without a second skopeo call."""
    mock_run.return_value = _skopeo_completed([
        "sha256-abc.att",
        "2.2--6.2.4",
        "2.1.0--6.2.1",
    ])

    result = generatePluginBuildInfo.resolve_fallback_tag(
        "quay.io/rhdh/plugin:2.2.0--6.2.4"
    )
    assert result == {
        "reference": "quay.io/rhdh/plugin:2.2--6.2.4",
        "alias": True,
    }
    mock_run.assert_called_once()


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
# _fetch_image_metadata — real HTTP calls against known published images
#
# Digests are validated by shape only: mutable tags can be republished.
# ---------------------------------------------------------------------------

# Known images for testing
GHCR_KNOWN_REF = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-scaffolder-backend-module-quay:bs_1.49.4__2.18.0"

QUAY_KNOWN_REF = "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator:1.11--1.5.4"


class TestFetchImageMetadata:
    """Tests for _fetch_image_metadata against real registries."""

    def test_ghcr_returns_digest(self):
        metadata = generatePluginBuildInfo._fetch_image_metadata(GHCR_KNOWN_REF)
        assert metadata is not None
        assert SHA256_DIGEST_RE.match(metadata["digest"])

    def test_ghcr_returns_dynamic_packages_b64(self):
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
        assert SHA256_DIGEST_RE.match(metadata["digest"])

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
        assert SHA256_DIGEST_RE.match(metadata["digest"])
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
        assert "bs_1.49.4__" in result['reference']
        assert "9999" not in result['reference']
        assert result['alias'] is False

    def test_quay_nonexistent_version_resolves_to_latest(self):
        nonexistent_ref = "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator:1.11--9999.99.9"
        result = generatePluginBuildInfo.resolve_fallback_tag(nonexistent_ref)
        assert result is not None
        assert "1.11--" in result['reference']
        assert "9999" not in result['reference']
        assert result['alias'] is False

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


# ---------------------------------------------------------------------------
# resolve_fallback_tag — RHDH version alias resolution (mocked)
# ---------------------------------------------------------------------------

class TestResolveFallbackTagAlias:
    """Tests for RHDH version alias resolution in resolve_fallback_tag."""

    @patch("generatePluginBuildInfo.subprocess.run")
    def test_quay_xyz_prefix_resolves_via_alias(self, mock_run):
        """Request 1.10.2--1.5.4, registry has 1.10--1.5.4 -> alias, not fallback."""
        mock_run.return_value = _skopeo_completed(QUAY_REAL_TAGS)
        ref = "quay.io/rhdh/plugin:1.10.2--1.5.4"
        result = generatePluginBuildInfo.resolve_fallback_tag(ref)
        assert result is not None
        assert result['reference'] == "quay.io/rhdh/plugin:1.10--1.5.4"
        assert result['alias'] is True
        mock_run.assert_called_once()

    @patch("generatePluginBuildInfo.subprocess.run")
    def test_quay_xyz_prefix_no_exact_version_under_xy_returns_none(self, mock_run):
        """Request 1.10.2--9999.99.9, no 1.10.2-- tags, 1.10-- has tags but not 9999.99.9 -> None (needs new build)."""
        mock_run.return_value = _skopeo_completed(QUAY_REAL_TAGS)
        ref = "quay.io/rhdh/plugin:1.10.2--9999.99.9"
        result = generatePluginBuildInfo.resolve_fallback_tag(ref)
        assert result is None
        mock_run.assert_called_once()

    @patch("generatePluginBuildInfo.subprocess.run")
    def test_quay_xyz_prefix_no_xy_tags_returns_none(self, mock_run):
        """Request 1.12.0--1.5.4, no 1.12.0-- or 1.12-- tags exist -> None."""
        mock_run.return_value = _skopeo_completed(QUAY_REAL_TAGS)
        ref = "quay.io/rhdh/plugin:1.12.0--1.5.4"
        result = generatePluginBuildInfo.resolve_fallback_tag(ref)
        assert result is None
        mock_run.assert_called_once()

    @patch("generatePluginBuildInfo.subprocess.run")
    def test_ghcr_does_not_use_alias(self, mock_run):
        """ghcr.io with nonexistent bs_1.50.0__ prefix should NOT try bs_1.50__ alias."""
        mock_run.return_value = _skopeo_completed(GHCR_REAL_TAGS)
        ref = "ghcr.io/org/repo/plugin:bs_1.50.0__2.18.0"
        result = generatePluginBuildInfo.resolve_fallback_tag(ref)
        assert result is None

    @patch("generatePluginBuildInfo.subprocess.run")
    def test_quay_two_part_prefix_does_not_use_alias(self, mock_run):
        """Request 1.12--1.5.4, prefix is already two-part, no alias resolution attempted."""
        mock_run.return_value = _skopeo_completed(QUAY_REAL_TAGS)
        ref = "quay.io/rhdh/plugin:1.12--1.5.4"
        result = generatePluginBuildInfo.resolve_fallback_tag(ref)
        assert result is None
        mock_run.assert_called_once()


# ---------------------------------------------------------------------------
# get_image_metadata — alias vs fallback distinction (mocked)
# ---------------------------------------------------------------------------

class TestGetImageMetadataAlias:
    """Tests for get_image_metadata alias vs fallback distinction."""

    @patch("generatePluginBuildInfo._fetch_image_metadata")
    @patch("generatePluginBuildInfo.resolve_fallback_tag")
    def test_alias_no_fallback_flag(self, mock_resolve, mock_fetch):
        """When resolved via alias but plugin version matches, no fallback flag."""
        mock_fetch.side_effect = [None, {"digest": "sha256:abc123"}]
        mock_resolve.return_value = {
            'reference': 'quay.io/rhdh/plugin:1.10--1.5.4',
            'alias': True,
        }
        metadata = generatePluginBuildInfo.get_image_metadata("quay.io/rhdh/plugin:1.10.2--1.5.4")
        assert metadata is not None
        assert metadata['registryReference'] == 'quay.io/rhdh/plugin:1.10--1.5.4'
        assert 'fallback' not in metadata
        assert 'requestedTag' not in metadata

    @patch("generatePluginBuildInfo._fetch_image_metadata")
    @patch("generatePluginBuildInfo.resolve_fallback_tag")
    def test_regular_fallback_sets_fallback_flag(self, mock_resolve, mock_fetch):
        """When resolve returns alias=False (regular fallback), fallback IS set."""
        mock_fetch.side_effect = [None, {"digest": "sha256:abc123"}]
        mock_resolve.return_value = {
            'reference': 'quay.io/rhdh/plugin:1.11--1.5.4',
            'alias': False,
        }
        metadata = generatePluginBuildInfo.get_image_metadata("quay.io/rhdh/plugin:1.11--1.6.0")
        assert metadata is not None
        assert metadata.get('fallback') is True
        assert metadata['requestedTag'] == '1.11--1.6.0'
        assert metadata['registryReference'] == 'quay.io/rhdh/plugin:1.11--1.5.4'


class TestFailedMetadataDropsStaleDigest:
    """A missed tag must not keep the digest from an older successful fetch."""

    @patch("generatePluginBuildInfo.get_image_metadata", return_value=None)
    def test_clears_digest_and_image_fields(self, _mock_metadata):
        image = "red-hat-developer-hub-backstage-plugin-orchestrator"
        data = {
            image: {
                "workspacePath": "orchestrator/plugins/orchestrator",
                "registryReference": f"quay.io/rhdh/{image}:2.2.0--6.2.5",
                "digest": "sha256:" + "ab" * 32,
                "build-date": "2026-10-21T16:57:24Z",
                "fallback": True,
                "requestedTag": "2.2.0--6.2.4",
            }
        }
        modified, fallback_count, _last = generatePluginBuildInfo._enrich_plugins_in_build_file(
            data, "orchestrator", None, [], []
        )
        plugin = data[image]
        assert modified is True
        assert fallback_count == 0
        assert "digest" not in plugin
        assert "build-date" not in plugin
        assert "fallback" not in plugin
        assert "requestedTag" not in plugin
        assert plugin["registryReference"] == f"quay.io/rhdh/{image}:2.2.0--6.2.5"
        assert plugin["workspacePath"] == "orchestrator/plugins/orchestrator"


# ---------------------------------------------------------------------------
# collect_fallback_entries
# ---------------------------------------------------------------------------

class TestCollectFallbackEntries:
    """Unit tests for scanning plugin_builds JSON for fallback tuples."""

    def test_collects_have_and_want_tags(self, tmp_path):
        ws = tmp_path / "topology"
        ws.mkdir()
        (ws / "plugin.json").write_text(
            '{\n'
            '  "backstage-community-plugin-topology": {\n'
            '    "registryReference": "quay.io/rhdh/backstage-community-plugin-topology:1.11--1.5.4",\n'
            '    "fallback": true,\n'
            '    "requestedTag": "1.11--1.6.0"\n'
            '  },\n'
            '  "other-plugin": {\n'
            '    "registryReference": "quay.io/rhdh/other:1.11--1.6.0"\n'
            '  }\n'
            '}\n'
        )
        result = generatePluginBuildInfo.collect_fallback_entries(tmp_path)
        assert result == [
            ("backstage-community-plugin-topology", "1.11--1.5.4", "1.11--1.6.0", "topology"),
        ]

    def test_empty_when_no_fallbacks(self, tmp_path):
        ws = tmp_path / "ws"
        ws.mkdir()
        (ws / "plugin.json").write_text(
            '{"p": {"registryReference": "quay.io/rhdh/p:1.0--1.0"}}\n'
        )
        assert generatePluginBuildInfo.collect_fallback_entries(tmp_path) == []


# ---------------------------------------------------------------------------
# print_fallback_rebuild_cta
# ---------------------------------------------------------------------------

class TestFallbackRebuildCta:
    """Unit tests for the outdated-plugin rebuild CTA."""

    def test_cta_upstream_lists_fallbacks_without_midstream_steps(self, capsys):
        with patch("generatePluginBuildInfo._in_midstream_repo", return_value=False), \
             patch("generatePluginBuildInfo.fetch_rhdh_package_version") as fetch_version:
            generatePluginBuildInfo.print_fallback_rebuild_cta(
                [
                    ("backstage-community-plugin-topology", "2.0--1.5.4", "2.0--1.6.0", "topology"),
                    ("backstage-plugin-kubernetes", "2.0--1.5.4", "2.0--1.6.0", "kubernetes"),
                ]
            )
        out = capsys.readouterr().out
        assert "backstage-community-plugin-topology" in out
        assert "backstage-plugin-kubernetes" in out
        assert "2.0--1.5.4" in out
        assert "2.0--1.6.0" in out
        assert "(container, have_tag, requested_tag)" in out
        assert "have_older_tag" not in out
        assert "should_have_newer_tag" not in out
        # Midstream-only guidance must not appear from the upstream overlays repo.
        assert "sync-midstream.sh" not in out
        assert "generatePipelineRunsForPlugins.sh" not in out
        assert "./build/ci/update-index.sh" not in out
        fetch_version.assert_not_called()

    def test_cta_includes_midstream_steps_when_in_midstream(self, capsys, tmp_path):
        with patch("generatePluginBuildInfo.current_midstream_branch", return_value="main"), \
             patch("generatePluginBuildInfo.fetch_rhdh_package_version", return_value="2.0.0"), \
             patch("generatePluginBuildInfo._in_midstream_repo", return_value=True):
            generatePluginBuildInfo.print_fallback_rebuild_cta(
                [
                    (
                        "red-hat-developer-hub-backstage-plugin-catalog-backend-module-extensions",
                        "2.0.0--0.19.0",
                        "2.0.0--0.19.1",
                        "extensions",
                    ),
                ],
                repo_root=tmp_path,
            )
        out = capsys.readouterr().out
        assert "sync-midstream.sh --force-clone 'extensions' --yes" in out
        assert "-p 'red-hat-developer-hub-backstage-plugin-catalog-backend-module-extensions$'" in out
        assert "-v 2.0.0 --next" in out
        assert "./build/ci/update-index.sh" in out

    def test_cta_uses_package_version_on_release_branch(self, capsys, tmp_path):
        with patch("generatePluginBuildInfo.current_midstream_branch", return_value="rhdh-1.10-rhel-9"), \
             patch("generatePluginBuildInfo.fetch_rhdh_package_version", return_value="1.10.3"), \
             patch("generatePluginBuildInfo._in_midstream_repo", return_value=True):
            generatePluginBuildInfo.print_fallback_rebuild_cta(
                [("backstage-community-plugin-topology", "1.10--1.5.4", "1.10--1.6.0", "topology")],
                repo_root=tmp_path,
            )
        out = capsys.readouterr().out
        assert "-p 'backstage-community-plugin-topology$'" in out
        assert "-v 1.10.3" in out
        assert "--next" not in out
        assert "sync-midstream.sh --force-clone 'topology' --yes" in out
        assert "./build/ci/update-index.sh" in out

    def test_cta_uses_release_version_without_next_on_release_branch(self, capsys, tmp_path):
        with patch("generatePluginBuildInfo.current_midstream_branch", return_value="release-2.1"), \
             patch("generatePluginBuildInfo.fetch_rhdh_package_version", return_value="2.1.0") as fetch_version, \
             patch("generatePluginBuildInfo._in_midstream_repo", return_value=True):
            generatePluginBuildInfo.print_fallback_rebuild_cta(
                [("backstage-community-plugin-topology", "2.1.0--1.5.4", "2.1.0--1.6.0", "topology")],
                repo_root=tmp_path,
            )
        out = capsys.readouterr().out
        assert "-p 'backstage-community-plugin-topology$'" in out
        assert "-v 2.1.0" in out
        assert "--next" not in out
        fetch_version.assert_called_once_with("release-2.1")

    def test_cta_skips_sync_when_package_json_already_matches(self, capsys, tmp_path):
        orchestrator = tmp_path / "workspaces" / "orchestrator" / "plugins" / "orchestrator"
        widgets = tmp_path / "workspaces" / "orchestrator" / "plugins" / "orchestrator-form-widgets"
        nested = tmp_path / "workspaces" / "orchestrator" / "node_modules" / "old"
        orchestrator.mkdir(parents=True)
        widgets.mkdir(parents=True)
        nested.mkdir(parents=True)
        (orchestrator / "package.json").write_text('{"version": "6.2.5"}\n')
        (widgets / "package.json").write_text('{"version": "2.2.2"}\n')
        (nested / "package.json").write_text('{"version": "0.0.1"}\n')
        with patch("generatePluginBuildInfo._in_midstream_repo", return_value=True), \
             patch("generatePluginBuildInfo.fetch_rhdh_package_version") as fetch_version:
            generatePluginBuildInfo.print_fallback_rebuild_cta(
                [
                    (
                        "red-hat-developer-hub-backstage-plugin-orchestrator",
                        "2.2.0--6.2.4",
                        "2.2.0--6.2.5",
                        "orchestrator",
                    ),
                    (
                        "red-hat-developer-hub-backstage-plugin-orchestrator-form-widgets",
                        "2.2.0--2.2.1",
                        "2.2.0--2.2.2",
                        "orchestrator",
                    ),
                ],
                repo_root=tmp_path,
            )
        out = capsys.readouterr().out
        assert "No midstream sync is required" in out
        assert "sync-midstream.sh" not in out
        assert "updatePLRs.sh" not in out
        assert "./build/ci/update-index.sh" not in out
        fetch_version.assert_not_called()

    def test_cta_syncs_only_the_workspace_missing_the_requested_version(self, capsys, tmp_path):
        ready = tmp_path / "workspaces" / "orchestrator" / "plugins" / "orchestrator"
        ready.mkdir(parents=True)
        (ready / "package.json").write_text('{"version": "6.2.5"}\n')
        with patch("generatePluginBuildInfo.current_midstream_branch", return_value="main"), \
             patch("generatePluginBuildInfo.fetch_rhdh_package_version", return_value="2.2.0"), \
             patch("generatePluginBuildInfo._in_midstream_repo", return_value=True):
            generatePluginBuildInfo.print_fallback_rebuild_cta(
                [
                    (
                        "red-hat-developer-hub-backstage-plugin-orchestrator",
                        "2.2.0--6.2.4",
                        "2.2.0--6.2.5",
                        "orchestrator",
                    ),
                    (
                        "backstage-community-plugin-topology",
                        "2.2.0--1.5.4",
                        "2.2.0--1.6.0",
                        "topology",
                    ),
                ],
                repo_root=tmp_path,
            )
        out = capsys.readouterr().out
        assert "sync-midstream.sh --force-clone 'topology' --yes" in out
        assert "orchestrator" not in out.split("sync-midstream.sh", 1)[1].split("\n", 1)[0]
        assert "-p 'backstage-community-plugin-topology$'" in out
        assert "-v 2.2.0 --next" in out
        assert "red-hat-developer-hub-backstage-plugin-orchestrator|" not in out
        assert "without a sync" in out

    def test_node_modules_version_does_not_count_as_synced(self, tmp_path):
        nested = tmp_path / "workspaces" / "orchestrator" / "node_modules" / "orchestrator"
        nested.mkdir(parents=True)
        (nested / "package.json").write_text('{"version": "6.2.5"}\n')
        ready, manual, stale = generatePluginBuildInfo.split_fallback_rebuild(
            [("plugin", "2.2.0--6.2.4", "2.2.0--6.2.5", "orchestrator")],
            tmp_path,
        )
        assert ready == []
        assert manual == ["plugin"]
        assert stale == {"orchestrator"}


class TestRecordImageMetadataReport:
    def test_flags_missing_dynamic_packages_annotation(self, tmp_path):
        report = BuildReport(str(tmp_path / "report.json"))
        data = {
            "plugin-a": {
                "digest": "sha256:abc",
                "registryReference": "quay.io/rhdh/plugin-a:1.10--1.0.0",
            }
        }
        generatePluginBuildInfo._record_image_metadata_report(report, data)
        stage = report.get_stage("plugin-a", "image-metadata-fetch")
        assert stage is not None
        assert stage.get("missing_dynamic_packages_annotation") is True


class TestRhdhBranchAndVersion:
    """Unit tests for midstream → rhdh branch mapping and version fetch."""

    @pytest.mark.parametrize(
        "midstream, expected",
        [
            ("main", "main"),
            ("release-2.1", "release-2.1"),
            ("release-1.10", "release-1.10"),
            ("rhdh-1.10-rhel-9", "release-1.10"),
            ("rhdh-1.9-rhel-9", "release-1.9"),
            ("feature/foo", "main"),
            ("", "main"),
        ],
    )
    def test_rhdh_git_branch_for_midstream(self, midstream, expected):
        assert generatePluginBuildInfo.rhdh_git_branch_for_midstream(midstream) == expected

    def test_fetch_rhdh_package_version(self):
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json.return_value = {"version": "1.10.3"}
        with patch("generatePluginBuildInfo.requests.get", return_value=mock_resp) as mock_get:
            assert generatePluginBuildInfo.fetch_rhdh_package_version("release-1.10") == "1.10.3"
            mock_get.assert_called_once()
            assert "release-1.10" in mock_get.call_args.args[0]


# ---------------------------------------------------------------------------
# update_plugin_build_files — metadata sync vs plugin_builds modified gate
# ---------------------------------------------------------------------------

_TEST_PLUGIN = "test-plugin"
_TEST_REF = "registry.access.redhat.com/rhdh/test-plugin:1.10--1.0.0"
_TEST_DIGEST = "sha256:" + "a" * 64
_TEST_BUILD_DATE = "2026-01-01T00:00:00Z"


def _stable_image_metadata():
    return {
        "digest": _TEST_DIGEST,
        "registryReference": _TEST_REF,
        "build-date": _TEST_BUILD_DATE,
    }


def _write_plugin_build_fixtures(tmp_path):
    plugin_builds_dir = tmp_path / "plugin_builds" / "lightspeed"
    plugin_builds_dir.mkdir(parents=True)
    json_path = plugin_builds_dir / f"{_TEST_PLUGIN}.json"
    json_path.write_text(
        json.dumps(
            {
                _TEST_PLUGIN: {
                    "workspacePath": "lightspeed/plugins/test",
                    "registryReference": _TEST_REF,
                    "digest": _TEST_DIGEST,
                    "build-date": _TEST_BUILD_DATE,
                }
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    metadata_dir = tmp_path / "workspaces" / "lightspeed" / "metadata"
    metadata_dir.mkdir(parents=True)
    return json_path, metadata_dir


def _metadata_yaml_body(dynamic_artifact: str) -> str:
    return f"""apiVersion: extensions.backstage.io/v1alpha1
kind: Package
metadata:
  name: {_TEST_PLUGIN}
spec:
  packageName: "@example/test-plugin"
  dynamicArtifact: {dynamic_artifact}
  version: 1.0.0
"""


class TestUpdatePluginBuildFiles:
    @pytest.fixture(autouse=True)
    def _rarc_registry(self, monkeypatch):
        monkeypatch.setattr(
            generatePluginBuildInfo,
            "REGISTRY_BASE",
            "registry.access.redhat.com/rhdh",
        )

    @patch("generatePluginBuildInfo.get_image_metadata")
    def test_metadata_yaml_resolved_even_when_registry_reference_unchanged(
        self, mock_get_metadata, tmp_path
    ):
        mock_get_metadata.return_value = _stable_image_metadata()
        json_path, metadata_dir = _write_plugin_build_fixtures(tmp_path)
        meta_path = metadata_dir / f"{_TEST_PLUGIN}.yaml"
        meta_path.write_text(
            _metadata_yaml_body(
                'oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/'
                f"{_TEST_PLUGIN}:bs_1.49.4__1.0.0!{_TEST_PLUGIN}"
            ),
            encoding="utf-8",
        )
        original_json = json_path.read_text(encoding="utf-8")

        updated_count, _, _, overlays_metadata_changes, _, _ = (
            generatePluginBuildInfo.update_plugin_build_files(
                tmp_path / "plugin_builds",
                tmp_path,
                None,
            )
        )

        assert updated_count == 0
        assert json_path.read_text(encoding="utf-8") == original_json
        assert overlays_metadata_changes == 1
        resolved = (
            f"oci://registry.access.redhat.com/rhdh/{_TEST_PLUGIN}@{_TEST_DIGEST}"
        )
        assert resolved in meta_path.read_text(encoding="utf-8")
        assert "ghcr.io" not in meta_path.read_text(encoding="utf-8")

    @patch("generatePluginBuildInfo.get_image_metadata")
    def test_report_stage_marked_pass_when_unchanged(self, mock_get_metadata, tmp_path):
        mock_get_metadata.return_value = _stable_image_metadata()
        _write_plugin_build_fixtures(tmp_path)
        metadata_dir = tmp_path / "workspaces" / "lightspeed" / "metadata"
        metadata_dir.joinpath(f"{_TEST_PLUGIN}.yaml").write_text(
            _metadata_yaml_body(
                'oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/'
                f"{_TEST_PLUGIN}:bs_1.49.4__1.0.0!{_TEST_PLUGIN}"
            ),
            encoding="utf-8",
        )
        report_path = tmp_path / "build-report.json"
        report = BuildReport(str(report_path))
        report.add_plugin(_TEST_PLUGIN)
        report.set_stage(
            _TEST_PLUGIN,
            "bootstrap",
            "pass",
            oci_ref="ghcr.io/placeholder",
        )

        generatePluginBuildInfo.update_plugin_build_files(
            tmp_path / "plugin_builds",
            tmp_path,
            report,
        )

        stage = report.get_stage(_TEST_PLUGIN, "image-metadata-fetch")
        assert stage is not None
        assert stage["status"] == "pass"
        assert stage["digest"] == _TEST_DIGEST
        bootstrap = report.get_stage(_TEST_PLUGIN, "bootstrap")
        assert bootstrap["oci_ref"] == _TEST_REF

    @patch("generatePluginBuildInfo.get_image_metadata")
    def test_metadata_yaml_not_rewritten_when_already_correct(
        self, mock_get_metadata, tmp_path
    ):
        mock_get_metadata.return_value = _stable_image_metadata()
        _, metadata_dir = _write_plugin_build_fixtures(tmp_path)
        resolved_oci = (
            f"oci://registry.access.redhat.com/rhdh/{_TEST_PLUGIN}@{_TEST_DIGEST}"
        )
        meta_path = metadata_dir / f"{_TEST_PLUGIN}.yaml"
        meta_path.write_text(
            f"""apiVersion: extensions.backstage.io/v1alpha1
kind: Package
metadata:
  name: {_TEST_PLUGIN}
spec:
  packageName: "@example/test-plugin"
  # Tag: 1.10--1.0.0, Build date: {_TEST_BUILD_DATE}
  dynamicArtifact: "{resolved_oci}"
  version: 1.0.0
""",
            encoding="utf-8",
        )
        original_meta = meta_path.read_text(encoding="utf-8")

        _, _, _, overlays_metadata_changes, _, _ = (
            generatePluginBuildInfo.update_plugin_build_files(
                tmp_path / "plugin_builds",
                tmp_path,
                None,
            )
        )

        assert overlays_metadata_changes == 0
        assert meta_path.read_text(encoding="utf-8") == original_meta

    @patch("generatePluginBuildInfo.get_image_metadata")
    def test_plugin_builds_json_untouched_when_unchanged(
        self, mock_get_metadata, tmp_path
    ):
        mock_get_metadata.return_value = _stable_image_metadata()
        json_path, metadata_dir = _write_plugin_build_fixtures(tmp_path)
        metadata_dir.joinpath(f"{_TEST_PLUGIN}.yaml").write_text(
            _metadata_yaml_body(
                'oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/'
                f"{_TEST_PLUGIN}:bs_1.49.4__1.0.0!{_TEST_PLUGIN}"
            ),
            encoding="utf-8",
        )
        before_mtime = json_path.stat().st_mtime_ns
        original_json = json_path.read_text(encoding="utf-8")

        updated_count, _, _, _, _, _ = generatePluginBuildInfo.update_plugin_build_files(
            tmp_path / "plugin_builds",
            tmp_path,
            None,
        )

        assert updated_count == 0
        assert json_path.read_text(encoding="utf-8") == original_json
        assert json_path.stat().st_mtime_ns == before_mtime


# ---------------------------------------------------------------------------
# decode_dynamic_packages / empty-annotation detection
# ---------------------------------------------------------------------------


def _b64(payload: bytes) -> str:
    return base64.b64encode(payload).decode()


class TestDecodeDynamicPackages:
    """The annotation is base64-encoded JSON; an empty list is RHDHBUGS-3556."""

    def test_decodes_a_real_package_list(self):
        packages = generatePluginBuildInfo.decode_dynamic_packages(
            _b64(json.dumps([{"plugin-a": {"name": "@scope/plugin-a"}}]).encode())
        )
        assert packages == [{"plugin-a": {"name": "@scope/plugin-a"}}]

    @pytest.mark.parametrize("annotation", ["", None])
    def test_absent_annotation_decodes_to_nothing_declared(self, annotation):
        assert generatePluginBuildInfo.decode_dynamic_packages(annotation) == []

    def test_an_explicitly_empty_list_decodes_to_empty(self):
        # [] means "declares nothing", None means "could not be read". Collapsing the
        # two would report a broken artifact as an empty one, or the reverse.
        assert generatePluginBuildInfo.decode_dynamic_packages(_b64(b"[]")) == []

    @pytest.mark.parametrize(
        "wrap",
        [
            lambda p: base64.encodebytes(p).decode(),
            lambda p: base64.b64encode(p).decode() + "\n",
            lambda p: " " + base64.b64encode(p).decode() + " ",
        ],
        ids=["mime-wrapped", "trailing-newline", "surrounding-spaces"],
    )
    def test_whitespace_in_the_annotation_is_not_malformed(self, wrap):
        # `base64` without `-w 0` wraps its output. A healthy artifact whose
        # annotation carries a newline must not be reported as broken.
        payload = json.dumps([{"plugin-a": {"name": "@scope/plugin-a"}}]).encode()
        assert generatePluginBuildInfo.decode_dynamic_packages(wrap(payload)) == [
            {"plugin-a": {"name": "@scope/plugin-a"}}
        ]

    def test_an_annotation_that_was_never_encoded_is_undecodable(self):
        # Stripping whitespace must not soften the check into accepting raw JSON.
        assert (
            generatePluginBuildInfo.decode_dynamic_packages('[{"a": 1}]') is None
        )

    @pytest.mark.parametrize(
        "annotation",
        [
            "!!!not-base64!!!",
            _b64(b"not json at all"),
            _b64(b'{"packages": []}'),  # an object, not the expected list
        ],
        ids=["not-base64", "not-json", "not-a-list"],
    )
    def test_undecodable_annotation_returns_none(self, annotation):
        assert generatePluginBuildInfo.decode_dynamic_packages(annotation) is None


class TestDynamicPackagesAnnotationReporting:
    """What _fetch_image_metadata reports for each shape of the annotation."""

    REF = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/plugin-x:bs_1.52.0__1.0.0"

    def _fetch_with_annotations(self, annotations):
        manifest = {
            "config": {"digest": "sha256:" + "0" * 64},
            "annotations": annotations,
        }
        manifest_response = MagicMock(
            status_code=200,
            json=MagicMock(return_value=manifest),
            headers={"Docker-Content-Digest": "sha256:" + "1" * 64},
        )
        blob_response = MagicMock(status_code=404)
        # get_registry_auth issues its own token request for ghcr.io; without stubbing it
        # the first queued response is consumed there and the manifest never arrives.
        with patch.object(
            generatePluginBuildInfo, "get_registry_auth", return_value=(None, {})
        ), patch.object(
            generatePluginBuildInfo.requests,
            "get",
            side_effect=[manifest_response, blob_response],
        ), patch.object(generatePluginBuildInfo, "log_warn") as warn:
            generatePluginBuildInfo._fetch_image_metadata(self.REF)
        return [call.args[0] for call in warn.call_args_list]

    def test_empty_annotation_is_reported_with_the_artifact_named(self):
        warnings = self._fetch_with_annotations(
            {generatePluginBuildInfo.DYNAMIC_PACKAGES_ANNOTATION: _b64(b"[]")}
        )
        assert any(
            "plugin-x:bs_1.52.0__1.0.0" in w and "empty" in w and "no-op" in w
            for w in warnings
        ), warnings

    def test_malformed_annotation_is_reported_as_malformed_not_empty(self):
        warnings = self._fetch_with_annotations(
            {generatePluginBuildInfo.DYNAMIC_PACKAGES_ANNOTATION: "!!!not-base64!!!"}
        )
        assert any(
            "plugin-x:bs_1.52.0__1.0.0" in w and "malformed" in w for w in warnings
        ), warnings
        assert not any("declares an empty" in w for w in warnings), warnings

    def test_a_populated_annotation_is_not_reported(self):
        warnings = self._fetch_with_annotations(
            {
                generatePluginBuildInfo.DYNAMIC_PACKAGES_ANNOTATION: _b64(
                    json.dumps([{"plugin-x": {"name": "@scope/plugin-x"}}]).encode()
                )
            }
        )
        assert not any("dynamic-packages" in w for w in warnings), warnings

    def test_an_image_without_the_annotation_is_not_reported(self):
        # Not every image publishes one; warning on its absence would fire on all of them.
        warnings = self._fetch_with_annotations({})
        assert not any("dynamic-packages" in w for w in warnings), warnings


class TestDynamicPackagesInBuildReport:
    """The image-metadata-fetch stage must not read green for an empty artifact."""

    @staticmethod
    def _stage(annotation, tmp_path):
        report = BuildReport(tmp_path / "build-report.json")
        data = {
            "plugin-x": {
                "digest": "sha256:" + "0" * 64,
                **(
                    {generatePluginBuildInfo.DYNAMIC_PACKAGES_ANNOTATION: annotation}
                    if annotation is not None
                    else {}
                ),
            }
        }
        generatePluginBuildInfo._record_image_metadata_report(report, data)
        return report.get_stage("plugin-x", "image-metadata-fetch")

    def test_an_empty_annotation_is_recorded_on_the_stage(self, tmp_path):
        # Without this the stage is a bare pass and build-report.json contradicts the
        # warning the fetch already logged.
        stage = self._stage(_b64(b"[]"), tmp_path)
        assert stage["status"] == "pass"
        assert stage["dynamicPackages"] == 0

    def test_an_unreadable_annotation_is_recorded_as_unreadable(self, tmp_path):
        stage = self._stage("!!!not-base64!!!", tmp_path)
        assert stage["dynamicPackagesUnreadable"] is True
        assert "dynamicPackages" not in stage

    def test_a_populated_annotation_adds_no_detail(self, tmp_path):
        stage = self._stage(
            _b64(json.dumps([{"plugin-x": {"name": "@scope/plugin-x"}}]).encode()),
            tmp_path,
        )
        assert "dynamicPackages" not in stage
        assert "dynamicPackagesUnreadable" not in stage

    def test_an_image_without_the_annotation_adds_no_detail(self, tmp_path):
        stage = self._stage(None, tmp_path)
        assert "dynamicPackages" not in stage
        assert "dynamicPackagesUnreadable" not in stage
