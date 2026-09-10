"""Tests for scripts/resolve-published-workspaces.sh.

This decides what the post-publish smoke covers, and the two errors are not
symmetric. Covering a workspace that did not change costs one redundant smoke run
that passes. Covering fewer than were published leaves a bad artifact live with a
green run behind it — which is the exact failure RHDHBUGS-3634 was filed over. So
the cases below pin the narrow direction hardest: an unresolvable base must refuse
to guess, and a broken `git diff` must fail rather than report "nothing to test".

Each case builds a throwaway git repo through the shared harness, whose git helper
scrubs the environment — otherwise a developer's global `commit.gpgsign` or
`core.hooksPath` fails every test.
"""

import json

import pytest

from tests.shell_harness import SCRIPTS_DIR, git, link_script, run_script

SCRIPT = SCRIPTS_DIR / "resolve-published-workspaces.sh"

OCI_METADATA = (
    "apiVersion: extensions.backstage.io/v1alpha1\n"
    "kind: Package\n"
    "spec:\n"
    "  packageName: '@scope/plugin-{ws}'\n"
    "  dynamicArtifact: oci://ghcr.io/org/repo/plugin-{ws}:bs_1.54.6__0.1.0!plugin-{ws}\n"
)

# A workspace that ships from a local path rather than an OCI image. The harness
# errors on zero refs, so these must never reach the matrix.
LOCAL_METADATA = (
    "apiVersion: extensions.backstage.io/v1alpha1\n"
    "kind: Package\n"
    "spec:\n"
    "  packageName: '@scope/plugin-{ws}'\n"
    "  dynamicArtifact: ./dynamic-plugins/dist/scope-plugin-{ws}\n"
)


def build_repo(tmp_path, workspaces):
    """A repo with one commit per workspace, so a test can pick any base it likes."""
    root = tmp_path / "repo"
    root.mkdir()
    link_script(root, SCRIPT.name)
    git(root, "init", "-q", "-b", "main")

    (root / "README.md").write_text("seed\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "seed")

    shas = {"seed": git(root, "rev-parse", "HEAD").stdout.strip()}
    for ws, template in workspaces:
        meta = root / "workspaces" / ws / "metadata"
        meta.mkdir(parents=True)
        (meta / f"plugin-{ws}.yaml").write_text(template.format(ws=ws))
        git(root, "add", "-A")
        git(root, "commit", "-qm", f"add {ws}")
        shas[ws] = git(root, "rev-parse", "HEAD").stdout.strip()
    return root, shas


def resolve(root, base, head):
    result = run_script(root / "scripts" / SCRIPT.name, base, head, cwd=root)
    assert result.returncode == 0, result.stderr
    out = dict(
        line.split("=", 1) for line in result.stdout.strip().splitlines() if "=" in line
    )
    return out, result


def test_reports_every_workspace_changed_since_the_base(tmp_path):
    root, shas = build_repo(
        tmp_path, [("alpha", OCI_METADATA), ("beta", OCI_METADATA)]
    )
    out, _ = resolve(root, shas["seed"], shas["beta"])
    assert json.loads(out["workspaces"]) == ["alpha", "beta"]
    assert out["count"] == "2"


def test_ignores_workspaces_changed_before_the_base(tmp_path):
    root, shas = build_repo(
        tmp_path, [("alpha", OCI_METADATA), ("beta", OCI_METADATA)]
    )
    out, _ = resolve(root, shas["alpha"], shas["beta"])
    assert json.loads(out["workspaces"]) == ["beta"]


def test_skips_a_workspace_with_no_oci_artifact(tmp_path):
    """Zero OCI refs is an error in the harness, so a good publish would go red."""
    root, shas = build_repo(
        tmp_path, [("alpha", OCI_METADATA), ("local-only", LOCAL_METADATA)]
    )
    out, result = resolve(root, shas["seed"], shas["local-only"])
    assert json.loads(out["workspaces"]) == ["alpha"]
    assert "local-only" in result.stderr


def test_reports_nothing_when_no_workspace_changed(tmp_path):
    root, shas = build_repo(tmp_path, [("alpha", OCI_METADATA)])
    out, _ = resolve(root, shas["alpha"], shas["alpha"])
    assert json.loads(out["workspaces"]) == []
    assert out["count"] == "0"
    # No reason: an empty list here is a real answer, not a refusal to answer.
    assert out["reason"] == ""


@pytest.mark.parametrize("base", ["", "0" * 40, "not-a-sha"])
def test_refuses_to_guess_when_the_base_does_not_resolve(tmp_path, base):
    """The publish was unscoped, so scoping the smoke would cover less than shipped."""
    root, shas = build_repo(tmp_path, [("alpha", OCI_METADATA)])
    out, _ = resolve(root, base, shas["alpha"])
    assert json.loads(out["workspaces"]) == []
    assert out["count"] == "0"
    assert "does not resolve" in out["reason"]


def test_fails_loudly_when_the_diff_cannot_run(tmp_path):
    """The head being unreachable must fail, not report an empty list.

    An empty list reads as "nothing to test" and takes the whole run green having
    tested nothing, which is how the first version of this logic was broken.
    """
    root, shas = build_repo(tmp_path, [("alpha", OCI_METADATA)])
    result = run_script(
        root / "scripts" / SCRIPT.name, shas["alpha"], "f" * 40, cwd=root
    )
    assert result.returncode != 0
    assert "count=0" not in result.stdout


def test_rejects_a_missing_head_argument(tmp_path):
    root, _ = build_repo(tmp_path, [("alpha", OCI_METADATA)])
    result = run_script(root / "scripts" / SCRIPT.name, "HEAD", cwd=root)
    assert result.returncode == 2
    assert "usage" in result.stderr
