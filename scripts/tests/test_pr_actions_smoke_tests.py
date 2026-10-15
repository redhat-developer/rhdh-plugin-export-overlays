"""Tests for inlined smoke tests in .github/workflows/pr-actions.yaml."""

from pathlib import Path
import yaml


ROOT = Path(__file__).resolve().parents[2]


def _workflow(path: str) -> dict:
    return yaml.load((ROOT / path).read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def test_pr_actions_does_not_dispatch_workspace_tests():
    workflow_text = (ROOT / ".github/workflows/pr-actions.yaml").read_text(encoding="utf-8")
    assert "workspace-tests.yaml" not in workflow_text
    assert "createWorkflowDispatch" not in workflow_text


def test_pr_actions_has_synchronous_smoke_test_jobs():
    workflow = _workflow(".github/workflows/pr-actions.yaml")
    jobs = workflow["jobs"]

    assert "prepareSmokeTests" in jobs
    assert "runSmokeTests" in jobs
    assert "addSmokeTestResultComment" in jobs
    assert "addSkippedSmokeComment" in jobs

    # runSmokeTests calls run-workspace-smoke-tests.yaml synchronously
    run_job = jobs["runSmokeTests"]
    assert run_job["uses"] == "./.github/workflows/run-workspace-smoke-tests.yaml"
    assert "prepareSmokeTests" in run_job["needs"]


def test_auto_publish_pr_declares_published_exports_output():
    workflow = _workflow(".github/workflows/auto-publish-pr.yaml")
    on_block = workflow.get("on", workflow.get(True))
    assert "workflow_call" in on_block
    assert "outputs" in on_block["workflow_call"]
    assert "published-exports" in on_block["workflow_call"]["outputs"]
    assert "only-metadata-changed" in on_block["workflow_call"]["outputs"]


def test_prepare_smoke_tests_guards_against_metadata_only_changes():
    workflow = _workflow(".github/workflows/pr-actions.yaml")
    prepare_job = workflow["jobs"]["prepareSmokeTests"]
    condition = prepare_job["if"]
    assert "only-metadata-changed" in condition

