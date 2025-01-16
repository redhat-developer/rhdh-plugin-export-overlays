module.exports = async ({
  github,
  core,
  owner,
  repo,
  pluginsRepoOwner,
  pluginsRepo,
  prBranchName,
  workspaceCommit,
  workspaceJson,
}) => {
  try {    
    const githubClient = github.rest;
        
    const workspace = JSON.parse(workspaceJson);
    const targetBranchName = `releases/${workspace.branch}`;
    const workspaceName = workspace.workspace;

    const workspacePath = `workspaces/${workspaceName}`;
    const pluginsYamlContent = workspace.plugins.map((plugin) => `${ plugin.directory.replace(workspacePath + '/', '') }:`).join('\n');

    const workspaceLink = `/${pluginsRepoOwner}/${pluginsRepo}/tree/${workspaceCommit}/workspaces/${workspaceName}`;

    // checking existing content on the target branch
    let needsUpdate = false;
    try {
      const checkExistingResponse = await githubClient.repos.getContent({
        owner,
        repo,
        mediaType: {
          format: 'text'        
        }, 
        path: `${workspacePath}/plugins-repo-ref`,
        ref: targetBranchName,
      })

      if (checkExistingResponse.status === 200) {
        console.log('workspace already exists on the target branch');
        const data = checkExistingResponse.data;
        if ('content' in data && data.content !== undefined) {
          const content = Buffer.from(data.content, 'base64').toString();
          if (content.trim() === workspaceCommit.trim()) {
            console.log('workspace already added with the same commit');
            await core.summary
              .addHeading('Workspace skipped')
              .addRaw('Workspace ')
              .addLink(workspaceName, workspaceLink)
              .addRaw(` already exists on branch ${targetBranchName} with the same commit ${workspaceCommit.substring(0,7)}`)
              .write()
            return;
          }
        }
        needsUpdate = true;
      }
    } catch(e) {
      if (e instanceof Object && 'status' in e && e.status === 404) {
        console.log(`workspace ${workspaceName} not found on branch ${targetBranchName}`)
      } else {
        throw e;
      }
    }

    // Checking pull request existence
    try {
      const prCheckResponse = await githubClient.git.getRef({
        owner,
        repo,
        ref: `heads/${prBranchName}`
      })

      if (prCheckResponse.status === 200) {
        console.log('pull request branch already exists. Do not try to create it again.')
        await core.summary
          .addHeading('Workspace skipped')
          .addRaw(`Pull request branch ${prBranchName} already exists.`, true)
          .write();
        return;
      }
    } catch(e) {
      if (e instanceof Object && 'status' in e && e.status === 404) {
        console.log(`pull request branch ${prBranchName} doesn't already exist.`)
      } else {
        throw e;
      }
    }

    // getting latest commit sha and treeSha of the target branch
    const response = await githubClient.repos.listCommits({
      owner,
      repo,
      sha: targetBranchName,
      per_page: 1,
    })

    const latestCommitSha = response.data[0].sha;
    const treeSha = response.data[0].commit.tree.sha;

    const treeResponse = await githubClient.git.createTree({
      owner,
      repo,
      base_tree: treeSha,
      tree: [
        { path: `${workspacePath}/plugins-list.yaml`, mode: '100644', content: pluginsYamlContent },
        { path: `${workspacePath}/plugins-repo-ref`, mode: '100644', content: workspaceCommit }
      ]
    })
    const newTreeSha = treeResponse.data.sha

    const needsUpdateMessage = needsUpdate ? 'Update' : 'Add';
    const message = `${needsUpdateMessage} \`${workspaceName}\` workspace to commit \`${workspaceCommit.substring(0,7)}\` for backstage \`${workspace.backstageVersion}\` on branch \`${targetBranchName}\``

    console.log('creating commit')
    const commitResponse = await githubClient.git.createCommit({
      owner,
      repo,
      message,
      tree: newTreeSha,
      parents: [latestCommitSha],
    })
    const newCommitSha = commitResponse.data.sha

    // Creating branch
    await githubClient.git.createRef({
      owner,
      repo,
      sha: newCommitSha,
      ref: `refs/heads/${prBranchName}`
    })

    // Creating pull request
    const prResponse = await githubClient.pulls.create({
      owner: owner,
      repo: repo,
      head: prBranchName,
      base: targetBranchName,
      title: message,
      body: `${needsUpdateMessage} [${workspaceName}](${workspaceLink}) workspace at commit ${pluginsRepoOwner}/${pluginsRepo}@${workspaceCommit} for backstage \`${workspace.backstageVersion}\` on branch \`${targetBranchName}\`.

  This PR was created automatically.
  You might need to complete it with additional dynamic plugin export information, like:
  - the associated \`app-config.dynamic.yaml\` file for frontend plugins,
  - optionally the \`scalprum-config.json\` file for frontend plugins,
  - optionally some overlay source files for backend or frontend plugins.
  `,
    });

    console.log(`Pull request created: ${prResponse.data.html_url}`);

    await core.summary
    .addHeading('Workspace PR created')
    .addLink('Pull request', prResponse.data.html_url)
    .addRaw(` on branch ${targetBranchName}`)
    .addRaw(' created for workspace ')
    .addLink(workspaceName, workspaceLink)
    .addRaw(` at commit ${workspaceCommit.substring(0,7)} for backstage ${workspace.backstageVersion}`)
    .write();
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message);
  }
}
