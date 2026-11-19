const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/auto-publish-pr.yaml'), 'utf8');
const script = workflow.split('      - name: Add completion comment\n')[1]
  .split('          script: |\n')[1]
  .split('\n      - name: Stage published exports')[0]
  .replace(/^            /gm, '')
  .replaceAll('${{ github.run_id }}', '123');
const runScript = new (Object.getPrototypeOf(async function () {}).constructor)('core', 'github', 'context', 'require', script);

async function comment({ labels = [], exportResult = 'success', compatibilityResult = 'success', onlyMetadataChanged = false, testsExist = true, apiError = false, labelsError = false } = {}) {
  const inputs = {
    pr_number: '42', overlay_repo: 'owner/repo', overlay_branch: 'branch',
    overlay_commit: 'sha', workspace: 'workspaces/example',
    only_metadata_changed: String(onlyMetadataChanged), check_up_to_date_result: 'success',
    export_result: exportResult, check_backstage_compatibility_result: compatibilityResult,
    validate_metadata_result: 'success', detect_changes_result: 'success',
  };
  let body;
  const core = { getInput: name => inputs[name] || '', getMultilineInput: () => [], warning: () => {} };
  const github = { rest: {
    actions: { getWorkflowRun: async () => ({ data: { html_url: 'https://example.com/publish' } }) },
    repos: {
      createCommitStatus: async () => {},
      getContent: async () => { if (apiError || !testsExist) throw Object.assign(new Error('Content unavailable'), { status: apiError ? 500 : 404 }); },
    },
    issues: { createComment: async options => { body = options.body; } },
    pulls: { get: async () => {
      if (labelsError) throw new Error('Labels unavailable');
      return { data: { labels: labels.map(name => ({ name })) } };
    } },
  } };
  await runScript(core, github, { repo: { owner: 'owner', repo: 'repo' } }, require);
  return body;
}

test('failed or skipped publishing does not request E2E', async () => {
  for (const options of [{ exportResult: 'failure' }, { compatibilityResult: 'failure' }, { onlyMetadataChanged: true }]) {
    const body = await comment(options);
    assert.doesNotMatch(body, /^\/test e2e-ocp-helm$/m);
    assert.match(body, /E2E.*not (?:requested|triggered)/i);
  }
});

test('PRs not waiting for approval request E2E and link to PR test history', async () => {
  for (const labels of [['ok-to-test'], []]) {
    const body = await comment({ labels });
    assert.match(body, /^\/test e2e-ocp-helm$/m);
    assert.match(body, /https:\/\/prow\.ci\.openshift\.org\/pr-history\?org=owner&repo=repo&pr=42/);
    assert.match(body, /request/i);
  }
});

test('PRs needing approval give manual instructions without triggering Prow', async () => {
  const body = await comment({ labels: ['needs-ok-to-test'] });
  assert.doesNotMatch(body, /^\/test e2e-ocp-helm$/m);
  assert.match(body, /`\/test e2e-ocp-helm`/);
  assert.match(body, /(?:trusted|authorized|member)/i);
});

test('workspaces without E2E tests do not request a job', async () => {
  const body = await comment({ testsExist: false });
  assert.doesNotMatch(body, /^\/test e2e-ocp-helm$/m);
  assert.match(body, /No E2E tests available/);
});

test('an API error does not claim the workspace has no E2E tests', async () => {
  const body = await comment({ apiError: true });
  assert.doesNotMatch(body, /^\/test e2e-ocp-helm$/m);
  assert.doesNotMatch(body, /No E2E tests available/);
  assert.match(body, /could not (?:check|determine)/i);
});

test('an approval lookup error does not trigger a job', async () => {
  const body = await comment({ labelsError: true });
  assert.doesNotMatch(body, /^\/test e2e-ocp-helm$/m);
  assert.match(body, /could not check PR test approval/i);
  assert.match(body, /`\/test e2e-ocp-helm`/);
});
