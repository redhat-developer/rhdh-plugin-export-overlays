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


def run_node(script: str, tmp_path=None):
    """Evaluate `script` with the module in scope; it prints JSON on stdout.

    Returns the parsed payload with the process's stderr attached under
    `_stderr`, so a warning the module emits is assertable rather than lost —
    the module's warnings are the only signal some misconfigurations give.

    cwd is a throwaway directory: a sibling module reads `workspaces/` relative
    to the process cwd, and pointing this at the real repo would let a future
    relative read silently see the developer's checkout.
    """
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(tmp_path or SCRIPTS_DIR.parent),
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    payload["_stderr"] = result.stderr
    return payload


def resolve(root: Path, sources, owner=None):
    """Index `root` and resolve each source path, as the remap does.

    `owner` is the directory of the plugin the coverage came from, which the
    remap derives from the webpack remote.
    """
    owner_js = json.dumps(owner) if owner else "undefined"
    return run_node(
        f"""
        const m = require({str(MODULE)!r});
        const files = m.listUpstreamFiles({str(root)!r}, {WORKSPACE!r});
        const out = {{}};
        for (const s of {json.dumps(sources)})
          out[s] = m.resolveUpstreamPath(files, s, {owner_js});
        console.log(JSON.stringify({{index: files.length, out}}));
        """,
        tmp_path=root,
    )


def plugin_dirs(root: Path):
    """The remote -> plugin directory map the remap builds from the checkout."""
    return run_node(
        f"""
        const m = require({str(MODULE)!r});
        const r = m.mapPluginDirsByRemote({str(root)!r}, {WORKSPACE!r});
        console.log(JSON.stringify({{dirs: Object.fromEntries(r.pluginDirs), collisions: r.collisions, unreadable: r.unreadable}}));
        """,
        tmp_path=root,
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

    assert got["out"]["src/utils/foo.ts"]["upstreamPath"] == (
        f"workspaces/{WORKSPACE}/plugins/a/src/utils/foo.ts"
    )


def test_refuses_to_guess_when_two_plugins_share_a_name(tmp_path):
    """The finding that matters: several plugins in one workspace legitimately
    ship `src/index.ts`. Picking one would attribute a plugin's coverage to a
    file belonging to another — worse than losing it."""
    build_tree(tmp_path, ["plugins/a/src/index.ts", "plugins/b/src/index.ts"])

    got = resolve(tmp_path, ["src/index.ts"])

    assert got["out"]["src/index.ts"]["upstreamPath"] is None
    assert got["out"]["src/index.ts"]["reason"] == "ambiguous"


def test_reports_a_source_that_is_not_in_the_tree(tmp_path):
    """A file added upstream after the pinned ref, or deleted before it."""
    build_tree(tmp_path, ["plugins/a/src/kept.ts"])

    got = resolve(tmp_path, ["src/ghost.ts"])

    assert got["out"]["src/ghost.ts"]["upstreamPath"] is None
    assert got["out"]["src/ghost.ts"]["reason"] == "not-in-tree"


def test_resolves_a_sibling_package_path(tmp_path):
    """Coverage from `../<pkg>-common/src/x.ts` arrives with the package name
    still on the front, and must not take the owning plugin's prefix."""
    build_tree(
        tmp_path,
        ["plugins/a/src/x.ts", "plugins/a-common/src/x.ts"],
    )

    got = resolve(tmp_path, ["a-common/src/x.ts"])

    assert got["out"]["a-common/src/x.ts"]["upstreamPath"] == (
        f"workspaces/{WORKSPACE}/plugins/a-common/src/x.ts"
    )


def test_a_partial_segment_is_not_a_match(tmp_path):
    """Suffix matching must respect path boundaries: `src/foo.ts` must not
    resolve to `.../src/notfoo.ts`."""
    build_tree(tmp_path, ["plugins/a/src/notfoo.ts"])

    got = resolve(tmp_path, ["src/foo.ts"])

    assert got["out"]["src/foo.ts"]["upstreamPath"] is None
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
    assert got["out"]["src/index.ts"]["upstreamPath"] == (
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
    assert got["out"]["src/index.ts"]["upstreamPath"] == (
        f"workspaces/{WORKSPACE}/plugins/a/src/index.ts"
    )


class TestOwnerDisambiguation:
    """Several plugins in one workspace ship the same relative path. The
    coverage carries the remote of the plugin it came from, so the tie has an
    answer — dropping it loses real files, which is what `src/api/index.ts`
    cost adoption-insights (the source repo's codecov.yml deliberately keeps
    nested index files in the denominator).
    """

    def test_an_owner_relative_path_never_lands_in_another_package(self, tmp_path):
        """The failure this guard exists for, and the one that is silent.

        Coverage measured on plugin `a` at `src/types.ts` must not be written
        onto `a-common/src/types.ts` just because the owner does not ship that
        file at the pinned ref. It is a single unique match, so a plain suffix
        rule accepts it — and the result is one plugin's line numbers on another
        plugin's file, published as a real number.

        Reachable through ordinary drift: a file moved plugin -> plugin-common,
        or added after the ref, which the README documents as designed-in.
        """
        build_tree(tmp_path, ["plugins/a-common/src/types.ts"])

        got = resolve(
            tmp_path, ["src/types.ts"], owner=f"workspaces/{WORKSPACE}/plugins/a"
        )

        assert got["out"]["src/types.ts"]["upstreamPath"] is None
        assert got["out"]["src/types.ts"]["reason"] == "not-in-owner"

    def test_a_sibling_path_that_names_its_package_is_still_accepted(self, tmp_path):
        """The counterpart to the test above, and why the rule is about what the
        path names rather than where it lands: `a-common/src/x.ts` carries the
        package on its front, so resolving outside the owner is exactly right."""
        build_tree(tmp_path, ["plugins/a-common/src/permissions.ts"])

        got = resolve(
            tmp_path,
            ["a-common/src/permissions.ts"],
            owner=f"workspaces/{WORKSPACE}/plugins/a",
        )

        assert got["out"]["a-common/src/permissions.ts"]["upstreamPath"] == (
            f"workspaces/{WORKSPACE}/plugins/a-common/src/permissions.ts"
        )

    def test_a_trailing_separator_on_the_owner_still_works(self, tmp_path):
        """ownerDir crosses a module boundary, and `workspaces/ws/plugins/a/`
        is an easy thing for a caller to hand over. Without normalising it the
        tie-break silently stops firing while the log still reports it as
        available."""
        build_tree(
            tmp_path,
            ["plugins/a/src/index.ts", "plugins/b/src/index.ts"],
        )

        got = resolve(
            tmp_path, ["src/index.ts"], owner=f"workspaces/{WORKSPACE}/plugins/a/"
        )

        assert got["out"]["src/index.ts"]["upstreamPath"] == (
            f"workspaces/{WORKSPACE}/plugins/a/src/index.ts"
        )

    def test_two_copies_inside_the_owner_are_still_ambiguous(self, tmp_path):
        """The tie-break narrows the candidates to one plugin; it does not start
        guessing within it. A build artefact or fixture copy under the owner
        leaves the answer just as unknown as before."""
        build_tree(
            tmp_path,
            [
                "plugins/a/src/api/index.ts",
                "plugins/a/__fixtures__/src/api/index.ts",
                "plugins/b/src/api/index.ts",
            ],
        )

        got = resolve(
            tmp_path,
            ["src/api/index.ts"],
            owner=f"workspaces/{WORKSPACE}/plugins/a",
        )

        assert got["out"]["src/api/index.ts"]["upstreamPath"] is None
        assert got["out"]["src/api/index.ts"]["reason"] == "ambiguous"

    def test_a_known_owner_does_not_change_a_not_in_tree_miss(self, tmp_path):
        """Supplying an owner must not turn "the ref has no such file" into a
        different verdict — the two point at different fixes."""
        build_tree(tmp_path, ["plugins/a/src/kept.ts"])

        got = resolve(
            tmp_path, ["src/ghost.ts"], owner=f"workspaces/{WORKSPACE}/plugins/a"
        )

        assert got["out"]["src/ghost.ts"]["upstreamPath"] is None
        assert got["out"]["src/ghost.ts"]["reason"] == "not-in-tree"

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

        assert got["out"]["src/api/index.ts"]["upstreamPath"] == (
            f"workspaces/{WORKSPACE}/plugins/a/src/api/index.ts"
        )

    def test_without_an_owner_the_tie_is_still_dropped(self, tmp_path):
        """An unknown remote must not start guessing."""
        build_tree(
            tmp_path,
            ["plugins/a/src/api/index.ts", "plugins/b/src/api/index.ts"],
        )

        got = resolve(tmp_path, ["src/api/index.ts"])

        assert got["out"]["src/api/index.ts"]["upstreamPath"] is None
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

        assert got["out"]["src/api/index.ts"]["upstreamPath"] is None
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

        assert got["out"]["a-common/src/permissions.ts"]["upstreamPath"] == (
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

        assert got["out"]["src/index.ts"]["upstreamPath"] is None
        assert got["out"]["src/index.ts"]["reason"] == "ambiguous"


class TestRemoteToPluginDir:
    """The map that lets a tie be broken at all. A remote missing from it costs
    that plugin its tie-break silently, so every way of losing an entry is
    pinned here — including that the caller is told about it.
    """

    def test_prefers_the_declared_scalprum_name_over_the_derived_one(self, tmp_path):
        """The declared value is the authority. This only tests anything if it
        differs from what the package name would derive to — an earlier version
        of this test used a scalprum name identical to the derivation, so
        deleting the whole `scalprum.name` lookup kept it green."""
        write_plugin(
            tmp_path, "thing", name="@scope/backstage-plugin-thing",
            scalprum="totally.different.remote",
        )

        got = plugin_dirs(tmp_path)["dirs"]
        here = f"workspaces/{WORKSPACE}/plugins/thing"

        assert got["totally.different.remote"] == here
        # The scalprum form is not derived when one is declared; the MF form is
        # still claimed, because MF sanitises the package name regardless.
        assert "scope.backstage-plugin-thing" not in got
        assert got["scope__backstage_plugin_thing"] == here

    def test_falls_back_to_the_package_name(self, tmp_path):
        """Load-bearing, not a nicety: most plugin manifests in the published
        workspaces declare no scalprum block, including one side of the clash
        the tie-break exists to settle."""
        write_plugin(tmp_path, "thing", name="@scope/backstage-plugin-thing")

        here = f"workspaces/{WORKSPACE}/plugins/thing"
        assert plugin_dirs(tmp_path)["dirs"] == {
            "scope.backstage-plugin-thing": here,
            "scope__backstage_plugin_thing": here,
        }

    def test_claims_the_module_federation_form_too(self, tmp_path):
        """A plugin served through Module Federation reports a remote sanitised
        into a JS identifier, not the dotted scalprum name. app-defaults
        collected nothing at all from 2026-08-04 until this was found: its
        remotes arrive as `red_hat_developer_hub__backstage_plugin_app_defaults`
        and every one missed its anchor, so the workspace was dropped whole —
        silently, because a missing anchor is only a warning.

        Which build serves a plugin is not visible from its manifest —
        app-defaults and adoption-insights have identical-looking ones — so both
        forms are claimed.
        """
        write_plugin(
            tmp_path, "app-defaults",
            name="@red-hat-developer-hub/backstage-plugin-app-defaults",
        )

        got = plugin_dirs(tmp_path)["dirs"]
        here = f"workspaces/{WORKSPACE}/plugins/app-defaults"

        assert got["red_hat_developer_hub__backstage_plugin_app_defaults"] == here
        assert got["red-hat-developer-hub.backstage-plugin-app-defaults"] == here

    def test_a_declared_name_is_not_displaced_by_a_derived_one(self, tmp_path):
        """A plugin that asks for a remote must get it. Treating the two as
        equal claims would let a derived name collide with a declared one and
        take both down."""
        write_plugin(tmp_path, "wants-it", name="@scope/x", scalprum="scope.shared")
        write_plugin(tmp_path, "derives-it", name="@scope/shared")

        got = plugin_dirs(tmp_path)

        assert got["dirs"]["scope.shared"] == (
            f"workspaces/{WORKSPACE}/plugins/wants-it"
        )
        assert got["collisions"] == []

    def test_two_plugins_claiming_one_remote_get_no_tie_break(self, tmp_path):
        """Keeping one would be a coin flip on readdir order, and a wrong owner
        attributes a plugin's coverage to another plugin's file — the exact
        outcome the drop-rather-than-guess rule exists to prevent.

        The sibling findAnchorWorkspace picks deterministically and warns; here
        the consequence of picking wrong is silent, so this one refuses.
        """
        write_plugin(tmp_path, "a", name="@scope/a", scalprum="scope.shared")
        write_plugin(tmp_path, "b", name="@scope/b", scalprum="scope.shared")
        write_plugin(tmp_path, "c", name="@scope/c")

        got = plugin_dirs(tmp_path)

        # The unaffected plugin keeps its own tie-break.
        assert got["dirs"] == {
            "scope.c": f"workspaces/{WORKSPACE}/plugins/c",
            "scope__c": f"workspaces/{WORKSPACE}/plugins/c",
            "scope__a": f"workspaces/{WORKSPACE}/plugins/a",
            "scope__b": f"workspaces/{WORKSPACE}/plugins/b",
        }
        # Reported, not swallowed: this is the only signal that two manifests
        # disagree, and without it the drops read as ordinary wiring noise.
        assert len(got["collisions"]) == 1
        assert got["collisions"][0]["remote"] == "scope.shared"
        assert sorted(d.split("/")[-1] for d in got["collisions"][0]["dirs"]) == [
            "a", "b"
        ]

    def test_a_malformed_manifest_costs_only_that_plugin_and_is_reported(
        self, tmp_path
    ):
        """Losing the whole map to one bad file would silently turn every tie
        back into a drop."""
        write_plugin(tmp_path, "broken", raw="{not json")
        write_plugin(tmp_path, "fine", name="@scope/fine")

        got = plugin_dirs(tmp_path)

        here = f"workspaces/{WORKSPACE}/plugins/fine"
        assert got["dirs"] == {"scope.fine": here, "scope__fine": here}
        assert got["unreadable"] == [
            f"workspaces/{WORKSPACE}/plugins/broken/package.json"
        ]

    def test_a_manifest_without_a_name_is_skipped(self, tmp_path):
        """No name and no scalprum block means no remote to key on. The guard
        also stops a null key entering the map, which no lookup could ever hit."""
        write_plugin(tmp_path, "anonymous", raw='{"version": "1.0.0"}')
        write_plugin(tmp_path, "fine", name="@scope/fine")

        got = plugin_dirs(tmp_path)

        here = f"workspaces/{WORKSPACE}/plugins/fine"
        assert got["dirs"] == {"scope.fine": here, "scope__fine": here}
        assert got["unreadable"] == []

    def test_a_workspace_without_plugins_maps_nothing(self, tmp_path):
        """A source repo laid out differently gets no tie-break rather than a
        wrong one; the caller turns an empty map into a warning."""
        build_tree(tmp_path, ["e2e-tests/package.json"])

        assert plugin_dirs(tmp_path)["dirs"] == {}

    def test_a_plugin_nested_below_the_scanned_level_is_not_mapped(self, tmp_path):
        """Only `plugins/<dir>` is scanned. Every workspace in the one
        upstream-eligible repo is flat, but the limitation is invisible without
        this — a repo grouping plugins by kind would silently lose its
        tie-break."""
        write_plugin(tmp_path, "frontend/nested", name="@scope/nested")
        write_plugin(tmp_path, "flat", name="@scope/flat")

        here = f"workspaces/{WORKSPACE}/plugins/flat"
        assert plugin_dirs(tmp_path)["dirs"] == {
            "scope.flat": here, "scope__flat": here
        }

    def test_a_directory_without_a_manifest_is_skipped(self, tmp_path):
        """A plugin can be vendored without a package.json."""
        write_plugin(tmp_path, "real", name="@scope/real")
        (tmp_path / "workspaces" / WORKSPACE / "plugins" / "no-manifest").mkdir(
            parents=True
        )

        here = f"workspaces/{WORKSPACE}/plugins/real"
        assert plugin_dirs(tmp_path)["dirs"] == {
            "scope.real": here, "scope__real": here
        }


def test_a_missing_workspace_is_an_actionable_error(tmp_path):
    """Pointing at the wrong repo, or at a ref predating the workspace."""
    build_tree(tmp_path, ["plugins/a/src/x.ts"])

    payload = run_node(
        f"""
        const m = require({str(MODULE)!r});
        try {{ m.listUpstreamFiles({str(tmp_path)!r}, 'absent'); }}
        catch (e) {{ console.log(JSON.stringify({{code: e.code, msg: e.message}})); }}
        """
    )

    assert payload["code"] == "ENOWORKSPACE"
    assert "absent" in payload["msg"]
