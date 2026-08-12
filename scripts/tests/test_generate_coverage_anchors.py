"""Tests for scripts/generate-coverage-anchors.sh.

The script reads a plugin's package.json through `gh api`, which is its only
network dependency and its only reason for going untested until now. A `gh` shim
on PATH removes it — the same technique test_ensure_codecov_cli.py uses for
`curl`, and for the same reason: the part worth pinning is reachable without a
network.

That gap was not cosmetic. Reverting this script to emitting a single anchor per
plugin — the bug that left app-defaults with zero coverage for a week — used to
leave the whole suite green, because nothing exercised the emitter at all.
"""

import json
import os
import shutil
import subprocess

import pytest

from tests.shell_harness import SCRIPTS_DIR, link_script

SCRIPT_NAME = "generate-coverage-anchors.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("jq") is None, reason="jq is not available"
)


def build_workspace(root, workspace, plugins, *, repo="https://github.com/o/r"):
    """A workspace laid out the way the script expects to find one.

    `plugins` maps a plugin path to the package.json the shimmed `gh` will
    return for it. Every package name is listed as deployed, since the
    not-deployed filter has its own test.
    """
    for name in (SCRIPT_NAME, "print-plugin-remotes.sh"):
        link_script(root, name)

    ws = root / "workspaces" / workspace
    (ws / "metadata").mkdir(parents=True)
    (ws / "source.json").write_text(
        json.dumps({"repo": repo, "repo-ref": "a" * 40, "repo-flat": False})
    )
    (ws / "plugins-list.yaml").write_text(
        "".join(f"{path}:\n" for path in plugins) or "\n"
    )
    (ws / "metadata" / "packages.yaml").write_text(
        "".join(f"  packageName: {pkg['name']}\n" for pkg in plugins.values())
    )
    return ws


def write_gh_shim(root, plugins):
    """A `gh` that answers the one call the script makes, from a fixture map.

    The script asks for `.../<plugin path>/package.json?ref=...`; the shim keys
    off that path and prints the manifest as raw content, which is what the
    `Accept: application/vnd.github.raw` header requests.
    """
    bin_dir = root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    table = {f"/{path}/package.json": json.dumps(pkg) for path, pkg in plugins.items()}
    shim = bin_dir / "gh"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        f"TABLE={json.dumps(json.dumps(table))}\n"
        'for arg in "$@"; do case "$arg" in repos/*) REQ="$arg";; esac; done\n'
        'REQ="${REQ%%\\?*}"\n'
        'for key in $(echo "$TABLE" | jq -r "keys[]"); do\n'
        '  case "$REQ" in *"$key") echo "$TABLE" | jq -r --arg k "$key" \'.[$k]\'; exit 0;; esac\n'
        "done\n"
        "exit 1\n"
    )
    shim.chmod(0o755)
    return bin_dir


def run_generate(root, workspace, bin_dir):
    return subprocess.run(
        [str(root / "scripts" / SCRIPT_NAME), workspace],
        cwd=str(root),
        env={
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": os.environ.get("HOME", "/tmp"),
        },
        capture_output=True,
        text=True,
        timeout=60,
    )


def anchors(root, workspace):
    d = root / "workspaces" / workspace / "coverage-anchors"
    return sorted(p.name for p in d.iterdir()) if d.exists() else []


def test_writes_both_remote_forms_for_each_plugin(tmp_path):
    """The fix itself. One anchor per plugin is what left app-defaults dark:
    a plugin served through Module Federation reports a sanitised remote, and
    without its anchor the whole workspace is dropped."""
    plugins = {
        "plugins/app-defaults": {
            "name": "@red-hat-developer-hub/backstage-plugin-app-defaults"
        }
    }
    build_workspace(tmp_path, "ws", plugins)
    bin_dir = write_gh_shim(tmp_path, plugins)

    result = run_generate(tmp_path, "ws", bin_dir)

    assert result.returncode == 0, result.stderr
    assert anchors(tmp_path, "ws") == [
        "red-hat-developer-hub.backstage-plugin-app-defaults",
        "red_hat_developer_hub__backstage_plugin_app_defaults",
    ]


def test_a_declared_scalprum_name_replaces_only_the_scalprum_anchor(tmp_path):
    plugins = {
        "plugins/thing": {
            "name": "@scope/backstage-plugin-thing",
            "scalprum": {"name": "custom.declared.remote"},
        }
    }
    build_workspace(tmp_path, "ws", plugins)
    bin_dir = write_gh_shim(tmp_path, plugins)

    result = run_generate(tmp_path, "ws", bin_dir)

    assert result.returncode == 0, result.stderr
    assert anchors(tmp_path, "ws") == [
        "custom.declared.remote",
        "scope__backstage_plugin_thing",
    ]


def test_a_plugin_whose_two_forms_coincide_gets_one_anchor(tmp_path):
    """`foo` derives to `foo` both ways. One file, and no warning — this is the
    benign half of the duplicate check."""
    plugins = {"plugins/foo": {"name": "foo"}}
    build_workspace(tmp_path, "ws", plugins)
    bin_dir = write_gh_shim(tmp_path, plugins)

    result = run_generate(tmp_path, "ws", bin_dir)

    assert result.returncode == 0, result.stderr
    assert anchors(tmp_path, "ws") == ["foo"]
    assert "already claimed" not in result.stderr


def test_two_plugins_deriving_one_anchor_are_reported(tmp_path):
    """`@scope/a-b` and `@scope/a_b` both sanitise to `scope__a_b`. Their
    coverage cannot be told apart, and silently skipping the second is the same
    quiet drop this script was fixed for."""
    plugins = {
        "plugins/a": {"name": "@scope/a-b"},
        "plugins/b": {"name": "@scope/a_b"},
    }
    build_workspace(tmp_path, "ws", plugins)
    bin_dir = write_gh_shim(tmp_path, plugins)

    result = run_generate(tmp_path, "ws", bin_dir)

    assert result.returncode == 0, result.stderr
    assert "already claimed by plugins/a" in result.stderr
    assert "scope__a_b" in result.stderr


def test_a_plugin_without_a_metadata_package_entity_is_skipped(tmp_path):
    """Not-deployed plugins never reach a browser, so an anchor for one would
    only be a path nothing ever writes to."""
    plugins = {"plugins/kept": {"name": "@scope/kept"}}
    ws = build_workspace(tmp_path, "ws", plugins)
    plugins["plugins/dropped"] = {"name": "@scope/dropped"}
    (ws / "plugins-list.yaml").write_text("plugins/kept:\nplugins/dropped:\n")
    bin_dir = write_gh_shim(tmp_path, plugins)

    result = run_generate(tmp_path, "ws", bin_dir)

    assert result.returncode == 0, result.stderr
    assert "[SKIP] plugins/dropped" in result.stdout
    assert anchors(tmp_path, "ws") == ["scope.kept", "scope__kept"]


def test_generating_nothing_is_an_error(tmp_path):
    """A workspace where every plugin was skipped produced an empty directory
    and a green run, which reads as "no coverage to collect" rather than
    "misconfigured"."""
    plugins = {"plugins/a": {"name": "@scope/a"}}
    ws = build_workspace(tmp_path, "ws", plugins)
    (ws / "metadata" / "packages.yaml").write_text("  packageName: @scope/other\n")
    bin_dir = write_gh_shim(tmp_path, plugins)

    result = run_generate(tmp_path, "ws", bin_dir)

    assert result.returncode == 1
    assert "no anchor file generated" in result.stderr
