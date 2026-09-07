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

What these do NOT cover: the ``--oci`` path, and the source-inference path #3284 added for
plugins with a local dist path. Both reach the network — a registry via oras, and
raw.githubusercontent.com via curl — which is exactly what a hermetic suite cannot do. So
the ``nfs-ready`` / ``no-features`` split itself is verified only by the workflow run. What
is verified here is that a package reaches that classification step at all, which is the
bug that occurred.
"""

import json

import pytest

from tests.shell_harness import NFS_SCRIPT, run_script

# Roles that are frontend surface, and the ones that are not. The module roles are the
# regression: they were classified as backend-only.
FRONTEND_ROLES = ["frontend-plugin", "frontend-plugin-module"]
BACKEND_ROLES = ["backend-plugin", "backend-plugin-module"]
# Not a real Backstage role. It exists to pin the predicate as an EXACT match: a prefix or
# glob comparison would admit it as frontend surface while the classifier still called it
# backend-only, putting the same package in both tables under a bogus tier ratio. That
# double-counting is the whole reason the predicate was consolidated.
UNKNOWN_PREFIXED_ROLE = "frontend-plugin-widget"

# A mixed set: one plugin, one module, and both backend roles. Every count the markdown
# prints has to partition this the same way the classifier did.
MIXED = [
    ("@scope/plugin-a", "frontend-plugin", "oci://ghcr.io/example/a:1.0.0"),
    ("@scope/plugin-b", "frontend-plugin-module", "oci://ghcr.io/example/b:1.0.0"),
    ("@scope/plugin-c", "backend-plugin", "oci://ghcr.io/example/c:1.0.0"),
    ("@scope/plugin-d", "backend-plugin-module", "oci://ghcr.io/example/d:1.0.0"),
]


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
    network, and no dependence on how the real workspaces happen to be shaped today. The
    workspace deliberately has no ``source.json``, which is what keeps #3284's source
    inference from reaching out to raw.githubusercontent.com.
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
    result = run_script(
        NFS_SCRIPT, *args, env={"REPO_ROOT": str(repo_root)}, cwd=repo_root
    )
    assert result.returncode == 0, result.stderr
    return result


def _classified(repo_root):
    return {
        entry["packageName"]: entry
        for entry in json.loads(_run(repo_root, "--json").stdout)
    }


def _markdown(repo_root):
    return _run(repo_root, "--markdown").stdout


class TestClassification:
    """What the classifier decides per role, before any output is rendered."""

    @staticmethod
    @pytest.mark.parametrize("role", FRONTEND_ROLES)
    def test_frontend_roles_are_not_dismissed_as_backend_only(tmp_path, role):
        """Both frontend roles must reach classification rather than being ruled out.

        Without ``--oci`` the script cannot read backstage.features, so the honest answer
        is ``unknown``. That is the assertion: unknown means "we did not look", whereas
        backend-only means "there is nothing to look at" — and for these there is.
        """
        root = _repo(
            tmp_path,
            [("@scope/plugin-x", role, "oci://ghcr.io/example/plugin-x:1.0.0")],
        )
        entry = _classified(root)["@scope/plugin-x"]
        assert entry["role"] == role
        assert entry["status"] == "unknown"
        # The decision is emitted once and reused by every downstream filter.
        assert entry["frontend"] is True

    @staticmethod
    @pytest.mark.parametrize("role", BACKEND_ROLES)
    def test_backend_roles_are_classified_backend_only(tmp_path, role):
        """The widened filter must not sweep backend packages in with the frontend ones."""
        root = _repo(
            tmp_path,
            [("@scope/plugin-y", role, "oci://ghcr.io/example/plugin-y:1.0.0")],
        )
        entry = _classified(root)["@scope/plugin-y"]
        assert entry["status"] == "backend-only"
        assert entry["frontend"] is False

    @staticmethod
    def test_a_role_merely_prefixed_frontend_plugin_is_not_frontend_surface(tmp_path):
        """The membership test must be exact, not a prefix match.

        Nothing else pins this, and it is the property the consolidation was for: a looser
        comparison would count the package in the frontend denominator while the
        classifier bucketed it backend-only, so it would appear in both tables at once.
        """
        root = _repo(
            tmp_path,
            [
                (
                    "@scope/plugin-w",
                    UNKNOWN_PREFIXED_ROLE,
                    "oci://ghcr.io/example/w:1.0.0",
                )
            ],
        )
        entry = _classified(root)["@scope/plugin-w"]
        assert entry["frontend"] is False
        assert entry["status"] == "backend-only"
        assert "**Frontend plugins:** 0 total" in _markdown(root)

    @staticmethod
    def test_a_frontend_module_with_a_local_path_still_reaches_classification(tmp_path):
        """A local dist path means the package ships in the RHDH image, for modules too.

        The old filter reached ``backend-only`` first, so a module with a local path could
        never reach the branch that handles that case at all. That branch is what #3284
        turned into source-based inference, replacing the former ``baked-in`` status: the
        script now fetches the upstream package.json and infers ``backstage.features`` from
        its exports.

        This fixture has no ``source.json``, so inference cannot run and the honest answer
        is ``unknown``. The property being pinned is that the package gets there — not the
        label, which is #3284's to define.
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
        entry = _classified(root)["@scope/plugin-z"]
        assert entry["frontend"] is True
        assert entry["status"] == "unknown"


class TestMarkdownOutput:
    """The rendered report — a second and third read of the same classification."""

    @staticmethod
    def test_the_markdown_denominator_counts_both_frontend_roles(tmp_path):
        """The summary total is a second read of the classification — it drifted once.

        Fixing only the classifier left the markdown's ``total_frontend`` counting
        ``frontend-plugin`` alone, so the report would classify a module correctly and then
        leave it out of the count printed beside it. Both backend roles are in the fixture
        so a filter that merely excluded ``backend-plugin`` would show up here as 3.
        """
        stdout = _markdown(_repo(tmp_path, MIXED))
        assert "**Frontend plugins:** 2 total" in stdout
        assert "| — backend-only | 2 |" in stdout

    @staticmethod
    def test_the_per_tier_table_counts_and_lists_both_frontend_roles(tmp_path):
        """The per-tier header and table are two more reads of the same classification.

        Nothing else asserts them, and a narrowed filter here is invisible: the header
        count silently drops by one and the module's row silently vanishes.
        """
        stdout = _markdown(_repo(tmp_path, MIXED))
        # With both tier files empty every package falls to the "other" tier.
        assert "#### Other (0/2 frontend plugins NFS-ready — 0%)" in stdout
        assert "| @scope/plugin-b | sample |" in stdout
