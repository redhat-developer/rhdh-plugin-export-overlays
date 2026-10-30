"""Exercise the actual collector script and concurrency configuration in the workflow."""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/update-plugins-repo-refs.yaml"


@pytest.fixture
def workflow():
    return yaml.safe_load(WORKFLOW.read_text())


def pull_request(number, workspace="orchestrator", branch="main", **overrides):
    return {
        "number": number,
        "head": {"ref": f"workspaces/{branch}__{workspace}"},
        "base": {"ref": branch},
        "updated_at": "2026-10-30T12:01:00Z",
        **overrides,
    }


def collect(workflow, *, inputs=None, prs=()):
    """Run the inline github-script with read-only fakes, not a copied implementation."""
    step = next(
        step
        for step in workflow["jobs"]["collect-auto-publish-prs"]["steps"]
        if step.get("id") == "collect"
    )
    inputs = inputs or {}
    env = {}
    for name, expression in step["env"].items():
        match = re.fullmatch(r"\$\{\{\s*inputs\.([\w-]+)\s*\}\}", expression)
        assert match, f"Unsupported test input expression: {expression}"
        env[name] = inputs.get(match[1], "")
    fixture = {"script": step["with"]["script"], "env": env, "prs": list(prs)}
    driver = r"""
      const fs = require('node:fs');
      const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
      const outputs = {};
      const calls = [];
      const list = Symbol('pulls.list');
      const github = {
        rest: {
          actions: { getWorkflowRun: async params => {
            calls.push({ method: 'getWorkflowRun', params });
            return { data: { run_started_at: '2026-10-30T12:00:00Z' } };
          } },
          pulls: { list },
        },
        paginate: async (method, params) => {
          if (method !== list) throw new Error('Unexpected API call');
          calls.push({ method: 'pulls.list', params });
          return fixture.prs;
        },
      };
      const core = {
        getInput: name => fixture.env[`INPUT_${name.toUpperCase()}`] || '',
        setOutput: (name, value) => { outputs[name] = value; },
        info: () => {},
      };
      const context = { repo: { owner: 'redhat-developer', repo: 'overlays' }, runId: 456 };
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      new AsyncFunction('github', 'context', 'core', fixture.script)(github, context, core)
        .then(() => process.stdout.write(JSON.stringify({ outputs, calls })))
        .catch(error => { console.error(error); process.exitCode = 1; });
    """
    result = subprocess.run(
        ["node", "-e", driver],
        input=json.dumps(fixture),
        capture_output=True,
        text=True,
        timeout=10,
        cwd=ROOT,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    result = json.loads(result.stdout)
    return json.loads(result["outputs"]["pr-numbers"]), result["calls"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not available")
@pytest.mark.parametrize(
    ("inputs", "expected"),
    [
        ({"workspace-path": "workspaces/orchestrator", "single-branch": "main"}, [1]),
        (
            {
                "workspace-path": "workspaces/orchestrator",
                "single-branch": "release-2.1",
            },
            [3],
        ),
        ({"workspace-path": "workspaces/theme", "single-branch": "main"}, [2]),
        ({"workspace-path": "workspaces/orchestrator"}, [1, 3]),
        ({"single-branch": "main"}, [1, 2, 5]),
        ({}, [1, 2, 3, 4, 5]),
        ({"workspace-path": "workspaces/missing", "single-branch": "main"}, []),
        ({"workspace-path": "workspaces/", "single-branch": "main"}, []),
        ({"workspace-path": "orchestrator", "single-branch": "main"}, []),
        ({"workspace-path": "workspaces/orchestrator/extra"}, []),
    ],
)
def test_collector_only_selects_recent_prs_in_the_requested_scope(
    workflow, inputs, expected
):
    prs = [
        pull_request(1),
        pull_request(2, "theme"),
        pull_request(3, branch="release-2.1"),
        pull_request(4, "theme", "release-2.1"),
        pull_request(5, "orchestrator-extra"),
        pull_request(6, updated_at="2026-10-30T11:59:59Z"),
        pull_request(7, head={"ref": "fix/unrelated"}),
    ]
    numbers, calls = collect(workflow, inputs=inputs, prs=prs)
    assert numbers == expected
    assert [call["method"] for call in calls] == ["getWorkflowRun", "pulls.list"]
    assert calls[0]["params"]["run_id"] == 456


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not available")
def test_explicit_pr_refresh_does_not_collect_other_runs_prs(workflow):
    numbers, calls = collect(
        workflow,
        inputs={
            "workspace-path": "workspaces/orchestrator",
            "single-branch": "main",
            "pr-to-update": "4200",
        },
        prs=[pull_request(1), pull_request(2, "theme")],
    )
    assert numbers == [4200]
    assert calls == []


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not available")
def test_parallel_workspace_collectors_select_disjoint_prs(workflow):
    prs = [pull_request(1), pull_request(2, "theme")]
    orchestrator, _ = collect(
        workflow,
        inputs={"workspace-path": "workspaces/orchestrator", "single-branch": "main"},
        prs=prs,
    )
    theme, _ = collect(
        workflow,
        inputs={"workspace-path": "workspaces/theme", "single-branch": "main"},
        prs=prs,
    )
    assert orchestrator == [1]
    assert theme == [2]
    assert set(orchestrator).isdisjoint(theme)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not available")
def test_collector_includes_the_run_start_boundary_but_rejects_a_mismatched_head(
    workflow,
):
    numbers, _ = collect(
        workflow,
        inputs={"workspace-path": "workspaces/orchestrator", "single-branch": "main"},
        prs=[
            pull_request(1, updated_at="2026-10-30T12:00:00Z"),
            pull_request(2, head={"ref": "workspaces/release-2.1__orchestrator"}),
        ],
    )
    assert numbers == [1]


def test_concurrency_keeps_workspace_pr_and_target_branch_in_the_group(workflow):
    group = workflow["concurrency"]["group"]
    expected = (
        "${{ github.workflow }}-${{ github.event_name }}-"
        "${{ inputs.workspace-path }}-${{ inputs.pr-to-update }}-"
        "${{ inputs.single-branch }}"
    )
    assert group == expected


def test_concurrency_groups_distinguish_workspaces_branches_and_prs(workflow):
    def group(workspace="orchestrator", branch="main", pr=""):
        values = {
            "github.workflow": "Update plugins repository references",
            "github.event_name": "workflow_dispatch",
            "inputs.workspace-path": f"workspaces/{workspace}",
            "inputs.pr-to-update": pr,
            "inputs.single-branch": branch,
        }
        return re.sub(
            r"\$\{\{\s*([^}]+?)\s*\}\}",
            lambda match: values[match[1]],
            workflow["concurrency"]["group"],
        )

    assert group() != group(workspace="theme")
    assert group() != group(branch="release-2.1")
    assert group(pr="4200") != group(pr="4201")
    assert group() != group(pr="4200")


def test_concurrency_supersedes_explicit_refreshes_but_preserves_scoped_discovery(
    workflow,
):
    assert workflow["concurrency"]["cancel-in-progress"] == (
        "${{ inputs.pr-to-update != '' || inputs.workspace-path == '' }}"
    )
