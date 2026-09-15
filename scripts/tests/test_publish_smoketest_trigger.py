"""Regression tests for the publish-to-smoketest artifact handoff."""

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


def _workflow(path: str) -> dict:
    return yaml.load((ROOT / path).read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def _on(workflow: dict) -> dict:
    # PyYAML's YAML 1.1 resolver treats the GitHub Actions "on" key as boolean.
    return workflow.get("on", workflow.get(True))


def test_publish_dispatch_passes_its_run_id_to_smoke_tests():
    workflow = _workflow(".github/workflows/pr-actions.yaml")
    script = workflow["jobs"]["triggerSmokeTests"]["steps"][0]["with"]["script"]

    assert "'publish-run-id': '${{ needs.parse.outputs.command-name == 'publish' && github.run_id || '' }}'" in script


def test_smoke_tests_use_exact_publish_run_for_automatic_dispatch():
    workflow = _workflow(".github/workflows/workspace-tests.yaml")
    inputs = _on(workflow)["workflow_dispatch"]["inputs"]
    assert inputs["publish-run-id"]["required"] == "false"

    steps = workflow["jobs"]["resolve"]["steps"]
    exact = next(step for step in steps if step["name"] == "Download published-exports artifact from publish run")
    assert exact["if"] == "inputs.publish-run-id != ''"
    assert exact["with"]["run_id"] == "${{ inputs.publish-run-id }}"
    assert "workflow_conclusion" not in exact["with"]

    search = next(step for step in steps if step["name"] == "Download published-exports artifact for this PR")
    assert "inputs.publish-run-id == ''" in search["if"]
    assert "inputs.workspace != ''" in search["if"]
    assert "inputs.pr-number != ''" in search["if"]
    assert search["with"]["workflow_conclusion"] == "success"
