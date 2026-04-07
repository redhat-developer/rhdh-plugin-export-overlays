// @ts-check
/** @param {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments */
module.exports = async ({github, context, core}) => {
  const releaseBranch = core.getInput('release_branch');
  const singlePR = core.getInput('pr');
  const force = core.getBooleanInput('force');
  const path = 'versions.json';

  /** @type { Array<{ number: number, title: string, branch: string, repository?: string}> } */
  const pullRequests = [];
  if (singlePR !== '') {
      const prNumber = parseInt(singlePR);
      if (Number.isNaN(prNumber)) {
        core.setFailed(`PR workflow parameter is not a valid number: ${singlePR}`);
        return;
      }
      const response = await github.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: prNumber,
      });
      if (response.data.base.ref !== releaseBranch) {
        core.setFailed(`PR #${singlePR} is not based on release branch \`${releaseBranch}\``);
        return;
      }
      pullRequests.push({
        number: response.data.number,
        title: response.data.title,
        branch: response.data.head.ref,
        repository: response.data.head.repo?.full_name
      });
  } else {
      /** @type {import('@octokit/types').GetResponseTypeFromEndpointMethod<typeof github.rest.pulls.list>} */
      let response;
      let page = 1;
      do {          
          response = await github.rest.pulls.list({
            owner: context.repo.owner,
            repo: context.repo.repo,
            state: 'open',
            base: releaseBranch,
            per_page: 100,
            page,
          });
          pullRequests.push(...response.data.map(pr => ({
            number: pr.number,
            title: pr.title,
            branch: pr.head.ref,
            repository: pr.head.repo?.full_name
          })));
          page++;
      } while (response.data.length > 0);
  }

  const { data: sourceFile } = await github.rest.repos.getContent({
    owner: context.repo.owner,
    repo: context.repo.repo,
    path,
    ref: releaseBranch,
  });
  if (!('type' in sourceFile) || sourceFile.type !== 'file') {
    core.setFailed(`\`${path}\` is not a file on branch \`${releaseBranch}\``);
    return;
  }

  const sourceContent = Buffer.from(
    sourceFile.content,
    (Buffer.isEncoding(sourceFile.encoding) ? sourceFile.encoding : 'utf-8')
  ).toString('utf-8');
  const sourceSha = sourceFile.sha;

  /** @type { Array<{title: string, number: number}> } */
  const updatedPullRequests = [];
  /** @type { Array<{title: string, number: number}> } */
  const uptodatePullRequests = [];
  /** @type { Array<{title: string, number: number}> } */
  const conflictingPullRequests = [];
  /** @type { Array<{title: string, number: number}> } */
  const forkedPullRequests = [];
  /** @type { Array<{title: string, number: number}> } */
  const failedPullRequests = [];
  /** @type { Array<{number: number, comment: string}> } */
  const prComments = [];
  for (const pr of pullRequests) {
    core.info(`Syncing the \`${path}\` file to PR #${pr.number} (\`${pr.branch}\`)`);
    try {
      const owner = pr.repository ? pr.repository.split('/')[0] : context.repo.owner;
      const repo = pr.repository ? pr.repository.split('/')[1] : context.repo.repo;
      
      const { data: targetFile } = await github.rest.repos.getContent({
        owner,
        repo: pr.repository ? pr.repository.split('/')[1] : context.repo.repo,
        path,
        ref: pr.branch,
      });
      if (!('type' in targetFile) || targetFile.type !== 'file') {
        core.warning(`\`${path}\` is not a file on branch ${pr.branch}`);
        continue;
      }
      const targetContent = Buffer.from(
        targetFile.content,
        (Buffer.isEncoding(targetFile.encoding) ? targetFile.encoding : 'utf-8')
      ).toString('utf-8');
      const targetSha = targetFile.sha;

      if (sourceContent === targetContent) {
        core.info(`Skipping PR #${pr.number}: \`${path}\` already up-to-date`);
        uptodatePullRequests.push(pr);
        continue;
      }
            
      if (owner !== context.repo.owner) {
        core.notice(`Skipping PR #${pr.number}: the PR is from a repository fork.`);
        prComments.push({
          number: pr.number,
          comment: `The file \`${path}\` could not be synced from branch \`${releaseBranch}\` into this because your PR is from a fork.\n\nYou should update the \`versions.json\` file with the following content:
\`\`\`
${sourceContent}
\`\`\`
`
        });
        forkedPullRequests.push(pr);
        continue;
      }

      const prFiles = (await Promise.all((await github.rest.pulls.listCommits({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pr.number
      })).data.filter(c => 
          c.author?.login !== 'github-actions[bot]'
      ).map(c => github.rest.repos.getCommit({
          owner: context.repo.owner,
          repo: context.repo.repo,
          ref: c.sha
        })
      ))).flatMap(response => response.data.files);
      if (prFiles.find(f => f?.filename === path)) {
        if (force) {
          core.notice(`Overwriting previous manual \`${path}\` change.`);
        } else {
          core.notice(`Skipping PR #${pr.number}: \`${path}\` has been manually modified in the PR`);
          prComments.push({
            number: pr.number,
            comment: `The file \`${path}\` could not be synced from branch \`${releaseBranch}\` into this PR because it was manually modified in this PR.
You will have to update it manually with the following content to avoid conflicts:
\`\`\`
${sourceContent}
\`\`\``
          });
          conflictingPullRequests.push(pr);
          continue;
        }
      }
  
      const update = await github.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message: `chore: sync \`${path}\` from \`${releaseBranch}\``,
        content: Buffer.from(sourceContent).toString('base64'),
        sha: targetSha,
        branch: pr.branch,
      });

      core.info(`\`${path}\` updated in PR #${pr.number}`);
      prComments.push({
        number: pr.number,
        comment: `Successfully updated file \`${path}\`from branch \`${releaseBranch}\` into this PR in commit ${update.data.commit.sha}`
      });

      updatedPullRequests.push(pr);
    } catch(err) {
      core.warning(`Skipping PR #${pr.number} due to error: ${err.message}`);
      failedPullRequests.push(pr);
    }
  }

  let summary = core.summary;
  if (updatedPullRequests.length > 0) {
    summary = summary.addHeading(`${updatedPullRequests.length} PRs updated:`, 4)
    .addList(updatedPullRequests.map(pr => `${pr.title} (#${pr.number})`));
  }
  if (uptodatePullRequests.length > 0) {
    summary = summary.addHeading(`${uptodatePullRequests.length} PRs already up-to-date:`, 4)
    .addList(uptodatePullRequests.map(pr => `${pr.title} (#${pr.number})`));
  }
  if (conflictingPullRequests.length > 0) {
    summary = summary.addHeading(`${conflictingPullRequests.length} PRs not updated to keep manual changes:`, 4)
    .addList(conflictingPullRequests.map(pr => `${pr.title} (#${pr.number})`));
  }
  if (forkedPullRequests.length > 0) {
    summary = summary.addHeading(`${forkedPullRequests.length} PRs not updated because based on a fork:`, 4)
    .addList(forkedPullRequests.map(pr => `${pr.title} (#${pr.number})`));
  }
  if (failedPullRequests.length > 0) {
    summary = summary.addHeading(`${failedPullRequests.length} PRs not updated due to failure:`, 4)
    .addList(failedPullRequests.map(pr => `${pr.title} (#${pr.number})`));
  }
  summary.write();
  if (prComments.length > 0) {
    core.setOutput('pr-comments', prComments);
  }
  if (updatedPullRequests.length > 0) {
    core.setOutput('updated-pr-numbers', JSON.stringify(updatedPullRequests.map(pr => pr.number)));
  }

}
