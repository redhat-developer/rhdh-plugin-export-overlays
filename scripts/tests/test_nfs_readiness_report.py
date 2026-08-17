"""Tests for scripts/nfs-readiness-report.sh — which packages count as frontend surface.

The report is published to the wiki on a schedule and is the number people quote when
asking how far the NFS migration has got. Its denominator is therefore load-bearing, and
it was wrong: the role filter admitted only ``frontend-plugin``, so every
``frontend-plugin-module`` package was bucketed ``backend-only`` — "not applicable" —
even though those packages carry ``backstage.features`` and load through the same
module-federation remote as a plugin. Five packages were invisible, four of them already
NFS-ready, and the reported total read 75 instead of 80.

A miscount here is quiet in the worst way: the report still renders, the percentage still
looks plausible, and nothing fails. These tests pin the classification so the filter
cannot narrow again without a red test.

What these do NOT cover: the ``--oci`` path. Reaching a real registry is what makes
``classify_features`` meaningful, and it is exactly what a hermetic test cannot do — so
the ``nfs-ready`` / ``no-features`` split itself is verified only by the workflow run.
What is verified here is that a package reaches that classification step at all, which is
the bug that occurred.
"""

import json
import subprocess

import pytest

from tests.shell_harness import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "nfs-readiness-report.sh"

# Roles that are frontend surface, and the one that is not. The module roles are the
# regression: they were classified as backend-only.
FRONTEND_ROLES = ["frontend-plugin", "frontend-plugin-module"]
BACKEND_ROLES = ["backend-plugin", "backend-plugin-module"]


def _metadata(package_name: str, role: str, artifact: str) -> str:
    return (
        "apiVersion: extensions.backstage.io/v1alpha1\n"
        "kind: Package\n"
        "metadata:\n"
        f"  name: {package_name.split('/')[-1]}\n"
        "spec:\n"
        f"  packageName: '{package_name}'\n"
        f"  dynamicArtifact: {artifact}\n"
        "  backstage:\n"
        f"    role: {role}\n"
    )


@pytest.fixture
def repo(tmp_path):
    """A minimal REPO_ROOT the script can scan: the two tier files plus one workspace.

    ``REPO_ROOT`` is the script's own documented seam, so the run stays hermetic — no
    network, and no dependence on how the real workspaces happen to be shaped today.
    """

    def build(packages):
        (tmp_path / "rhdh-supported-packages.txt").write_text("")
        (tmp_path / "rhdh-community-packages.txt").write_text("")
        meta = tmp_path / "workspaces" / "sample" / "metadata"
        meta.mkdir(parents=True)
        for name, role, artifact in packages:
            slug = name.replace("@", "").replace("/", "-")
            (meta / f"{slug}.yaml").write_text(_metadata(name, role, artifact))
        return tmp_path

    return build


def _run(repo_root, *args):
    result = subprocess.run(
        [str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env={"REPO_ROOT": str(repo_root), "PATH": __import__("os").environ["PATH"]},
    )
    assert result.returncode == 0, result.stderr
    return {entry["packageName"]: entry for entry in json.loads(result.stdout)}


@pytest.mark.parametrize("role", FRONTEND_ROLES)
def test_frontend_roles_are_not_dismissed_as_backend_only(repo, role):
    """Both frontend roles must reach classification rather than being ruled out.

    Without ``--oci`` the script cannot read backstage.features, so the honest answer is
    ``unknown``. That is the assertion: unknown means "we did not look", whereas
    backend-only means "there is nothing to look at" — and for these packages there is.
    """
    root = repo([("@scope/plugin-x", role, "oci://ghcr.io/example/plugin-x:1.0.0")])
    entry = _run(root)["@scope/plugin-x"]
    assert entry["role"] == role
    assert entry["status"] == "unknown"


@pytest.mark.parametrize("role", BACKEND_ROLES)
def test_backend_roles_stay_out_of_the_frontend_denominator(repo, role):
    """The widened filter must not sweep backend packages in with the frontend ones."""
    root = repo([("@scope/plugin-y", role, "oci://ghcr.io/example/plugin-y:1.0.0")])
    assert _run(root)["@scope/plugin-y"]["status"] == "backend-only"


def test_a_frontend_module_shipping_a_local_path_is_baked_in_not_backend_only(repo):
    """A local dist path means the package ships in the RHDH image, for modules too.

    The old filter reached ``backend-only`` first and so could never report ``baked-in``
    for a module, hiding the fact that the artifact is not published at all.
    """
    root = repo(
        [
            (
                "@scope/plugin-z",
                "frontend-plugin-module",
                "./dynamic-plugins/dist/scope-plugin-z",
            )
        ]
    )
    assert _run(root)["@scope/plugin-z"]["status"] == "baked-in"


def test_the_markdown_denominator_counts_both_frontend_roles(repo):
    """The summary total is a second, independent filter — it drifted from the first.

    Fixing only the classification left the markdown's ``total_frontend`` still counting
    ``frontend-plugin`` alone, so the report would classify a module correctly and then
    leave it out of the count it prints. Both had to move together.
    """
    root = repo(
        [
            ("@scope/plugin-a", "frontend-plugin", "oci://ghcr.io/example/a:1.0.0"),
            (
                "@scope/plugin-b",
                "frontend-plugin-module",
                "oci://ghcr.io/example/b:1.0.0",
            ),
            ("@scope/plugin-c", "backend-plugin", "oci://ghcr.io/example/c:1.0.0"),
        ]
    )
    result = subprocess.run(
        [str(SCRIPT), "--markdown"],
        capture_output=True,
        text=True,
        env={"REPO_ROOT": str(root), "PATH": __import__("os").environ["PATH"]},
    )
    assert result.returncode == 0, result.stderr
    # Two frontend packages, one backend — the frontend total must read 2, not 1.
    assert "**Frontend plugins:** 2 total" in result.stdout
    assert "| — backend-only | 1 |" in result.stdout
