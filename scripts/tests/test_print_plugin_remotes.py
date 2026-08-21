"""Tests for scripts/print-plugin-remotes.sh and its agreement with the JS side.

Two derivations of the same value exist, in two languages: this script names the
committed anchor files, and remotesOf() in scripts/upstream-paths.cjs keys the
upstream tie-break. An anchor name is what findAnchorWorkspace matches, so a
divergence drops a workspace's coverage whole and does it quietly — a missing
anchor is a warning and an empty report is "nothing to snapshot".

To be clear about what this does NOT cover: the two sides agreed throughout the
app-defaults outage, because both emitted only the scalprum form. An agreement
test would have been green every day that workspace collected zero bytes. What
went wrong there was the pair itself being incomplete, which only a test of the
emitted names against the remotes RHDH actually reports could catch, and that
needs a real browser build. These tests keep the two implementations from
drifting apart; they cannot tell you the shared answer is right.
"""

import json
import shutil
import subprocess

import pytest

from tests.shell_harness import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "print-plugin-remotes.sh"
JS_MODULE = SCRIPTS_DIR / "upstream-paths.cjs"

# Real package names from the workspaces this feature ships for, plus the shapes
# that make the two derivations disagree if either drifts.
PACKAGE_NAMES = [
    # Real names from the workspaces this ships for.
    "@red-hat-developer-hub/backstage-plugin-app-defaults",
    "@backstage-community/plugin-tech-radar",
    # Shapes where the two derivations can drift apart. The unscoped hyphen-free
    # one is not academic: both forms collapse to the same string, and the JS
    # side used to read that as two plugins claiming one remote.
    "foo",
    "unscoped-package",
    "@scopewithouthyphen/plugin",
    "@scope/double--hyphen",
    "@scope/already_underscored",
    "@scope/dotted.name",
]

# Its own list, so reordering PACKAGE_NAMES cannot silently change what the
# declared-name cases cover.
PACKAGE_NAMES_WITH_DECLARED = [
    "@red-hat-developer-hub/backstage-plugin-app-defaults",
    "foo",
    "@scope/already_underscored",
]


def shell_remotes(package_name, declared=""):
    """Always passes both arguments, which is the shape the caller uses:
    generate-coverage-anchors.sh passes an empty second arg when a plugin
    declares no scalprum.name."""
    args = [str(SCRIPT), package_name, declared]
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return [line for line in result.stdout.splitlines() if line]


def js_remotes(tmp_path, package_name, declared=None):
    """The remotes the JS side claims for one plugin.

    The fixture tree is built with pytest's tmp_path rather than inside the node
    snippet: shell_harness documents that these runs keep no shared /tmp state,
    and an earlier version of this helper leaked a directory per invocation.
    """
    pkg = {"name": package_name}
    if declared:
        pkg["scalprum"] = {"name": declared}
    plugin = tmp_path / "workspaces" / "ws" / "plugins" / "p"
    plugin.mkdir(parents=True, exist_ok=True)
    (plugin / "package.json").write_text(json.dumps(pkg))

    result = subprocess.run(
        [
            "node",
            "-e",
            f"""
            const m = require({str(JS_MODULE)!r});
            const r = m.mapPluginDirsByRemote({str(tmp_path)!r}, 'ws');
            console.log(JSON.stringify([...r.pluginDirs.keys()]));
            """,
        ],
        capture_output=True,
        text=True,
        timeout=30,
        cwd=str(tmp_path),
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


class TestDerivation:
    def test_emits_the_scalprum_and_module_federation_forms(self):
        """The literal names, not a recomputation of the rule: an expectation
        derived the same way as the code cannot catch the rule being wrong."""
        assert shell_remotes("@red-hat-developer-hub/backstage-plugin-app-defaults") == [
            "red-hat-developer-hub.backstage-plugin-app-defaults",
            "red_hat_developer_hub__backstage_plugin_app_defaults",
        ]

    def test_a_declared_name_replaces_only_the_scalprum_form(self):
        """Module Federation sanitises the package name whatever the manifest
        says, so a declared scalprum name cannot stand in for it."""
        got = shell_remotes(
            "@red-hat-developer-hub/backstage-plugin-intelligent-assistant",
            "custom.declared.remote",
        )

        assert got == [
            "custom.declared.remote",
            "red_hat_developer_hub__backstage_plugin_intelligent_assistant",
        ]

    def test_an_unscoped_name_yields_one_form_twice(self):
        """`foo` derives to `foo` both ways. The caller deduplicates; this just
        pins that the script does not invent a difference."""
        assert shell_remotes("foo") == ["foo", "foo"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not available")
class TestCrossLanguageAgreement:
    """The guard that was missing when app-defaults went dark."""

    @pytest.mark.parametrize("package_name", PACKAGE_NAMES)
    def test_shell_and_js_derive_the_same_remotes(self, tmp_path, package_name):
        assert sorted(set(shell_remotes(package_name))) == sorted(
            set(js_remotes(tmp_path, package_name))
        )

    @pytest.mark.parametrize("package_name", PACKAGE_NAMES_WITH_DECLARED)
    def test_they_agree_with_a_declared_scalprum_name_too(self, tmp_path, package_name):
        declared = "declared.remote.name"

        assert sorted(set(shell_remotes(package_name, declared))) == sorted(
            set(js_remotes(tmp_path, package_name, declared))
        )
