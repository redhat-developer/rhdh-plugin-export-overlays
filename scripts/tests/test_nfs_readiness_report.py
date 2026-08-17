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
cannot narrow again without a red test — and they cover all three places that read it
(the classifier, the summary denominator, and the two per-support-tier tables), because
the original bug was precisely those places disagreeing.

What these do NOT cover: the ``--oci`` path. Reaching a real registry is what makes
``classify_features`` meaningful, and it is exactly what a hermetic test cannot do — so
the ``nfs-ready`` / ``no-features`` split itself is verified only by the workflow run.
What is verified here is that a package reaches that classification step at all, which is
the bug that occurred.
"""

import json

import pytest

from tests.shell_harness import NFS_SCRIPT, run_script

# Roles that are frontend surface, and the ones that are not. The module roles are the
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


def _repo(tmp_path, packages):
    """Build a minimal REPO_ROOT the script can scan: the two tier files, one workspace.

    ``REPO_ROOT`` is the script's own documented seam, so the run stays hermetic — no
    network, and no dependence on how the real workspaces happen to be shaped today.
    """
    (tmp_path / "rhdh-supported-packages.txt").write_text("")
    (tmp_path / "rhdh-community-packages.txt").write_text("")
    meta = tmp_path / "workspaces" / "sample" / "metadata"
    meta.mkdir(parents=True)
    for name, role, artifact in packages:
        slug = name.replace("@", "").replace("/", "-")
        (meta / f"{slug}.yaml").write_text(_metadata(name, role, artifact))
    return tmp_path


def _run(repo_root, *args):
    result = run_script(NFS_SCRIPT, *args, env={"REPO_ROOT": str(repo_root)})
    assert result.returncode == 0, result.stderr
    return result


def _classified(repo_root):
    return {
        entry["packageName"]: entry
        for entry in json.loads(_run(repo_root, "--json").stdout)
    }


@pytest.mark.parametrize("role", FRONTEND_ROLES)
def test_frontend_roles_are_not_dismissed_as_backend_only(tmp_path, role):
    """Both frontend roles must reach classification rather than being ruled out.

    Without ``--oci`` the script cannot read backstage.features, so the honest answer is
    ``unknown``. That is the assertion: unknown means "we did not look", whereas
    backend-only means "there is nothing to look at" — and for these packages there is.
    """
    root = _repo(
        tmp_path, [("@scope/plugin-x", role, "oci://ghcr.io/example/plugin-x:1.0.0")]
    )
    entry = _classified(root)["@scope/plugin-x"]
    assert entry["role"] == role
    assert entry["status"] == "unknown"
    # The decision is emitted once and reused by every downstream filter.
    assert entry["frontend"] is True


@pytest.mark.parametrize("role", BACKEND_ROLES)
def test_backend_roles_are_classified_backend_only(tmp_path, role):
    """The widened filter must not sweep backend packages in with the frontend ones."""
    root = _repo(
        tmp_path, [("@scope/plugin-y", role, "oci://ghcr.io/example/plugin-y:1.0.0")]
    )
    entry = _classified(root)["@scope/plugin-y"]
    assert entry["status"] == "backend-only"
    assert entry["frontend"] is False


def test_a_frontend_module_shipping_a_local_path_is_baked_in_not_backend_only(tmp_path):
    """A local dist path means the package ships in the RHDH image, for modules too.

    The old filter reached ``backend-only`` first and so could never report ``baked-in``
    for a module, hiding the fact that the artifact is not published at all.
    """
    root = _repo(
        tmp_path,
        [
            (
                "@scope/plugin-z",
                "frontend-plugin-module",
                "./dynamic-plugins/dist/scope-plugin-z",
            )
        ],
    )
    assert _classified(root)["@scope/plugin-z"]["status"] == "baked-in"


# A mixed set: one plugin, one module, and both backend roles. Every count the markdown
# prints has to partition this the same way the classifier did.
MIXED = [
    ("@scope/plugin-a", "frontend-plugin", "oci://ghcr.io/example/a:1.0.0"),
    ("@scope/plugin-b", "frontend-plugin-module", "oci://ghcr.io/example/b:1.0.0"),
    ("@scope/plugin-c", "backend-plugin", "oci://ghcr.io/example/c:1.0.0"),
    ("@scope/plugin-d", "backend-plugin-module", "oci://ghcr.io/example/d:1.0.0"),
]


def test_the_markdown_denominator_counts_both_frontend_roles(tmp_path):
    """The summary total is a second read of the classification — it drifted from it once.

    Fixing only the classifier left the markdown's ``total_frontend`` counting
    ``frontend-plugin`` alone, so the report would classify a module correctly and then
    leave it out of the count printed beside it. Both backend roles are in the fixture so
    a filter that merely excluded ``backend-plugin`` would show up here as a total of 3.
    """
    stdout = _run(_repo(tmp_path, MIXED), "--markdown").stdout
    assert "**Frontend plugins:** 2 total" in stdout
    assert "| — backend-only | 2 |" in stdout


def test_the_per_tier_table_counts_and_lists_both_frontend_roles(tmp_path):
    """The per-tier header and table are two more reads of the same classification.

    Nothing else asserts them, and a narrowed filter here is invisible: the header count
    silently drops by one and the module's row silently vanishes from the table.
    """
    stdout = _run(_repo(tmp_path, MIXED), "--markdown").stdout
    # With both tier files empty every package falls to the "other" tier.
    assert "#### Other (0/2 frontend plugins NFS-ready — 0%)" in stdout
    assert "| @scope/plugin-b | sample |" in stdout
