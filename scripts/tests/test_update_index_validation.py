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

from tests.shell_harness import link_script

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

    The script derives everything from its own location (`dirname $0`), so
    `shell_harness.link_script` — which symlinks a real script into `<root>/scripts/`
    for exactly this reason — is what relocates the run onto the fixture.
    """
    root = tmp_path / "repo"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)

    for name in ("update-index.sh", "validateCatalogIndex.py", "plugin_utils.py"):
        link_script(root, name)

    # An EMPTY allowlist of the fixture's own, passed explicitly by run_update_index.
    # Symlinking the shipped one would not work and would not be wanted: the script
    # derives its default from `Path(__file__).resolve()`, and .resolve() follows the
    # symlink back to the real repo — so every test here silently read the committed
    # allowlist, and adding an entry to it would have broken this suite for a reason
    # that has nothing to do with the wiring it tests.
    (root / "allowlist.txt").write_text(
        "# fixture allowlist — deliberately empty\n", encoding="utf-8"
    )

    # The stubs append to a call log, so a test can prove a step did NOT run instead of
    # inferring it from an absent banner — the idiom shell_harness.write_stub_cli uses.
    calls = root / "steps.calls"
    for name in STUBBED:
        (scripts / name).write_text(
            "import sys, pathlib\n"
            f"pathlib.Path({str(calls)!r}).open('a').write({name!r} + '\\n')\n"
            "sys.exit(0)\n",
            encoding="utf-8",
        )
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


def toolchain_shims(tmp_path, node_version="v24.18.0", yarn_version="4.17.1"):
    """Stub `node`, `yarn` and the smoke-tests-native/ directory Step 6 needs.

    `yarn` records its argv so a test can assert on the path the harness was handed.
    That is the assertion the `--sanity-check` happy path was missing, and its absence
    is why a command substitution that resolved to the empty string shipped: every
    existing test stopped at a guard before `yarn smoke` was ever reached.
    """
    bindir = python_shim(tmp_path)
    (bindir / "node").write_text(f'#!/usr/bin/env bash\necho "{node_version}"\n')
    (bindir / "node").chmod(0o755)
    argv_log = tmp_path / "yarn.argv"
    (bindir / "yarn").write_text(
        "#!/usr/bin/env bash\n"
        f'if [[ "$1" == "--version" ]]; then echo "{yarn_version}"; exit 0; fi\n'
        f'printf "%s\\n" "$@" >> "{argv_log}"\n'
        "exit 0\n"
    )
    (bindir / "yarn").chmod(0o755)
    return bindir, argv_log


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


def run_update_index(root, *args, bindir=None):
    """Run the fixture's update-index.sh with a scrubbed environment.

    The fixture's own empty allowlist is passed unless the caller overrides it, so a
    change to the committed allowlist cannot alter these results.
    """
    bindir = bindir or python_shim(root.parent)
    if "--validate-allowlist" not in args:
        args = (*args, "--validate-allowlist", str(root / "allowlist.txt"))
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
        result = run_update_index(clean_repo)
        assert result.returncode == 0, result.stderr
        assert "Step 5: Validate the generated catalog index" in result.stdout
        assert "Catalog index validation passed" in result.stdout

    def test_findings_are_reported(self, broken_repo, tmp_path):
        result = run_update_index(broken_repo)
        assert "unresolved-image" in result.stdout

    def test_the_community_registry_is_passed_through(self, tmp_path):
        """Without it, every community-tier package reads as registry-not-allowed."""
        root = build_stub_repo(
            tmp_path,
            packages=[{"package": f"oci://{COMMUNITY_REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
        )
        result = run_update_index(
            root, "--community-registry", COMMUNITY_REGISTRY
        )
        assert result.returncode == 0, result.stderr
        assert "registry-not-allowed" not in result.stdout


class TestValidateMode:
    def test_report_mode_does_not_fail_the_build(self, broken_repo, tmp_path):
        """The default. It must say out loud that it is not failing on the findings —
        otherwise a reader takes the errors for a swallowed failure."""
        result = run_update_index(broken_repo)
        assert result.returncode == 0, result.stderr
        assert "continuing because --validate-mode is 'report'" in result.stderr
        assert "--validate-mode gate" in result.stderr

    def test_gate_mode_fails_the_build(self, broken_repo, tmp_path):
        result = run_update_index(broken_repo, "--validate-mode", "gate")
        assert result.returncode == 1
        assert "Catalog index validation failed" in result.stderr

    def test_gate_mode_passes_a_clean_index(self, clean_repo, tmp_path):
        """A gate that fails on everything is as useless as one that fails on nothing."""
        result = run_update_index(clean_repo, "--validate-mode", "gate")
        assert result.returncode == 0, result.stderr

    def test_off_mode_skips_validation(self, broken_repo, tmp_path):
        result = run_update_index(broken_repo, "--validate-mode", "off")
        assert result.returncode == 0, result.stderr
        assert "Skipped (--validate-mode off)" in result.stdout
        assert "unresolved-image" not in result.stdout

    def test_an_unknown_mode_is_rejected_before_any_work(self, clean_repo):
        """A typo must not silently degrade to the permissive mode.

        "Before any work" is asserted from the step call log, not from an absent
        banner: a banner assertion passes for the wrong reason the day one is reworded.
        """
        result = run_update_index(clean_repo, "--validate-mode", "gates")
        assert result.returncode != 0
        assert "Invalid --validate-mode: gates" in result.stderr
        assert not (clean_repo / "steps.calls").exists()


class TestValidationOutputs:
    def test_validation_json_is_written(self, broken_repo, tmp_path):
        out = broken_repo / "validation.json"
        result = run_update_index(
            broken_repo, "--validation-json", str(out)
        )
        assert result.returncode == 0, result.stderr
        # That the RULES fire is test_validateCatalogIndex.py's job. What only this
        # level can show is that --validation-json reaches the script and the file
        # lands where it was asked for.
        payload = json.loads(out.read_text())
        assert payload["status"] == "fail"
        assert payload["findings"]

    def test_a_custom_allowlist_suppresses_the_finding(self, broken_repo, tmp_path):
        allowlist = broken_repo / "allowlist.txt"
        allowlist.write_text(
            "# TODO(RHIDP-1): tracked\nunresolved-image ^plugin-a$\n", encoding="utf-8"
        )
        result = run_update_index(
            broken_repo,
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
        result = run_update_index(broken_repo, "--report-file", str(report))
        assert result.returncode == 0, result.stderr
        data = json.loads(report.read_text())
        assert data["plugins"]["plugin-a"]["stages"]["validate"]["status"] == "fail"


class TestPathContainment:
    """CLI-supplied paths are confined to the working directory.

    Every path this script touches arrives from an argv flag, so a bad or hostile value
    could otherwise read or write anywhere the process can reach. Same rule
    smoke-tests-native/src/paths.ts applies to the harness's own flags.
    """

    @pytest.mark.parametrize(
        "flag, value",
        [
            pytest.param("--validation-json", "../escaped.json", id="json_relative_escape"),
            pytest.param("--validation-json", "/tmp/escaped.json", id="json_absolute"),
            pytest.param("--output-dir", "../elsewhere", id="output_dir_escape"),
            pytest.param("--plugin-builds-dir", "/etc", id="builds_dir_absolute"),
            pytest.param(
                "--validate-allowlist", "/etc/passwd", id="allowlist_absolute"
            ),
        ],
    )
    def test_a_path_escaping_the_working_directory_is_refused(
        self, clean_repo, flag, value
    ):
        result = run_update_index(clean_repo, flag, value)
        assert result.returncode != 0
        assert "must resolve inside" in (result.stdout + result.stderr)
        # Named so the operator knows WHICH flag to fix, not just that one is bad.
        expected_flag = {
            "--validate-allowlist": "--allowlist",
            "--validation-json": "--json",
        }.get(flag, flag)
        assert expected_flag in (result.stdout + result.stderr)

    def test_a_path_that_escapes_and_returns_is_judged_on_where_it_lands(
        self, clean_repo
    ):
        """`resolve()` collapses `..` first, so `a/../catalog-index` is contained."""
        result = run_update_index(
            clean_repo, "--output-dir", "elsewhere/../catalog-index"
        )
        assert result.returncode == 0, result.stderr

    def test_the_allowlist_default_is_not_confined(self, clean_repo):
        """It comes from `__file__`, not from argv, so it is not an injection vector.

        Confining it would reject the midstream layout outright: there the script runs
        from a synced overlay-repo checkout, reached through a symlink — which is
        exactly how this fixture invokes it too.
        """
        result = subprocess.run(
            [
                str(clean_repo / "scripts" / "update-index.sh"),
                "--registry",
                REGISTRY,
            ],
            env={
                "PATH": f"{python_shim(clean_repo.parent)}:{os.environ.get('PATH', '')}",
                "HOME": os.environ.get("HOME", "/tmp"),
                "PYTHONPATH": str(SCRIPTS_DIR),
            },
            cwd=str(clean_repo),
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert result.returncode == 0, result.stderr
        assert "must resolve inside" not in result.stdout + result.stderr


class TestSanityCheck:
    def test_it_is_skipped_unless_asked_for(self, clean_repo, tmp_path):
        """It pulls every artifact in the index; nothing should opt into that by accident."""
        result = run_update_index(clean_repo)
        assert "Step 6: Catalog index sanity check — Skipped" in result.stdout

    def test_a_missing_harness_fails_loudly(self, clean_repo, tmp_path):
        """A silent skip would report a green index that nothing installed."""
        result = run_update_index(clean_repo, "--sanity-check")
        assert result.returncode == 1
        assert "smoke-tests-native" in result.stderr

    @pytest.mark.parametrize(
        "output_dir",
        [
            pytest.param(None, id="default"),
            pytest.param("catalog-index", id="relative"),
            pytest.param("./catalog-index", id="dot_relative"),
            pytest.param("ABS", id="absolute"),
        ],
    )
    def test_the_harness_receives_a_resolved_path_to_the_generated_index(
        self, clean_repo, tmp_path, output_dir
    ):
        """The regression test for the bug the missing happy-path coverage allowed.

        `yarn smoke` runs inside `(cd smoke-tests-native && …)`, and its words are
        expanded only when it is about to run — after the cd. A command substitution
        written inline therefore resolved against the harness directory, and with a
        RELATIVE --output-dir (the default) the inner cd failed, the substitution
        yielded the empty string, and the harness was handed
        "/dynamic-plugins.default.yaml". A failed command substitution does not trip
        `set -e`, so nothing caught it.
        """
        (clean_repo / "smoke-tests-native").mkdir()
        bindir, argv_log = toolchain_shims(tmp_path)
        extra = []
        if output_dir is not None:
            resolved_dir = (
                str(clean_repo / "catalog-index") if output_dir == "ABS" else output_dir
            )
            extra = ["--output-dir", resolved_dir]
        result = run_update_index(
            clean_repo, *extra, "--sanity-check", bindir=bindir
        )
        assert result.returncode == 0, result.stderr
        args = argv_log.read_text().split("\n")
        assert "--catalog-index" in args, args
        handed = Path(args[args.index("--catalog-index") + 1])
        assert handed.is_absolute(), handed
        assert handed.is_file(), f"{handed} does not exist"
        assert handed == clean_repo / "catalog-index" / "dynamic-plugins.default.yaml"

    def test_the_exclusions_file_is_passed(self, clean_repo, tmp_path):
        """Without it the harness runs with no tracked exclusions at all."""
        (clean_repo / "smoke-tests-native").mkdir()
        bindir, argv_log = toolchain_shims(tmp_path)
        run_update_index(clean_repo, "--sanity-check", bindir=bindir)
        args = argv_log.read_text().split("\n")
        assert "--exclusions" in args
        assert args[args.index("--exclusions") + 1] == (
            "catalog-index-sanity-excludes.txt"
        )

    @pytest.mark.parametrize(
        "node_version, yarn_version, expected",
        [
            pytest.param("v22.21.0", "4.17.1", "Node 24+", id="node_too_old"),
            pytest.param("v24.18.0", "1.22.22", "Yarn 4+", id="yarn_1"),
        ],
    )
    def test_an_inadequate_toolchain_is_named(
        self, clean_repo, tmp_path, node_version, yarn_version, expected
    ):
        """`command -v yarn` passed for Yarn 1, which then died with an opaque
        "Unsupported option name (--immutable)" blamed on the sanity check."""
        (clean_repo / "smoke-tests-native").mkdir()
        bindir, _ = toolchain_shims(
            tmp_path, node_version=node_version, yarn_version=yarn_version
        )
        result = run_update_index(
            clean_repo, "--sanity-check", bindir=bindir
        )
        assert result.returncode == 1
        assert expected in result.stderr

    def test_gate_mode_stops_before_the_sanity_check_runs(
        self, broken_repo, tmp_path
    ):
        """Pulling ~50 artifacts to validate an index already known to be broken is
        wasted time, and the failure that matters is the one already reported."""
        (broken_repo / "smoke-tests-native").mkdir()
        bindir, argv_log = toolchain_shims(tmp_path)
        result = run_update_index(
            broken_repo,
            "--validate-mode",
            "gate",
            "--sanity-check",
            bindir=bindir,
        )
        assert result.returncode == 1
        assert not argv_log.exists(), "yarn should never have been invoked"
