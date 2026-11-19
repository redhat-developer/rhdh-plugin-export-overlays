"""Exercise the publish completion comment with simulated GitHub responses."""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not available")


def publish_comment(tmp_path, **scenario):
    workflow = yaml.safe_load((ROOT / ".github/workflows/auto-publish-pr.yaml").read_text())
    steps = workflow["jobs"]["add-completion-comment"]["steps"]
    script = next(step for step in steps if step.get("name") == "Add completion comment")["with"]["script"]
    fixture = {"script": script.replace("${{ github.run_id }}", "123"), **scenario}
    driver = r"""
      const fixture = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const inputs = {
        pr_number: '42', overlay_repo: 'owner/repo', overlay_branch: 'branch',
        overlay_commit: 'sha', workspace: 'workspaces/example',
        only_metadata_changed: fixture.metadataOnly ? 'true' : 'false',
        check_up_to_date_result: fixture.upToDate || 'success',
        export_result: fixture.exportResult || 'success',
        check_backstage_compatibility_result: fixture.compatibility || 'success',
        validate_metadata_result: 'success', detect_changes_result: 'success',
      };
      const core = { getInput: name => inputs[name] || '', getMultilineInput: () => [], warning: () => {} };
      let body, status;
      const github = { rest: {
        actions: { getWorkflowRun: async () => ({ data: { html_url: 'https://example.com/publish' } }) },
        repos: {
          createCommitStatus: async options => { status = options.state; },
          getContent: async () => {
            if (fixture.contentError) throw Object.assign(new Error('Unavailable'), { status: fixture.contentError });
          },
        },
        pulls: { get: async () => {
          if (fixture.labelsError) throw new Error('Unavailable');
          return { data: { labels: (fixture.labels || []).map(name => ({ name })) } };
        } },
        issues: { createComment: async options => { body = options.body; } },
      } };
      const context = { repo: { owner: 'owner', repo: 'repo' } };
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      new AsyncFunction('github', 'context', 'core', 'require', fixture.script)(github, context, core, require)
        .then(() => process.stdout.write(JSON.stringify({ body, status })))
        .catch(error => { console.error(error); process.exitCode = 1; });
    """
    result = subprocess.run(
        ["node", "-e", driver], input=json.dumps(fixture), capture_output=True,
        text=True, timeout=10, cwd=tmp_path, check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def requests_e2e(body):
    return bool(re.search(r"^/test e2e-ocp-helm$", body, re.MULTILINE))


@pytest.mark.parametrize("labels", [[], ["ok-to-test"]])
def test_successful_publish_requests_e2e_and_links_to_history(tmp_path, labels):
    result = publish_comment(tmp_path, labels=labels)
    assert requests_e2e(result["body"])
    assert "https://prow.ci.openshift.org/pr-history?org=owner&repo=repo&pr=42" in result["body"]


def test_successful_publish_requests_e2e_even_if_compatibility_fails(tmp_path):
    result = publish_comment(tmp_path, compatibility="failure")
    assert result["status"] == "failure"
    assert requests_e2e(result["body"])
    assert "E2E tests not requested" not in result["body"]


def test_unapproved_pr_shows_manual_command_without_requesting_e2e(tmp_path):
    result = publish_comment(tmp_path, labels=["needs-ok-to-test"])
    assert not requests_e2e(result["body"])
    assert "trusted member" in result["body"]
    assert "`/test e2e-ocp-helm`" in result["body"]
    assert "enables automatic testing" not in result["body"]


@pytest.mark.parametrize("scenario", [{"exportResult": "failure"}, {"metadataOnly": True}, {"upToDate": "failure"}])
def test_failed_or_skipped_publish_does_not_request_e2e(tmp_path, scenario):
    result = publish_comment(tmp_path, **scenario)
    assert not requests_e2e(result["body"])
    assert "E2E tests not requested" in result["body"]


def test_missing_e2e_tests_do_not_request_a_job(tmp_path):
    result = publish_comment(tmp_path, contentError=404)
    assert not requests_e2e(result["body"])
    assert "No E2E tests available for this workspace." in result["body"]


def test_api_errors_do_not_request_a_job_or_claim_tests_are_absent(tmp_path):
    for scenario in ({"contentError": 500}, {"labelsError": True}):
        result = publish_comment(tmp_path, **scenario)
        assert not requests_e2e(result["body"])
        assert "No E2E tests available" not in result["body"]
        assert "Could not check" in result["body"]
