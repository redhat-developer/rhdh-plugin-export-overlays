"""Tests for the Step 5 / Step 6 wiring in scripts/update-index.sh.

validateCatalogIndex.py is unit-tested directly in test_validateCatalogIndex.py; what
is tested here is the thing those tests cannot see — whether update-index.sh actually
runs it, passes the registries through, and turns its exit code into the right build
outcome. That wiring is the whole contract with CI: a `--validate-mode gate` that keeps
exiting 0 is exactly the silent pass this check exists to prevent.

The runs are hermetic. Steps 1, 2 and 4 are replaced by stubs (they query registries),
and the `catalog-index/` and `plugin_builds/` trees are written directly, as if those
steps had produced them. Only Step 5 runs for real.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
UPDATE_INDEX = SCRIPTS_DIR / "update-index.sh"

REGISTRY = "quay.io/rhdh"
COMMUNITY_REGISTRY = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays"
DIGEST = "sha256:" + "a" * 64

# The scripts update-index.sh calls that reach a container registry. Replaced with
# no-ops so the wiring can be exercised offline.
STUBBED = ("bootstrapPluginBuilds.py", "generateCatalogIndex.py")

# update-index.sh ends by importing two functions from generatePluginBuildInfo to print
# the fallback-rebuild CTA, so the stub has to satisfy that import as well as being
# runnable as a script.
GENERATE_PLUGIN_BUILD_INFO_STUB = """
import sys


def collect_fallback_entries(plugin_builds_dir):
    return []


def print_fallback_rebuild_cta(entries):
    pass


if __name__ == "__main__":
    sys.exit(0)
"""


def build_stub_repo(tmp_path, packages, builds, index_json=None):
    """Lay out a repo update-index.sh will treat as its own checkout.

    The script derives everything from its own location (`dirname $0`), so symlinking
    the real scripts into `<tmp>/scripts/` is what relocates the run onto the fixture
    — the same technique shell_harness.build_fake_repo uses for the coverage scripts.
    """
    root = tmp_path / "repo"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)

    for name in (
        "update-index.sh",
        "validateCatalogIndex.py",
        "plugin_utils.py",
        "catalog-index-validation-allowlist.txt",
    ):
        (scripts / name).symlink_to(SCRIPTS_DIR / name)

    for name in STUBBED:
        (scripts / name).write_text("import sys\nsys.exit(0)\n", encoding="utf-8")
    (scripts / "generatePluginBuildInfo.py").write_text(
        GENERATE_PLUGIN_BUILD_INFO_STUB, encoding="utf-8"
    )

    output_dir = root / "catalog-index"
    output_dir.mkdir()
    (output_dir / "dynamic-plugins.default.yaml").write_text(
        yaml.safe_dump({"plugins": packages}), encoding="utf-8"
    )
    if index_json is not None:
        (output_dir / "index.json").write_text(json.dumps(index_json), encoding="utf-8")

    for image, fields in builds.items():
        workspace = root / "plugin_builds" / "ws"
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / f"{image}.json").write_text(
            json.dumps({image: fields}), encoding="utf-8"
        )

    return root


def python_shim(tmp_path):
    """A `python` on PATH.

    update-index.sh invokes `python`, not `python3`. CI images provide it; a developer
    machine often does not, and without the shim these tests would fail for a reason
    that has nothing to do with the code under test.
    """
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    shim = bindir / "python"
    shim.write_text(f'#!/usr/bin/env bash\nexec "{sys.executable}" "$@"\n')
    shim.chmod(0o755)
    return bindir


def run_update_index(root, tmp_path, *args):
    """Run the fixture's update-index.sh with a scrubbed environment."""
    bindir = python_shim(tmp_path)
    env = {
        "PATH": f"{bindir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
        "HOME": os.environ.get("HOME", "/tmp"),
        # Inherited by the symlinked scripts, which import plugin_utils as a sibling.
        "PYTHONPATH": str(SCRIPTS_DIR),
    }
    return subprocess.run(
        [str(root / "scripts" / "update-index.sh"), "--registry", REGISTRY, *args],
        env=env,
        cwd=str(root),
        capture_output=True,
        text=True,
        timeout=120,
    )


def resolved(image, digest=DIGEST, **extra):
    return {
        "workspacePath": f"ws/plugins/{image}",
        "registryReference": f"{REGISTRY}/{image}@{digest}",
        "digest": digest,
        **extra,
    }


@pytest.fixture
def clean_repo(tmp_path):
    """A repo whose generated index has nothing wrong with it."""
    return build_stub_repo(
        tmp_path,
        packages=[{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}", "enabled": True}],
        builds={"plugin-a": resolved("plugin-a")},
    )


@pytest.fixture
def broken_repo(tmp_path):
    """A repo whose index ships a package the registry never resolved.

    This is the productized index's live defect, reproduced: plugin_builds/ carries a
    registryReference and no digest because the lookup reported "Image not found in
    registry", and the package shipped anyway.
    """
    return build_stub_repo(
        tmp_path,
        packages=[{"package": f"oci://{REGISTRY}/plugin-a:2.0.0--0.4.0"}],
        builds={"plugin-a": {"registryReference": f"{REGISTRY}/plugin-a:2.0.0--0.4.0"}},
    )


class TestValidationRuns:
    def test_a_clean_index_passes(self, clean_repo, tmp_path):
        result = run_update_index(clean_repo, tmp_path)
        assert result.returncode == 0, result.stderr
        assert "Step 5: Validate the generated catalog index" in result.stdout
        assert "Catalog index validation passed" in result.stdout

    def test_findings_are_reported(self, broken_repo, tmp_path):
        result = run_update_index(broken_repo, tmp_path)
        assert "unresolved-image" in result.stdout

    def test_the_community_registry_is_passed_through(self, tmp_path):
        """Without it, every community-tier package reads as registry-not-allowed."""
        root = build_stub_repo(
            tmp_path,
            packages=[{"package": f"oci://{COMMUNITY_REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
        )
        result = run_update_index(
            root, tmp_path, "--community-registry", COMMUNITY_REGISTRY
        )
        assert result.returncode == 0, result.stderr
        assert "registry-not-allowed" not in result.stdout


class TestValidateMode:
    def test_report_mode_does_not_fail_the_build(self, broken_repo, tmp_path):
        """The default. It must say out loud that it is not failing on the findings —
        otherwise a reader takes the errors for a swallowed failure."""
        result = run_update_index(broken_repo, tmp_path)
        assert result.returncode == 0, result.stderr
        assert "continuing because --validate-mode is 'report'" in result.stderr
        assert "--validate-mode gate" in result.stderr

    def test_gate_mode_fails_the_build(self, broken_repo, tmp_path):
        result = run_update_index(broken_repo, tmp_path, "--validate-mode", "gate")
        assert result.returncode == 1
        assert "Catalog index validation failed" in result.stderr

    def test_gate_mode_passes_a_clean_index(self, clean_repo, tmp_path):
        """A gate that fails on everything is as useless as one that fails on nothing."""
        result = run_update_index(clean_repo, tmp_path, "--validate-mode", "gate")
        assert result.returncode == 0, result.stderr

    def test_off_mode_skips_validation(self, broken_repo, tmp_path):
        result = run_update_index(broken_repo, tmp_path, "--validate-mode", "off")
        assert result.returncode == 0, result.stderr
        assert "Skipped (--validate-mode off)" in result.stdout
        assert "unresolved-image" not in result.stdout

    def test_an_unknown_mode_is_rejected_before_any_work(self, clean_repo, tmp_path):
        """A typo must not silently degrade to the permissive mode."""
        result = run_update_index(clean_repo, tmp_path, "--validate-mode", "gates")
        assert result.returncode != 0
        assert "Invalid --validate-mode: gates" in result.stderr
        assert "Step 1" not in result.stdout


class TestValidationOutputs:
    def test_validation_json_is_written(self, broken_repo, tmp_path):
        out = broken_repo / "validation.json"
        result = run_update_index(
            broken_repo, tmp_path, "--validation-json", str(out)
        )
        assert result.returncode == 0, result.stderr
        payload = json.loads(out.read_text())
        assert payload["status"] == "fail"
        assert {f["rule"] for f in payload["findings"]} == {
            "unresolved-image",
            "not-digest-pinned",
        }

    def test_a_custom_allowlist_suppresses_the_finding(self, broken_repo, tmp_path):
        allowlist = broken_repo / "allowlist.txt"
        allowlist.write_text(
            "# TODO(RHIDP-1): tracked\nunresolved-image ^plugin-a$\n", encoding="utf-8"
        )
        result = run_update_index(
            broken_repo,
            tmp_path,
            "--validate-mode",
            "gate",
            "--validate-allowlist",
            str(allowlist),
        )
        assert result.returncode == 0, result.stderr
        assert "RHIDP-1" in result.stdout

    def test_the_validate_stage_lands_in_the_build_report(self, broken_repo, tmp_path):
        report = broken_repo / "build-report.json"
        report.write_text(
            json.dumps({"metadata": {}, "plugins": {"plugin-a": {"stages": {}}}}),
            encoding="utf-8",
        )
        result = run_update_index(broken_repo, tmp_path, "--report-file", str(report))
        assert result.returncode == 0, result.stderr
        data = json.loads(report.read_text())
        stage = data["plugins"]["plugin-a"]["stages"]["validate"]
        assert stage["status"] == "fail"
        assert any("unresolved-image" in e for e in stage["errors"])


class TestSanityCheck:
    def test_it_is_skipped_unless_asked_for(self, clean_repo, tmp_path):
        """It pulls every artifact in the index; nothing should opt into that by accident."""
        result = run_update_index(clean_repo, tmp_path)
        assert "Step 6: Catalog index sanity check — Skipped" in result.stdout

    def test_a_missing_harness_fails_loudly(self, clean_repo, tmp_path):
        """A silent skip would report a green index that nothing installed."""
        result = run_update_index(clean_repo, tmp_path, "--sanity-check")
        assert result.returncode == 1
        assert "smoke-tests-native" in result.stderr
