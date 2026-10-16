"""Tests for scripts/build-smoke-test-config.sh."""

import os
from pathlib import Path
import pytest
import yaml

from tests.shell_harness import SCRIPTS_DIR, run_script

SCRIPT = SCRIPTS_DIR / "build-smoke-test-config.sh"


def _parse_github_output(path: Path) -> dict:
    """Parse key=value and multiline key<<EOF blocks from GITHUB_OUTPUT file."""
    if not path.exists():
        return {}
    content = path.read_text(encoding="utf-8")
    outputs = {}
    lines = content.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if "<<" in line:
            key, delim = line.split("<<", 1)
            val_lines = []
            i += 1
            while i < len(lines) and lines[i] != delim:
                val_lines.append(lines[i])
                i += 1
            outputs[key] = "\n".join(val_lines)
        elif "=" in line:
            key, val = line.split("=", 1)
            outputs[key] = val
        i += 1
    return outputs


def test_missing_workspace_fails(tmp_path):
    res = run_script(SCRIPT, cwd=tmp_path)
    assert res.returncode != 0
    assert "WORKSPACE_PATH is required" in res.stderr


def test_no_published_exports(tmp_path):
    gh_output = tmp_path / "github_output"
    res = run_script(
        SCRIPT,
        "workspaces/test-ws",
        cwd=tmp_path,
        env={"GITHUB_OUTPUT": str(gh_output)},
    )
    assert res.returncode == 0
    assert "No published exports provided." in res.stdout
    outputs = _parse_github_output(gh_output)
    assert outputs.get("has-runnable-plugins") == "false"
    assert outputs.get("skip-tests-missing-env") == "false"
    assert outputs.get("missing-metadata-plugins") == ""


def test_valid_exports_generates_config(tmp_path):
    ws_dir = tmp_path / "workspaces" / "test-ws"
    meta_dir = ws_dir / "metadata"
    meta_dir.mkdir(parents=True)

    plugin_meta = (
        "apiVersion: extensions.backstage.io/v1alpha1\n"
        "kind: Package\n"
        "spec:\n"
        "  packageName: '@scope/plugin-a'\n"
        "  appConfigExamples:\n"
        "    - content:\n"
        "        testKey: testVal\n"
    )
    (meta_dir / "plugin-a.yaml").write_text(plugin_meta)

    # Optional root app-config
    (tmp_path / "smoke-tests").mkdir()
    (tmp_path / "smoke-tests" / "app-config.yaml").write_text("app:\n  title: Root\n")

    gh_output = tmp_path / "github_output"
    export_ref = "ghcr.io/org/repo/scope-plugin-a:pr_123__1.0.0!scope-plugin-a"

    res = run_script(
        SCRIPT,
        "workspaces/test-ws",
        export_ref,
        cwd=tmp_path,
        env={
            "GITHUB_WORKSPACE": str(tmp_path),
            "GITHUB_OUTPUT": str(gh_output),
        },
    )
    assert res.returncode == 0, f"Script failed: {res.stderr}"

    test_yaml_path = ws_dir / "smoke-tests" / "dynamic-plugins.test.yaml"
    assert test_yaml_path.exists()

    content = yaml.safe_load(test_yaml_path.read_text())
    assert "plugins" in content
    assert len(content["plugins"]) == 1
    plugin = content["plugins"][0]
    assert plugin["package"] == "oci://ghcr.io/org/repo/scope-plugin-a:pr_123__1.0.0"
    assert plugin["enabled"] is True
    assert plugin["pluginConfig"]["testKey"] == "testVal"

    copied_root_config = ws_dir / "smoke-tests" / "app-config.yaml"
    assert copied_root_config.exists()
    assert "Root" in copied_root_config.read_text()

    outputs = _parse_github_output(gh_output)
    assert outputs.get("has-runnable-plugins") == "true"
    assert outputs.get("skip-tests-missing-env") == "false"


def test_missing_metadata_plugin_skipped(tmp_path):
    ws_dir = tmp_path / "workspaces" / "test-ws"
    (ws_dir / "metadata").mkdir(parents=True)

    gh_output = tmp_path / "github_output"
    export_ref = "ghcr.io/org/repo/missing-plugin:pr_123__1.0.0"

    res = run_script(
        SCRIPT,
        "workspaces/test-ws",
        export_ref,
        cwd=tmp_path,
        env={
            "GITHUB_WORKSPACE": str(tmp_path),
            "GITHUB_OUTPUT": str(gh_output),
        },
    )
    assert res.returncode == 0

    test_yaml_path = ws_dir / "smoke-tests" / "dynamic-plugins.test.yaml"
    assert test_yaml_path.exists()
    content = yaml.safe_load(test_yaml_path.read_text())
    assert content["plugins"] == []

    outputs = _parse_github_output(gh_output)
    assert outputs.get("has-runnable-plugins") == "false"
    assert "missing-plugin" in outputs.get("missing-metadata-plugins", "")


def test_test_plugin_skipped_without_warning(tmp_path):
    ws_dir = tmp_path / "workspaces" / "test-ws"
    (ws_dir / "metadata").mkdir(parents=True)

    gh_output = tmp_path / "github_output"
    export_ref = "ghcr.io/org/repo/fixture-test:pr_123__1.0.0"

    res = run_script(
        SCRIPT,
        "workspaces/test-ws",
        export_ref,
        cwd=tmp_path,
        env={
            "GITHUB_WORKSPACE": str(tmp_path),
            "GITHUB_OUTPUT": str(gh_output),
        },
    )
    assert res.returncode == 0
    assert "is a test plugin without metadata" in res.stdout

    outputs = _parse_github_output(gh_output)
    assert outputs.get("has-runnable-plugins") == "false"
    assert outputs.get("missing-metadata-plugins") == ""


def test_env_vars_missing_test_env_skips(tmp_path):
    ws_dir = tmp_path / "workspaces" / "test-ws"
    meta_dir = ws_dir / "metadata"
    meta_dir.mkdir(parents=True)

    plugin_meta = (
        "apiVersion: extensions.backstage.io/v1alpha1\n"
        "kind: Package\n"
        "spec:\n"
        "  packageName: 'plugin-env'\n"
        "  appConfigExamples:\n"
        "    - content:\n"
        "        dynamicPlugins:\n"
        "          apiKey: ${MY_SECRET_KEY}\n"
    )
    (meta_dir / "plugin-env.yaml").write_text(plugin_meta)

    gh_output = tmp_path / "github_output"
    export_ref = "ghcr.io/org/repo/plugin-env:pr_123__1.0.0"

    res = run_script(
        SCRIPT,
        "workspaces/test-ws",
        export_ref,
        cwd=tmp_path,
        env={
            "GITHUB_WORKSPACE": str(tmp_path),
            "GITHUB_OUTPUT": str(gh_output),
        },
    )
    assert res.returncode == 0
    assert "::warning::" in res.stdout

    outputs = _parse_github_output(gh_output)
    assert outputs.get("skip-tests-missing-env") == "true"
    assert outputs.get("has-runnable-plugins") == "false"


def test_env_vars_with_matching_test_env(tmp_path):
    ws_dir = tmp_path / "workspaces" / "test-ws"
    meta_dir = ws_dir / "metadata"
    meta_dir.mkdir(parents=True)
    smoke_dir = ws_dir / "smoke-tests"
    smoke_dir.mkdir(parents=True)
    (smoke_dir / "test.env").write_text("MY_SECRET_KEY=12345\n")

    plugin_meta = (
        "apiVersion: extensions.backstage.io/v1alpha1\n"
        "kind: Package\n"
        "spec:\n"
        "  packageName: 'plugin-env'\n"
        "  appConfigExamples:\n"
        "    - content:\n"
        "        dynamicPlugins:\n"
        "          apiKey: ${MY_SECRET_KEY}\n"
    )
    (meta_dir / "plugin-env.yaml").write_text(plugin_meta)

    gh_output = tmp_path / "github_output"
    export_ref = "ghcr.io/org/repo/plugin-env:pr_123__1.0.0"

    res = run_script(
        SCRIPT,
        "workspaces/test-ws",
        export_ref,
        cwd=tmp_path,
        env={
            "GITHUB_WORKSPACE": str(tmp_path),
            "GITHUB_OUTPUT": str(gh_output),
        },
    )
    assert res.returncode == 0
    outputs = _parse_github_output(gh_output)
    assert outputs.get("skip-tests-missing-env") == "false"
    assert outputs.get("has-runnable-plugins") == "true"


def test_env_vars_missing_from_test_env_exits_with_error(tmp_path):
    ws_dir = tmp_path / "workspaces" / "test-ws"
    meta_dir = ws_dir / "metadata"
    meta_dir.mkdir(parents=True)
    smoke_dir = ws_dir / "smoke-tests"
    smoke_dir.mkdir(parents=True)
    (smoke_dir / "test.env").write_text("OTHER_VAR=12345\n")

    plugin_meta = (
        "apiVersion: extensions.backstage.io/v1alpha1\n"
        "kind: Package\n"
        "spec:\n"
        "  packageName: 'plugin-env'\n"
        "  appConfigExamples:\n"
        "    - content:\n"
        "        dynamicPlugins:\n"
        "          apiKey: ${REQUIRED_KEY}\n"
    )
    (meta_dir / "plugin-env.yaml").write_text(plugin_meta)

    export_ref = "ghcr.io/org/repo/plugin-env:pr_123__1.0.0"

    gh_output = tmp_path / "github_output"
    res = run_script(
        SCRIPT,
        "workspaces/test-ws",
        export_ref,
        cwd=tmp_path,
        env={
            "GITHUB_WORKSPACE": str(tmp_path),
            "GITHUB_OUTPUT": str(gh_output),
        },
    )
    assert res.returncode != 0
    assert "::error::" in res.stderr
    assert "REQUIRED_KEY" in res.stderr
    outputs = _parse_github_output(gh_output)
    assert outputs.get("has-runnable-plugins") == "false"


def test_published_exports_file_fallback(tmp_path):
    ws_dir = tmp_path / "workspaces" / "test-ws"
    meta_dir = ws_dir / "metadata"
    meta_dir.mkdir(parents=True)

    plugin_meta = (
        "apiVersion: extensions.backstage.io/v1alpha1\n"
        "kind: Package\n"
        "spec:\n"
        "  packageName: 'plugin-a'\n"
        "  appConfigExamples:\n"
        "    - content:\n"
        "        k: v\n"
    )
    (meta_dir / "plugin-a.yaml").write_text(plugin_meta)

    pub_exports_dir = tmp_path / "published-exports"
    pub_exports_dir.mkdir()
    (pub_exports_dir / "published-exports.txt").write_text(
        "ghcr.io/org/repo/plugin-a:pr_99__1.0.0\n"
    )

    gh_output = tmp_path / "github_output"
    res = run_script(
        SCRIPT,
        "workspaces/test-ws",
        cwd=tmp_path,
        env={
            "GITHUB_WORKSPACE": str(tmp_path),
            "GITHUB_OUTPUT": str(gh_output),
        },
    )
    assert res.returncode == 0
    outputs = _parse_github_output(gh_output)
    assert outputs.get("has-runnable-plugins") == "true"
