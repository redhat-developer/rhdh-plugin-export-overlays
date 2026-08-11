"""Tests for scripts/upstream-paths.cjs — the upstream path resolution.

This is the part of the upstream coverage path most able to fail silently. A
wrong resolution does not crash: it publishes one plugin's coverage under
another plugin's file, which reads as a plausible number and is wrong. So the
behaviour worth pinning is not "it resolves" but "it refuses to guess".

Driven through `node` rather than imported, because the logic is CommonJS. It
depends only on node builtins, which is why it was split out of
remap-coverage.cjs — testing it there would have meant an npm install of the
istanbul libraries on every run.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.shell_harness import SCRIPTS_DIR

MODULE = SCRIPTS_DIR / "upstream-paths.cjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not available"
)

WORKSPACE = "ws"


def build_tree(root: Path, files) -> Path:
    """Lay out `workspaces/<ws>/...` with the given repo-relative-ish files."""
    for rel in files:
        target = root / "workspaces" / WORKSPACE / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("x\n")
    return root


def run_node(script: str):
    """Evaluate `script` with the module in scope; it prints JSON on stdout."""
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(SCRIPTS_DIR),
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def resolve(root: Path, sources, owner=None):
    """Index `root` and resolve each source path, as the remap does.

    `owner` is the directory of the plugin the coverage came from, which the
    remap derives from the webpack remote.
    """
    owner_js = json.dumps(owner) if owner else "undefined"
    return run_node(
        f"""
        const m = require({str(MODULE)!r});
        const index = m.indexUpstreamTree({str(root)!r}, {WORKSPACE!r});
        const out = {{}};
        for (const s of {json.dumps(sources)})
          out[s] = m.resolveUpstream(index, s, {owner_js});
        console.log(JSON.stringify({{index: index.length, out}}));
        """
    )


def plugin_dirs(root: Path):
    """The remote -> plugin directory map the remap builds from the checkout."""
    return run_node(
        f"""
        const m = require({str(MODULE)!r});
        const map = m.mapPluginDirsByRemote({str(root)!r}, {WORKSPACE!r});
        console.log(JSON.stringify(Object.fromEntries(map)));
        """
    )


def write_plugin(root: Path, dirname: str, *, name=None, scalprum=None, raw=None):
    """A plugin directory with a package.json, as the source repo has."""
    d = root / "workspaces" / WORKSPACE / "plugins" / dirname
    d.mkdir(parents=True, exist_ok=True)
    if raw is not None:
        (d / "package.json").write_text(raw)
        return d
    pkg = {"name": name or f"@scope/{dirname}"}
    if scalprum:
        pkg["scalprum"] = {"name": scalprum}
    (d / "package.json").write_text(json.dumps(pkg))
    return d


def test_resolves_a_unique_source_to_its_real_path(tmp_path):
    build_tree(tmp_path, ["plugins/a/src/utils/foo.ts"])

    got = resolve(tmp_path, ["src/utils/foo.ts"])

    assert got["out"]["src/utils/foo.ts"]["path"] == (
        f"workspaces/{WORKSPACE}/plugins/a/src/utils/foo.ts"
    )


def test_refuses_to_guess_when_two_plugins_share_a_name(tmp_path):
    """The finding that matters: several plugins in one workspace legitimately
    ship `src/index.ts`. Picking one would attribute a plugin's coverage to a
    file belonging to another — worse than losing it."""
    build_tree(tmp_path, ["plugins/a/src/index.ts", "plugins/b/src/index.ts"])

    got = resolve(tmp_path, ["src/index.ts"])

    assert got["out"]["src/index.ts"]["path"] is None
    assert got["out"]["src/index.ts"]["reason"] == "ambiguous"


def test_reports_a_source_that_is_not_in_the_tree(tmp_path):
    """A file added upstream after the pinned ref, or deleted before it."""
    build_tree(tmp_path, ["plugins/a/src/kept.ts"])

    got = resolve(tmp_path, ["src/ghost.ts"])

    assert got["out"]["src/ghost.ts"]["path"] is None
    assert got["out"]["src/ghost.ts"]["reason"] == "not-in-tree"


def test_resolves_a_sibling_package_path(tmp_path):
    """Coverage from `../<pkg>-common/src/x.ts` arrives with the package name
    still on the front, and must not take the owning plugin's prefix."""
    build_tree(
        tmp_path,
        ["plugins/a/src/x.ts", "plugins/a-common/src/x.ts"],
    )

    got = resolve(tmp_path, ["a-common/src/x.ts"])

    assert got["out"]["a-common/src/x.ts"]["path"] == (
        f"workspaces/{WORKSPACE}/plugins/a-common/src/x.ts"
    )


def test_a_partial_segment_is_not_a_match(tmp_path):
    """Suffix matching must respect path boundaries: `src/foo.ts` must not
    resolve to `.../src/notfoo.ts`."""
    build_tree(tmp_path, ["plugins/a/src/notfoo.ts"])

    got = resolve(tmp_path, ["src/foo.ts"])

    assert got["out"]["src/foo.ts"]["path"] is None
    assert got["out"]["src/foo.ts"]["reason"] == "not-in-tree"


def test_skips_node_modules_so_a_dependency_cannot_shadow_a_source(tmp_path):
    """A reused working tree (rather than a fresh clone) has node_modules, and a
    dependency shipping the same relative path would otherwise make a real source
    look ambiguous and drop it."""
    build_tree(
        tmp_path,
        ["plugins/a/src/index.ts", "plugins/a/node_modules/dep/src/index.ts"],
    )

    got = resolve(tmp_path, ["src/index.ts"])

    # Excluded at walk time, not merely out-resolved: one entry in the whole
    # index, so a future change cannot re-admit it and stay green here.
    assert got["index"] == 1
    assert got["out"]["src/index.ts"]["path"] == (
        f"workspaces/{WORKSPACE}/plugins/a/src/index.ts"
    )


def test_scans_only_the_requested_workspace(tmp_path):
    """The scoping is what keeps ambiguity rare enough to be an acceptable loss.
    Without it, every workspace sharing a `src/index.ts` would collide with
    every other, and the drop rate would stop being wiring-file noise."""
    build_tree(tmp_path, ["plugins/a/src/index.ts"])
    other = tmp_path / "workspaces" / "other" / "plugins" / "b" / "src"
    other.mkdir(parents=True)
    (other / "index.ts").write_text("x\n")

    got = resolve(tmp_path, ["src/index.ts"])

    assert got["index"] == 1
    assert got["out"]["src/index.ts"]["path"] == (
        f"workspaces/{WORKSPACE}/plugins/a/src/index.ts"
    )


class TestOwnerDisambiguation:
    """Several plugins in one workspace ship the same relative path. The
    coverage carries the remote of the plugin it came from, so the tie has an
    answer — dropping it loses real files, which is what `src/api/index.ts`
    cost adoption-insights (the source repo's codecov.yml deliberately keeps
    nested index files in the denominator).
    """

    def test_the_owning_plugin_breaks_a_tie(self, tmp_path):
        build_tree(
            tmp_path,
            ["plugins/a/src/api/index.ts", "plugins/b/src/api/index.ts"],
        )

        got = resolve(
            tmp_path,
            ["src/api/index.ts"],
            owner=f"workspaces/{WORKSPACE}/plugins/a",
        )

        assert got["out"]["src/api/index.ts"]["path"] == (
            f"workspaces/{WORKSPACE}/plugins/a/src/api/index.ts"
        )

    def test_without_an_owner_the_tie_is_still_dropped(self, tmp_path):
        """An unknown remote must not start guessing."""
        build_tree(
            tmp_path,
            ["plugins/a/src/api/index.ts", "plugins/b/src/api/index.ts"],
        )

        got = resolve(tmp_path, ["src/api/index.ts"])

        assert got["out"]["src/api/index.ts"]["path"] is None
        assert got["out"]["src/api/index.ts"]["reason"] == "ambiguous"

    def test_an_owner_that_does_not_have_the_file_does_not_rescue_it(self, tmp_path):
        """If the owning plugin has no such file, the coverage cannot be
        attributed to it, and picking one of the others would be a guess."""
        build_tree(
            tmp_path,
            ["plugins/a/src/api/index.ts", "plugins/b/src/api/index.ts"],
        )

        got = resolve(
            tmp_path,
            ["src/api/index.ts"],
            owner=f"workspaces/{WORKSPACE}/plugins/c",
        )

        assert got["out"]["src/api/index.ts"]["path"] is None
        assert got["out"]["src/api/index.ts"]["reason"] == "ambiguous"

    def test_a_sibling_package_still_resolves_outside_the_owner(self, tmp_path):
        """The regression this must not cause. Coverage from one plugin can
        reference a sibling package's source, which lives outside the owning
        directory — measured: intelligent-assistant published one such file.
        A unique workspace-wide match has to keep winning outright."""
        build_tree(
            tmp_path,
            ["plugins/a/src/x.ts", "plugins/a-common/src/permissions.ts"],
        )

        got = resolve(
            tmp_path,
            ["a-common/src/permissions.ts"],
            owner=f"workspaces/{WORKSPACE}/plugins/a",
        )

        assert got["out"]["a-common/src/permissions.ts"]["path"] == (
            f"workspaces/{WORKSPACE}/plugins/a-common/src/permissions.ts"
        )

    def test_an_owner_prefix_must_not_match_a_longer_sibling_name(self, tmp_path):
        """`plugins/a` must not claim `plugins/a-common`, or the tie-break
        would attribute a sibling's file to the wrong plugin."""
        build_tree(
            tmp_path,
            ["plugins/a-common/src/index.ts", "plugins/b/src/index.ts"],
        )

        got = resolve(
            tmp_path,
            ["src/index.ts"],
            owner=f"workspaces/{WORKSPACE}/plugins/a",
        )

        assert got["out"]["src/index.ts"]["path"] is None
        assert got["out"]["src/index.ts"]["reason"] == "ambiguous"


class TestRemoteToPluginDir:
    def test_prefers_the_declared_scalprum_name(self, tmp_path):
        """The plugin declares its own remote; that value is authoritative."""
        write_plugin(
            tmp_path, "adoption-insights",
            name="@red-hat-developer-hub/backstage-plugin-adoption-insights",
            scalprum="red-hat-developer-hub.backstage-plugin-adoption-insights",
        )

        got = plugin_dirs(tmp_path)

        assert got == {
            "red-hat-developer-hub.backstage-plugin-adoption-insights":
                f"workspaces/{WORKSPACE}/plugins/adoption-insights"
        }

    def test_falls_back_to_the_package_name(self, tmp_path):
        """A plugin that declares no scalprum block still gets a tie-break."""
        write_plugin(tmp_path, "thing", name="@scope/backstage-plugin-thing")

        got = plugin_dirs(tmp_path)

        assert got == {
            "scope.backstage-plugin-thing":
                f"workspaces/{WORKSPACE}/plugins/thing"
        }

    def test_a_malformed_manifest_costs_only_that_plugin(self, tmp_path):
        """Losing the whole map to one bad file would silently turn every tie
        back into a drop."""
        write_plugin(tmp_path, "broken", raw="{not json")
        write_plugin(tmp_path, "fine", name="@scope/fine")

        got = plugin_dirs(tmp_path)

        assert got == {"scope.fine": f"workspaces/{WORKSPACE}/plugins/fine"}

    def test_a_workspace_without_plugins_maps_nothing(self, tmp_path):
        build_tree(tmp_path, ["e2e-tests/package.json"])

        assert plugin_dirs(tmp_path) == {}

    def test_two_plugins_claiming_one_remote_get_no_tie_break(self, tmp_path):
        """Keeping one would be a coin flip on readdir order, and a wrong owner
        attributes a plugin's coverage to another plugin's file — the exact
        outcome the drop-rather-than-guess rule exists to prevent. Dropping the
        entry sends those paths back to being reported ambiguous.

        The sibling findAnchorWorkspace picks deterministically and warns; here
        the consequence of picking wrong is silent, so this one refuses.
        """
        write_plugin(tmp_path, "a", name="@scope/a", scalprum="scope.shared")
        write_plugin(tmp_path, "b", name="@scope/b", scalprum="scope.shared")
        write_plugin(tmp_path, "c", name="@scope/c")

        got = plugin_dirs(tmp_path)

        assert "scope.shared" not in got
        # The unaffected plugin keeps its own tie-break.
        assert got == {"scope.c": f"workspaces/{WORKSPACE}/plugins/c"}

    def test_a_directory_without_a_manifest_is_skipped(self, tmp_path):
        """`plugins/` holds a README in the real repos, and a plugin can be
        vendored without a package.json."""
        write_plugin(tmp_path, "real", name="@scope/real")
        (tmp_path / "workspaces" / WORKSPACE / "plugins" / "no-manifest").mkdir(
            parents=True
        )
        (tmp_path / "workspaces" / WORKSPACE / "plugins" / "README.md").write_text("x")

        assert plugin_dirs(tmp_path) == {
            "scope.real": f"workspaces/{WORKSPACE}/plugins/real"
        }


def test_a_missing_workspace_is_an_actionable_error(tmp_path):
    """Pointing at the wrong repo, or at a ref predating the workspace."""
    build_tree(tmp_path, ["plugins/a/src/x.ts"])

    payload = run_node(
        f"""
        const m = require({str(MODULE)!r});
        try {{ m.indexUpstreamTree({str(tmp_path)!r}, 'absent'); }}
        catch (e) {{ console.log(JSON.stringify({{code: e.code, msg: e.message}})); }}
        """
    )

    assert payload["code"] == "ENOWORKSPACE"
    assert "absent" in payload["msg"]
