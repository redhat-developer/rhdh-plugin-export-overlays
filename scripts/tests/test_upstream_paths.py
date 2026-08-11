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


def resolve(root: Path, sources):
    """Index `root` and resolve each source path, as the remap does."""
    return run_node(
        f"""
        const m = require({str(MODULE)!r});
        const index = m.indexUpstreamTree({str(root)!r}, {WORKSPACE!r});
        const out = {{}};
        for (const s of {json.dumps(sources)}) out[s] = m.resolveUpstream(index, s);
        console.log(JSON.stringify({{index: index.length, out}}));
        """
    )


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
