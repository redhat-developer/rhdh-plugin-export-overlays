"""Tests for injectDpdyTagComments.py — tag comment injection into dynamic-plugins.default.yaml."""

import json

import pytest

import injectDpdyTagComments


# ---------------------------------------------------------------------------
# keys_for_package
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "pkg, expected",
    [
        pytest.param(
            "rhdh-backstage-plugin-foo-dynamic",
            [
                "rhdh-backstage-plugin-foo-dynamic",
                "rhdh-backstage-plugin-foo",
                "red-hat-developer-hub-backstage-plugin-foo-dynamic",
            ],
            id="rhdh-prefix-and-dynamic-suffix",
        ),
        pytest.param(
            "rhdh-backstage-plugin-foo",
            [
                "rhdh-backstage-plugin-foo",
                "red-hat-developer-hub-backstage-plugin-foo",
            ],
            id="rhdh-prefix-no-dynamic",
        ),
        pytest.param(
            "backstage-community-plugin-bar",
            [
                "backstage-community-plugin-bar",
            ],
            id="no-rhdh-prefix-no-dynamic",
        ),
        pytest.param(
            "backstage-community-plugin-bar-dynamic",
            [
                "backstage-community-plugin-bar-dynamic",
                "backstage-community-plugin-bar",
            ],
            id="no-rhdh-prefix-with-dynamic",
        ),
    ],
)
def test_keys_for_package(pkg, expected):
    assert injectDpdyTagComments.keys_for_package(pkg) == expected


# ---------------------------------------------------------------------------
# package_name_from_oci_comment
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "line, expected",
    [
        pytest.param(
            "  # - package: oci://quay.io/rhdh/red-hat-developer-hub-backstage-plugin-foo@sha256:abc",
            "red-hat-developer-hub-backstage-plugin-foo",
            id="quay-oci-comment",
        ),
        pytest.param(
            "  # - package: oci://ghcr.io/org/repo/plugin-bar@sha256:def",
            "plugin-bar",
            id="ghcr-oci-comment-nested-path",
        ),
        pytest.param(
            "  - package: ./dynamic-plugins/dist/foo",
            None,
            id="local-path-not-oci-comment",
        ),
        pytest.param(
            "some random line",
            None,
            id="random-line",
        ),
    ],
)
def test_package_name_from_oci_comment(line, expected):
    assert injectDpdyTagComments.package_name_from_oci_comment(line) == expected


# ---------------------------------------------------------------------------
# package_name_from_package_value
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "val, expected",
    [
        pytest.param(
            "./dynamic-plugins/dist/rhdh-backstage-plugin-foo-dynamic",
            "rhdh-backstage-plugin-foo-dynamic",
            id="local-path",
        ),
        pytest.param(
            "oci://quay.io/rhdh/plugin-bar@sha256:abc",
            "plugin-bar",
            id="oci-reference",
        ),
        pytest.param(
            "simple-name",
            "simple-name",
            id="bare-name",
        ),
    ],
)
def test_package_name_from_package_value(val, expected):
    assert injectDpdyTagComments.package_name_from_package_value(val) == expected


# ---------------------------------------------------------------------------
# comment_for_package
# ---------------------------------------------------------------------------

class TestCommentForPackage:
    TAG_BY_KEY = {
        "red-hat-developer-hub-backstage-plugin-foo": ("1.11--1.5.4", "2025-05-01"),
        "rhdh-backstage-plugin-foo": ("1.11--1.5.4", "2025-05-01"),
    }

    def test_direct_match(self):
        result = injectDpdyTagComments.comment_for_package(
            "red-hat-developer-hub-backstage-plugin-foo", self.TAG_BY_KEY
        )
        assert result == "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n"

    def test_match_via_alias_expansion(self):
        """rhdh- prefix is expanded to red-hat-developer-hub- for lookup."""
        tag_by_key = {
            "red-hat-developer-hub-backstage-plugin-foo": ("1.11--1.5.4", "2025-05-01"),
        }
        result = injectDpdyTagComments.comment_for_package(
            "rhdh-backstage-plugin-foo", tag_by_key
        )
        assert result == "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n"

    def test_match_via_dynamic_strip(self):
        """Stripping -dynamic suffix finds the base name in tag_by_key."""
        tag_by_key = {
            "rhdh-backstage-plugin-foo": ("1.11--1.5.4", "2025-05-01"),
        }
        result = injectDpdyTagComments.comment_for_package(
            "rhdh-backstage-plugin-foo-dynamic", tag_by_key
        )
        assert result == "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n"

    def test_no_match(self):
        result = injectDpdyTagComments.comment_for_package(
            "unknown-plugin", self.TAG_BY_KEY
        )
        assert result is None


# ---------------------------------------------------------------------------
# recent_has_tag
# ---------------------------------------------------------------------------

class TestRecentHasTag:
    def test_tag_comment_is_last_line(self):
        result = [
            "  - package: foo\n",
            "  # Tag: 1.0, Build date: 2025\n",
        ]
        assert injectDpdyTagComments.recent_has_tag(result) is True

    def test_no_tag_comment_last_is_package(self):
        result = ["  - package: foo\n"]
        assert injectDpdyTagComments.recent_has_tag(result) is False

    def test_empty_list(self):
        assert injectDpdyTagComments.recent_has_tag([]) is False

    def test_tag_comment_before_non_package_lines(self):
        """Non-package, non-tag lines between the tag comment and current position."""
        result = [
            "  - package: foo\n",
            "  # Tag: 1.0, Build date: 2025\n",
            "    pluginConfig:\n",
            "      key: value\n",
        ]
        assert injectDpdyTagComments.recent_has_tag(result) is True

    def test_tag_belongs_to_earlier_package(self):
        """A tag comment followed by another package line means the tag is not recent."""
        result = [
            "  # Tag: 1.0, Build date: 2025\n",
            "  - package: earlier\n",
            "    pluginConfig:\n",
        ]
        # Reverse iteration hits pluginConfig (skip), then "- package: earlier" (stop, no tag) -> False
        assert injectDpdyTagComments.recent_has_tag(result) is False


# ---------------------------------------------------------------------------
# load_tag_by_key
# ---------------------------------------------------------------------------

class TestLoadTagByKey:
    def test_loads_from_json_files(self, tmp_path):
        workspace_dir = tmp_path / "plugin_builds" / "backstage"
        workspace_dir.mkdir(parents=True)
        data = {
            "red-hat-developer-hub-backstage-plugin-foo": {
                "registryReference": "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-foo:1.11--1.5.4",
                "build-date": "2025-05-01",
            }
        }
        (workspace_dir / "plugin-foo.json").write_text(json.dumps(data))

        result = injectDpdyTagComments.load_tag_by_key(tmp_path / "plugin_builds")

        assert result["red-hat-developer-hub-backstage-plugin-foo"] == ("1.11--1.5.4", "2025-05-01")
        assert result["rhdh-backstage-plugin-foo"] == ("1.11--1.5.4", "2025-05-01")

    def test_empty_dir(self, tmp_path):
        empty_dir = tmp_path / "plugin_builds"
        empty_dir.mkdir()
        assert injectDpdyTagComments.load_tag_by_key(empty_dir) == {}

    def test_nonexistent_dir(self, tmp_path):
        assert injectDpdyTagComments.load_tag_by_key(tmp_path / "does_not_exist") == {}

    def test_skips_entries_without_tag_or_build_date(self, tmp_path):
        workspace_dir = tmp_path / "plugin_builds" / "ws"
        workspace_dir.mkdir(parents=True)
        data = {
            "plugin-no-tag": {
                "registryReference": "quay.io/rhdh/plugin-no-tag",
                "build-date": "2025-05-01",
            },
            "plugin-no-date": {
                "registryReference": "quay.io/rhdh/plugin-no-date:1.0",
                "build-date": "",
            },
        }
        (workspace_dir / "data.json").write_text(json.dumps(data))
        assert injectDpdyTagComments.load_tag_by_key(tmp_path / "plugin_builds") == {}

    def test_skips_invalid_json(self, tmp_path):
        workspace_dir = tmp_path / "plugin_builds" / "ws"
        workspace_dir.mkdir(parents=True)
        (workspace_dir / "bad.json").write_text("not valid json!!!")
        assert injectDpdyTagComments.load_tag_by_key(tmp_path / "plugin_builds") == {}


# ---------------------------------------------------------------------------
# inject
# ---------------------------------------------------------------------------

@pytest.fixture
def plugin_builds_dir(tmp_path):
    """Create a plugin_builds directory with one workspace JSON file."""
    workspace_dir = tmp_path / "plugin_builds" / "backstage"
    workspace_dir.mkdir(parents=True)
    data = {
        "red-hat-developer-hub-backstage-plugin-foo": {
            "registryReference": "quay.io/rhdh/red-hat-developer-hub-backstage-plugin-foo:1.11--1.5.4",
            "build-date": "2025-05-01",
        }
    }
    (workspace_dir / "plugin-foo.json").write_text(json.dumps(data))
    return tmp_path / "plugin_builds"


class TestInject:
    def test_inject_after_commented_oci_line(self, tmp_path, plugin_builds_dir):
        dpdy = tmp_path / "dynamic-plugins.default.yaml"
        dpdy.write_text(
            "  # - package: oci://quay.io/rhdh/red-hat-developer-hub-backstage-plugin-foo@sha256:abc\n"
            "  - package: ./dynamic-plugins/dist/rhdh-backstage-plugin-foo-dynamic\n"
        )

        changed = injectDpdyTagComments.inject(dpdy, plugin_builds_dir)

        assert changed is True
        assert dpdy.read_text() == (
            "  # - package: oci://quay.io/rhdh/red-hat-developer-hub-backstage-plugin-foo@sha256:abc\n"
            "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n"
            "  - package: ./dynamic-plugins/dist/rhdh-backstage-plugin-foo-dynamic\n"
        )

    def test_inject_before_file_path_package_line(self, tmp_path, plugin_builds_dir):
        dpdy = tmp_path / "dynamic-plugins.default.yaml"
        dpdy.write_text(
            "  - package: ./dynamic-plugins/dist/rhdh-backstage-plugin-foo-dynamic\n"
            "    pluginConfig:\n"
            "      foo: bar\n"
        )

        changed = injectDpdyTagComments.inject(dpdy, plugin_builds_dir)

        assert changed is True
        assert dpdy.read_text() == (
            "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n"
            "  - package: ./dynamic-plugins/dist/rhdh-backstage-plugin-foo-dynamic\n"
            "    pluginConfig:\n"
            "      foo: bar\n"
        )

    def test_no_change_when_tag_already_exists(self, tmp_path, plugin_builds_dir):
        content = (
            "  # - package: oci://quay.io/rhdh/red-hat-developer-hub-backstage-plugin-foo@sha256:abc\n"
            "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\n"
            "  - package: ./dynamic-plugins/dist/rhdh-backstage-plugin-foo-dynamic\n"
        )
        dpdy = tmp_path / "dynamic-plugins.default.yaml"
        dpdy.write_text(content)

        changed = injectDpdyTagComments.inject(dpdy, plugin_builds_dir)

        assert changed is False
        assert dpdy.read_text() == content

    def test_no_change_when_no_matching_plugin(self, tmp_path):
        empty_builds = tmp_path / "plugin_builds"
        empty_builds.mkdir()
        dpdy = tmp_path / "dynamic-plugins.default.yaml"
        content = "  - package: ./dynamic-plugins/dist/unknown-plugin-dynamic\n"
        dpdy.write_text(content)

        changed = injectDpdyTagComments.inject(dpdy, empty_builds)

        assert changed is False
        assert dpdy.read_text() == content
