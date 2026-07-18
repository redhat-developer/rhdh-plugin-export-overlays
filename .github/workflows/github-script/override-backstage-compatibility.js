// @ts-check
/** @param {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments */
module.exports = async ({github, context, core}) => {
  const workspace = core.getInput('workspace');
  const overlayBranch = core.getInput('overlay_branch');
  const overlayRepo = core.getInput('overlay_repo');
  const targetBranch = core.getInput('target_branch');

  const [prOwner, prRepo] = overlayRepo.split('/');
  const isFork = prOwner !== context.repo.owner;

  // Read target Backstage version from base branch (source of truth)
  const { data: versionsFile } = await github.rest.repos.getContent({
    owner: context.repo.owner,
    repo: context.repo.repo,
    path: 'versions.json',
    ref: targetBranch,
  });
  if (!('type' in versionsFile) || versionsFile.type !== 'file') {
    core.setFailed(`versions.json is not a file on branch ${targetBranch}`);
    return;
  }
  const versionsContent = Buffer.from(
    versionsFile.content,
    Buffer.isEncoding(versionsFile.encoding) ? versionsFile.encoding : 'utf-8'
  ).toString('utf-8');
  const targetVersion = JSON.parse(versionsContent).backstage;
  core.setOutput('target-version', targetVersion);
  core.info(`Target Backstage version: ${targetVersion}`);

  // Read source.json from PR branch for reporting
  const { data: sourceFile } = await github.rest.repos.getContent({
    owner: prOwner,
    repo: prRepo,
    path: `${workspace}/source.json`,
    ref: overlayBranch,
  });
  if (!('type' in sourceFile) || sourceFile.type !== 'file') {
    core.setFailed(`${workspace}/source.json is not a file on branch ${overlayBranch}`);
    return;
  }
  const sourceContent = Buffer.from(
    sourceFile.content,
    Buffer.isEncoding(sourceFile.encoding) ? sourceFile.encoding : 'utf-8'
  ).toString('utf-8');
  const sourceVersion = JSON.parse(sourceContent)['repo-backstage-version'];
  core.setOutput('source-version', sourceVersion);
  core.info(`Source Backstage version: ${sourceVersion}`);

  // Create backstage.json and commit — write operations wrapped so fork
  // PRs fall back to posting manual instructions if GITHUB_TOKEN lacks access
  const backstageJsonContent = JSON.stringify({ version: targetVersion }, null, 2) + '\n';

  try {
    // Create backstage.json blob
    const { data: backstageBlob } = await github.rest.git.createBlob({
      owner: prOwner,
      repo: prRepo,
      content: Buffer.from(backstageJsonContent).toString('base64'),
      encoding: 'base64',
    });

    // Get current HEAD
    const { data: ref } = await github.rest.git.getRef({
      owner: prOwner,
      repo: prRepo,
      ref: `heads/${overlayBranch}`,
    });
    const currentSha = ref.object.sha;

    const { data: currentCommit } = await github.rest.git.getCommit({
      owner: prOwner,
      repo: prRepo,
      commit_sha: currentSha,
    });

    // Create tree with backstage.json
    const { data: newTree } = await github.rest.git.createTree({
      owner: prOwner,
      repo: prRepo,
      base_tree: currentCommit.tree.sha,
      tree: [{
        path: `${workspace}/backstage.json`,
        mode: '100644',
        type: 'blob',
        sha: backstageBlob.sha,
      }],
    });

    // Create commit
    const workspaceName = workspace.replace('workspaces/', '');
    const { data: newCommit } = await github.rest.git.createCommit({
      owner: prOwner,
      repo: prRepo,
      message: `chore(${workspaceName}): override backstage compatibility to ${targetVersion}`,
      tree: newTree.sha,
      parents: [currentSha],
    });

    // Update branch ref
    await github.rest.git.updateRef({
      owner: prOwner,
      repo: prRepo,
      ref: `heads/${overlayBranch}`,
      sha: newCommit.sha,
    });

    core.setOutput('fork', 'false');
    core.setOutput('commit-sha', newCommit.sha);

    core.info(`Override complete: backstage.json created/updated`);
  } catch (e) {
    if (isFork && (e.status === 403 || e.status === 404 || e.status === 422)) {
      core.setOutput('fork', 'true');
      core.notice('PR is from a fork — could not push override commit. Manual instructions will be posted.');
      return;
    }
    throw e;
  }
};
