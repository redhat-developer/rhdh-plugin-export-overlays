"""Tests for pure-logic functions in generateCatalogIndex.py."""

import pytest

from generateCatalogIndex import (
    build_digest_comment_map,
    digest_from_oci_package_line,
    get_image_name_from_package_yaml,
    get_query_registry_reference,
    is_tag_comment_line,
    parse_image_reference,
    peek_digest_after,
    pop_trailing_tag_comments,
    tag_comment_for_plugin,
    trailing_tag_comment_matches,
)


# ---------------------------------------------------------------------------
# parse_image_reference
# ---------------------------------------------------------------------------
class TestParseImageReference:
    @pytest.mark.parametrize(
        "ref, expected",
        [
            pytest.param(
                "quay.io/rhdh/plugin:1.11--1.5.4",
                ("quay.io/rhdh/plugin", "1.11--1.5.4", ""),
                id="tag_only",
            ),
            pytest.param(
                "quay.io/rhdh/plugin@sha256:abc123",
                ("quay.io/rhdh/plugin", "", "sha256:abc123"),
                id="digest_only",
            ),
            pytest.param(
                "quay.io/rhdh/plugin:1.11--1.5.4@sha256:abc123",
                ("quay.io/rhdh/plugin", "1.11--1.5.4", "sha256:abc123"),
                id="tag_and_digest",
            ),
            pytest.param(
                "",
                ("", "", ""),
                id="empty_string",
            ),
            pytest.param(
                "quay.io/rhdh/plugin",
                ("quay.io/rhdh/plugin", "", ""),
                id="no_tag_no_digest",
            ),
        ],
    )
    def test_parse(self, ref, expected):
        assert parse_image_reference(ref) == expected


# ---------------------------------------------------------------------------
# tag_comment_for_plugin
# ---------------------------------------------------------------------------
class TestTagCommentForPlugin:
    def test_all_fields_present(self):
        data = {
            "build-date": "2025-05-01",
            "imageTag": "1.11--1.5.4",
            "registryReference": "quay.io/rhdh/plugin:1.11--1.5.4@sha256:abc123",
        }
        assert tag_comment_for_plugin(data) == "# Tag: 1.11--1.5.4, Build date: 2025-05-01"

    def test_tag_from_registry_reference_fallback(self):
        data = {
            "build-date": "2025-05-01",
            "registryReference": "quay.io/rhdh/plugin:1.11--1.5.4@sha256:abc123",
        }
        assert tag_comment_for_plugin(data) == "# Tag: 1.11--1.5.4, Build date: 2025-05-01"

    def test_missing_build_date_returns_none(self):
        data = {
            "imageTag": "1.11--1.5.4",
            "registryReference": "quay.io/rhdh/plugin:1.11--1.5.4@sha256:abc123",
        }
        assert tag_comment_for_plugin(data) is None

    def test_missing_digest_returns_none(self):
        data = {
            "build-date": "2025-05-01",
            "imageTag": "1.11--1.5.4",
            "registryReference": "quay.io/rhdh/plugin:1.11--1.5.4",
        }
        assert tag_comment_for_plugin(data) is None


# ---------------------------------------------------------------------------
# build_digest_comment_map
# ---------------------------------------------------------------------------
class TestBuildDigestCommentMap:
    def test_two_plugins(self):
        index_data = {
            "plugin-a": {
                "registryReference": "quay.io/rhdh/plugin-a@sha256:aaa111",
                "imageTag": "1.11--1.0.0",
                "build-date": "2025-05-01",
            },
            "plugin-b": {
                "registryReference": "quay.io/rhdh/plugin-b@sha256:bbb222",
                "imageTag": "1.11--2.0.0",
                "build-date": "2025-05-02",
            },
        }
        result = build_digest_comment_map(index_data)
        assert result == {
            "sha256:aaa111": "# Tag: 1.11--1.0.0, Build date: 2025-05-01",
            "sha256:bbb222": "# Tag: 1.11--2.0.0, Build date: 2025-05-02",
        }

    def test_skips_entries_without_digest(self):
        index_data = {
            "plugin-no-digest": {
                "registryReference": "quay.io/rhdh/plugin:1.11--1.0.0",
                "imageTag": "1.11--1.0.0",
                "build-date": "2025-05-01",
            },
        }
        assert build_digest_comment_map(index_data) == {}


# ---------------------------------------------------------------------------
# is_tag_comment_line
# ---------------------------------------------------------------------------
class TestIsTagCommentLine:
    @pytest.mark.parametrize(
        "line, expected",
        [
            pytest.param(
                "  # Tag: 1.11--1.5.4, Build date: 2025-05-01",
                True,
                id="valid_tag_comment",
            ),
            pytest.param(
                "  # Some other comment",
                False,
                id="other_comment",
            ),
            pytest.param(
                "  - package: oci://quay.io/rhdh/plugin@sha256:abc",
                False,
                id="package_line",
            ),
        ],
    )
    def test_is_tag_comment(self, line, expected):
        assert is_tag_comment_line(line) == expected


# ---------------------------------------------------------------------------
# pop_trailing_tag_comments
# ---------------------------------------------------------------------------
class TestPopTrailingTagComments:
    def test_removes_trailing_tag_comment(self):
        lines = [
            "  - package: oci://quay.io/rhdh/plugin@sha256:abc\n",
            "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n",
        ]
        pop_trailing_tag_comments(lines)
        assert lines == ["  - package: oci://quay.io/rhdh/plugin@sha256:abc\n"]

    def test_no_change_for_non_tag_trailing(self):
        lines = [
            "  - package: oci://quay.io/rhdh/plugin@sha256:abc\n",
            "  some-key: value\n",
        ]
        original = list(lines)
        pop_trailing_tag_comments(lines)
        assert lines == original

    def test_removes_multiple_trailing_tag_comments(self):
        lines = [
            "  - package: oci://quay.io/rhdh/plugin@sha256:abc\n",
            "  # Tag: 1.11--1.0.0, Build date: 2025-05-01\n",
            "  # Tag: 1.11--2.0.0, Build date: 2025-05-02\n",
        ]
        pop_trailing_tag_comments(lines)
        assert lines == ["  - package: oci://quay.io/rhdh/plugin@sha256:abc\n"]


# ---------------------------------------------------------------------------
# trailing_tag_comment_matches
# ---------------------------------------------------------------------------
class TestTrailingTagCommentMatches:
    def test_matches(self):
        lines = [
            "  - package: oci://quay.io/rhdh/plugin@sha256:abc\n",
            "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n",
        ]
        assert trailing_tag_comment_matches(lines, "# Tag: 1.11--1.5.4, Build date: 2025-05-01") is True

    def test_does_not_match(self):
        lines = [
            "  - package: oci://quay.io/rhdh/plugin@sha256:abc\n",
            "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n",
        ]
        assert trailing_tag_comment_matches(lines, "# Tag: 9.99--9.9.9, Build date: 2099-01-01") is False

    def test_none_expected_returns_false(self):
        lines = [
            "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n",
        ]
        assert trailing_tag_comment_matches(lines, None) is False


# ---------------------------------------------------------------------------
# digest_from_oci_package_line
# ---------------------------------------------------------------------------
class TestDigestFromOciPackageLine:
    @pytest.mark.parametrize(
        "line, expected",
        [
            pytest.param(
                "  - package: oci://quay.io/rhdh/plugin@sha256:abc123",
                "sha256:abc123",
                id="active_line",
            ),
            pytest.param(
                "  # - package: oci://quay.io/rhdh/plugin@sha256:abc123",
                "sha256:abc123",
                id="commented_line",
            ),
            pytest.param(
                "  - package: ./dynamic-plugins/dist/foo",
                None,
                id="non_oci_line",
            ),
        ],
    )
    def test_digest_extraction(self, line, expected):
        assert digest_from_oci_package_line(line) == expected


# ---------------------------------------------------------------------------
# peek_digest_after
# ---------------------------------------------------------------------------
class TestPeekDigestAfter:
    def test_next_line_has_digest(self):
        lines = [
            "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n",
            "  - package: oci://quay.io/rhdh/plugin@sha256:abc123\n",
        ]
        assert peek_digest_after(lines, 0) == "sha256:abc123"

    def test_skips_blanks_and_tag_comments(self):
        lines = [
            "  some: line\n",
            "\n",
            "  # Tag: old, Build date: 2025-01-01\n",
            "  - package: oci://quay.io/rhdh/plugin@sha256:def456\n",
        ]
        assert peek_digest_after(lines, 0) == "sha256:def456"

    def test_no_digest_found(self):
        lines = [
            "  some: line\n",
            "  another: line\n",
        ]
        assert peek_digest_after(lines, 0) is None

    def test_past_end_of_list(self):
        lines = [
            "  some: line\n",
        ]
        assert peek_digest_after(lines, 0) is None


# ---------------------------------------------------------------------------
# get_query_registry_reference
# ---------------------------------------------------------------------------
class TestGetQueryRegistryReference:
    @pytest.mark.parametrize(
        "ref, expected",
        [
            pytest.param(
                "registry.access.redhat.com/rhdh/plugin:1.11--1.5.4",
                "quay.io/rhdh/plugin:1.11--1.5.4",
                id="rarc_to_quay",
            ),
            pytest.param(
                "quay.io/rhdh/plugin:1.11--1.5.4",
                "quay.io/rhdh/plugin:1.11--1.5.4",
                id="quay_passthrough",
            ),
            pytest.param(
                "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/plugin:bs_1.49.4__2.18.0",
                "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/plugin:bs_1.49.4__2.18.0",
                id="ghcr_passthrough",
            ),
        ],
    )
    def test_query_ref(self, ref, expected):
        assert get_query_registry_reference(ref) == expected


# ---------------------------------------------------------------------------
# get_image_name_from_package_yaml
# ---------------------------------------------------------------------------
class TestGetImageNameFromPackageYaml:
    def test_with_package_name(self, sample_package_yaml):
        result = get_image_name_from_package_yaml(sample_package_yaml)
        assert result == "backstage-plugin-catalog-backend-module-github"

    def test_fallback_to_metadata_name(self, tmp_path):
        content = """\
apiVersion: extensions.backstage.io/v1alpha1
kind: Package
metadata:
  namespace: rhdh
  name: my-custom-plugin
spec:
  version: "1.0.0"
"""
        yaml_file = tmp_path / "my-custom-plugin.yaml"
        yaml_file.write_text(content)
        result = get_image_name_from_package_yaml(yaml_file)
        assert result == "my-custom-plugin"

    def test_nonexistent_file_returns_stem(self, tmp_path):
        missing = tmp_path / "nonexistent-plugin.yaml"
        result = get_image_name_from_package_yaml(missing)
        assert result == "nonexistent-plugin"
