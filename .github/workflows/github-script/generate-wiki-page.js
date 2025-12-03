// @ts-nocheck

const fs = require('fs').promises;
const { join } = require('path');
const { load } = require('js-yaml');

async function getWorkspaceList(workspacesDir, core) {
  try {
    const entries = await fs.readdir(workspacesDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    core.setFailed(`Error reading workspaces directory ${workspacesDir}: ${error.message}`);
    return [];
  }
}

async function parseSourceJson(workspacePath, core) {
  const sourceFile = join(workspacePath, 'source.json');
  try {
    const content = await fs.readFile(sourceFile, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      core.setFailed(`Error reading ${sourceFile}: ${error.message}`);
    }
    return null;
  }
}

async function parsePluginsList(workspacePath, core) {
  const pluginsFile = join(workspacePath, 'plugins-list.yaml');
  try {
    const content = await fs.readFile(pluginsFile, 'utf-8');
    const trimmed = content.trim();
    if (!trimmed) {
      return [];
    }

    const data = load(trimmed);
    if (typeof data === 'object' && data !== null) {
      if (Array.isArray(data)) {
        return data;
      } else if (typeof data === 'object') {
        return Object.keys(data);
      }
    }
    return [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      core.setFailed(`Error reading ${pluginsFile}: ${error.message}`);
    }
    return [];
  }
}

async function getPluginDetails(octokit, repoUrl, commitSha, pluginPath, core) {
  if (!repoUrl.startsWith('https://github.com/')) {
    return pluginPath;
  }

  const repoName = repoUrl.replace('https://github.com/', '').replace(/\/$/, '');
  const [owner, repo] = repoName.split('/');
  
  const cleanPluginPath = pluginPath === '.' ? '' : pluginPath;
  const filePath = cleanPluginPath ? `${cleanPluginPath}/package.json` : 'package.json';

  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: commitSha
    });

    if ('content' in response.data && response.data.encoding === 'base64') {
      const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
      const packageJson = JSON.parse(content);
      const name = packageJson.name || 'unknown';
      const version = packageJson.version || 'unknown';
      return `${name}@${version}`;
    }
  } catch (error) {
    core.warning(`Error fetching package.json for ${pluginPath} in ${repoName}@${commitSha}: ${error.message}`);
  }

  return pluginPath;
}

async function getCommitDetails(octokit, repoUrl, commitSha, core) {
  if (!repoUrl.startsWith('https://github.com/')) {
    return {
      shortSha: commitSha.substring(0, 7),
      message: 'N/A',
      date: 'N/A'
    };
  }

  const repoName = repoUrl.replace('https://github.com/', '').replace(/\/$/, '');
  const [owner, repo] = repoName.split('/');

  try {
    const response = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: commitSha
    });

    const commit = response.data.commit;
    const message = commit.message.split('\n')[0];
    const dateStr = commit.author?.date || '';
    
    let formattedDate = 'N/A';
    if (dateStr) {
      try {
        const dt = new Date(dateStr);
        formattedDate = dt.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
      } catch (dateError) {
        core.warning(`Error formatting date "${dateStr}": ${dateError.message}`);
        formattedDate = dateStr;
      }
    }

    return {
      shortSha: response.data.sha.substring(0, 7),
      message,
      date: formattedDate
    };
  } catch (error) {
    core.warning(`Error fetching commit details for ${repoName}@${commitSha}: ${error.message}`);
    return {
      shortSha: commitSha.substring(0, 7),
      message: 'N/A',
      date: 'N/A'
    };
  }
}

async function checkPendingPRs(octokit, workspaceName, repoName, targetBranch, core) {
  const workspacePath = `workspaces/${workspaceName}`;
  const [owner, repo] = repoName.split('/');

  try {
    const response = await octokit.rest.pulls.list({
      owner,
      repo,
      base: targetBranch,
      state: 'open',
      per_page: 100
    });

    const prNumbers = [];
    for (const pr of response.data) {
      try {
        const filesResponse = await octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: pr.number
        });

        const hasWorkspaceFile = filesResponse.data.some(file => 
          file.filename.startsWith(workspacePath)
        );

        const hasRequiredLabel = pr.labels?.some(label => 
          label.name === 'workspace_addition' || label.name === 'workspace_update'
        );

        if (hasWorkspaceFile && hasRequiredLabel) {
          prNumbers.push(pr.number.toString());
        }
      } catch (error) {
        core.warning(`Error checking files for PR #${pr.number}: ${error.message}`);
        if (error.status) {
          core.warning(`HTTP status: ${error.status}`);
        }
        continue;
      }
    }

    return {
      hasPending: prNumbers.length > 0,
      prNumbers
    };
  } catch (error) {
    core.warning(`Error checking pending PRs for workspace ${workspaceName} in ${repoName}: ${error.message}`);
    return { hasPending: false, prNumbers: [] };
  }
}

async function getLocalBackstageVersion(workspacePath, core) {
  const backstageFile = join(workspacePath, 'backstage.json');
  try {
    const content = await fs.readFile(backstageFile, 'utf-8');
    const data = JSON.parse(content);
    if (data.version) {
      return data.version;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      core.setFailed(`Error reading backstage.json from ${workspacePath}: ${error.message}`);
    }
  }
  return null;
}

async function getSourceBackstageVersion(octokit, repoUrl, commitSha, sourceData, core) {
  let upstreamVersion = null;

  // Try to fetch from upstream backstage.json first
  if (repoUrl && commitSha && repoUrl.startsWith('https://github.com/')) {
    const repoName = repoUrl.replace('https://github.com/', '').replace(/\/$/, '');
    const [owner, repo] = repoName.split('/');

    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: 'backstage.json',
        ref: commitSha
      });

      if ('content' in response.data && response.data.encoding === 'base64') {
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        const data = JSON.parse(content);
        upstreamVersion = data.version || null;
      }
    } catch (error) {
      if (error.status !== 404) {
        core.warning(`Error fetching upstream backstage.json for ${repoUrl}@${commitSha}: ${error.message}`);
      }
    }
  }

  // If upstream found, use it (to detect overrides)
  if (upstreamVersion) {
    return upstreamVersion;
  }

  // Fallback to source.json's repo-backstage-version if upstream file missing
  if (sourceData && sourceData['repo-backstage-version']) {
    return sourceData['repo-backstage-version'];
  }

  return null;
}

async function loadPluginLists(core) {
  const supported = [];
  const community = [];
  const techpreview = [];

  try {
    const supportedPath = 'rhdh-supported-packages.txt';
    try {
      const content = await fs.readFile(supportedPath, 'utf-8');
      supported.push(...content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        core.setFailed(`Error reading ${supportedPath}: ${error.message}`);
      }
    }

    const communityPath = 'rhdh-community-packages.txt';
    try {
      const content = await fs.readFile(communityPath, 'utf-8');
      community.push(...content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        core.setFailed(`Error reading ${communityPath}: ${error.message}`);
      }
    }

    const techpreviewPath = 'rhdh-techpreview-packages.txt';
    try {
      const content = await fs.readFile(techpreviewPath, 'utf-8');
      techpreview.push(...content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
      );
    } catch (error) {
      if (error.code !== 'ENOENT') {
        core.setFailed(`Error reading ${techpreviewPath}: ${error.message}`);
      }
    }
  } catch (error) {
    core.setFailed(`Error loading plugin lists: ${error.message}`);
  }

  return { supported, community, techpreview };
}

function checkSupportStatus(pluginPath, workspaceName, supportedList, communityList, techpreviewList) {
  const cleanPluginPath = pluginPath.replace(/^\.?\//, '').replace(/^\//, '');
  const fullPath = `${workspaceName}/${cleanPluginPath}`;

  if (supportedList.includes(fullPath)) {
    return 'Supported';
  }
  if (techpreviewList.includes(fullPath)) {
    return 'TechPreview';
  }
  if (communityList.includes(fullPath)) {
    return 'Community';
  }

  if (supportedList.includes(cleanPluginPath)) {
    return 'Supported';
  }
  if (techpreviewList.includes(cleanPluginPath)) {
    return 'TechPreview';
  }
  if (communityList.includes(cleanPluginPath)) {
    return 'Community';
  }

  return 'Unknown';
}

async function countFilesRecursive(dirPath, core) {
  let count = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        count++;
      } else if (entry.isDirectory()) {
        count += await countFilesRecursive(fullPath, core);
      }
    }
  } catch (error) {
    core.setFailed(`Error counting files in ${dirPath}: ${error.message}`);
  }
  return count;
}

async function countAdditionalFiles(workspacePath, core) {
  const counts = {
    metadata: 0,
    plugins: 0,
    patches: 0,
    tests: 0
  };

  for (const key of Object.keys(counts)) {
    const dirPath = join(workspacePath, key);
    try {
      const stat = await fs.stat(dirPath);
      if (stat.isDirectory()) {
        counts[key] = await countFilesRecursive(dirPath, core);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        core.setFailed(`Error counting files in ${dirPath}: ${error.message}`);
      }
    }
  }

  return counts;
}

function generateMarkdown(branchName, workspacesData, repoName) {
  const md = [];

  md.push(`# Workspace Status: \`${branchName}\``);
  md.push('');
  const now = new Date();
  const utcDate = now.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  md.push(`**Last Updated:** ${utcDate}`);
  md.push('');
  md.push(`**Total Workspaces:** ${workspacesData.length}`);
  md.push('');
  md.push('---');
  md.push('');

  md.push('## Workspace Overview');
  md.push('');
  md.push('| Type | Workspace | Source | Backstage Version | Plugins |');
  md.push('|:----:|-----------|--------|------------------|---------|');

  for (const ws of workspacesData) {
    const sourceJsonUrl = `https://github.com/${repoName}/blob/${branchName}/workspaces/${ws.name}/source.json`;
    const structIcon = ws.repo_flat ? '📄' : '🌳';
    const structTooltip = ws.repo_flat ? 'Flat (root-level plugins)' : 'Monorepo (workspace-based)';

    const structureBadges = [];
    structureBadges.push(`[${structIcon}](${sourceJsonUrl} "${structTooltip}")`);

    if (ws.additional_files.patches > 0) {
      const patchesUrl = `https://github.com/${repoName}/tree/${branchName}/workspaces/${ws.name}/patches`;
      structureBadges.push(`[<span title="Has patches">🩹</span>](${patchesUrl})`);
    }

    if (ws.additional_files.plugins > 0) {
      const pluginsUrl = `https://github.com/${repoName}/tree/${branchName}/workspaces/${ws.name}/plugins`;
      structureBadges.push(`[<span title="Has overlays">🔄</span>](${pluginsUrl})`);
    }

    if (ws.additional_files.metadata > 0) {
      structureBadges.push('<span title="Metadata available">🟢</span>');
    } else {
      structureBadges.push('<span title="Metadata missing">🔴</span>');
    }

    if (ws.has_pending_prs && ws.pr_numbers.length > 0) {
      const prNum = ws.pr_numbers[0];
      const prUrl = `https://github.com/${repoName}/pull/${prNum}`;
      const prTooltip = `Pending update PR #${prNum}`;
      structureBadges.push(`[<span title="${prTooltip}">🔴</span>](${prUrl})`);
    }

    const structure = structureBadges.join('<br>');
    const overlayRepoUrl = `https://github.com/${repoName}/tree/${branchName}/workspaces/${ws.name}`;
    const workspaceName = `[${ws.name}](${overlayRepoUrl})`;

    let source = 'N/A';
    if (ws.repo_url && ws.commit_sha) {
      const repoNameOnly = ws.repo_url.replace('https://github.com/', '');
      if (ws.repo_flat) {
        const sourceUrl = `${ws.repo_url}/tree/${ws.commit_sha}`;
        source = `[${repoNameOnly}@${ws.commit_short}](${sourceUrl})`;
      } else {
        const workspacePath = `workspaces/${ws.name}`;
        const sourceUrl = `${ws.repo_url}/tree/${ws.commit_sha}/${workspacePath}`;
        source = `[${repoNameOnly}@${ws.commit_short}](${sourceUrl})`;
      }
    }

    const overlayVersion = ws.overlay_backstage_version;
    const sourceVersion = ws.source_backstage_version;
    const displayVersion = sourceVersion || overlayVersion;

    let backstageVersion = 'N/A';
    if (displayVersion) {
      if (overlayVersion && sourceVersion && overlayVersion !== sourceVersion) {
        const tooltip = `Overlay overrides upstream version ${sourceVersion} to ${overlayVersion}`.replace(/"/g, '&quot;');
        backstageVersion = `\`${displayVersion}\` <span title="${tooltip}">⚠️</span>`;
      } else {
        backstageVersion = `\`${displayVersion}\``;
      }
    }

    let pluginsList = 'No plugins';
    if (ws.plugins && ws.plugins.length > 0) {
      const pluginsListItems = ws.plugins.map(p => {
        const nameVer = p.details;
        const status = p.status;

        let icon, tooltip;
        if (status === 'Supported') {
          icon = '🟢';
          tooltip = 'Red Hat Supported';
        } else if (status === 'TechPreview') {
          icon = '🔵';
          tooltip = 'Tech Preview';
        } else if (status === 'Community') {
          icon = '🟡';
          tooltip = 'Community';
        } else {
          icon = '▪️';
          tooltip = 'Unknown';
        }

        return `<span title="${tooltip}">${icon}</span> <sub>\`${nameVer}\`</sub>`;
      });

      pluginsList = pluginsListItems.join('<br>');
    }

    md.push(`| ${structure} | ${workspaceName} | ${source} | ${backstageVersion} | ${pluginsList} |`);
  }

  md.push('');
  md.push('---');
  md.push('');

  return md.join('\n');
}

/** @param {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments */
module.exports = async ({github, context, core}) => {
  try {
    const branchName = context.ref.replace('refs/heads/', '');
    const repoName = `${context.repo.owner}/${context.repo.repo}`;
    
    core.info(`Generating wiki page for branch: ${branchName}`);
    core.info(`Repository: ${repoName}`);

    const octokit = github;

    const workspacesDir = 'workspaces';
    const workspaceNames = await getWorkspaceList(workspacesDir, core);
    core.info(`Found ${workspaceNames.length} workspaces`);

    const { supported: supportedPlugins, community: communityPlugins, techpreview: techpreviewPlugins } = await loadPluginLists(core);
    core.info(`Loaded ${supportedPlugins.length} supported, ${techpreviewPlugins.length} tech preview, and ${communityPlugins.length} community plugins`);

    const workspacesData = [];

    for (const wsName of workspaceNames) {
      core.info(`Processing workspace: ${wsName}`);
      const wsPath = join(workspacesDir, wsName);

      const sourceData = await parseSourceJson(wsPath, core);
      const plugins = await parsePluginsList(wsPath, core);

      let commitSha = null;
      let commitShort = null;
      let commitMessage = 'N/A';
      let commitDate = 'N/A';
      let repoUrl = null;
      let repoFlat = false;

      if (sourceData) {
        repoUrl = sourceData.repo || null;
        commitSha = sourceData['repo-ref'] || null;
        repoFlat = sourceData['repo-flat'] || false;

        if (repoUrl && commitSha) {
          const commitDetails = await getCommitDetails(octokit, repoUrl, commitSha, core);
          commitShort = commitDetails.shortSha;
          commitMessage = commitDetails.message;
          commitDate = commitDetails.date;
        }
      }

      const overlayBackstageVersion = await getLocalBackstageVersion(wsPath, core);
      
      const sourceBackstageVersion = await getSourceBackstageVersion(octokit, repoUrl, commitSha, sourceData, core);

      const enhancedPlugins = [];
      if (repoUrl && commitSha) {
        core.info(`  Fetching plugin details for ${plugins.length} plugins...`);
        for (const pluginPath of plugins) {
          const cleanPath = pluginPath.replace(/^\.?\//, '');
          const fullPluginPath = repoFlat
            ? cleanPath
            : `workspaces/${wsName}/${cleanPath}`;

          const details = await getPluginDetails(octokit, repoUrl, commitSha, fullPluginPath, core);
          const supportStatus = checkSupportStatus(pluginPath, wsName, supportedPlugins, communityPlugins, techpreviewPlugins);

          enhancedPlugins.push({
            details,
            path: pluginPath,
            status: supportStatus
          });
        }
      } else {
        for (const pluginPath of plugins) {
          const supportStatus = checkSupportStatus(pluginPath, wsName, supportedPlugins, communityPlugins, techpreviewPlugins);
          enhancedPlugins.push({
            details: pluginPath,
            path: pluginPath,
            status: supportStatus
          });
        }
      }

      const additionalFiles = await countAdditionalFiles(wsPath, core);
      const { hasPending: hasPendingPRs, prNumbers } = await checkPendingPRs(
        octokit,
        wsName,
        repoName,
        branchName,
        core
      );

      workspacesData.push({
        name: wsName,
        repo_url: repoUrl,
        commit_sha: commitSha,
        commit_short: commitShort,
        commit_message: commitMessage,
        commit_date: commitDate,
        repo_flat: repoFlat,
        overlay_backstage_version: overlayBackstageVersion,
        source_backstage_version: sourceBackstageVersion,
        plugins: enhancedPlugins,
        additional_files: additionalFiles,
        has_pending_prs: hasPendingPRs,
        pr_numbers: prNumbers
      });
    }

    core.info('Generating Markdown content...');
    const markdownContent = generateMarkdown(branchName, workspacesData, repoName);

    const safeBranchName = branchName.replace(/\//g, '-');
    const outputFile = `${safeBranchName}.md`;
    await fs.writeFile(outputFile, markdownContent, 'utf-8');

    core.info(`Wiki page generated: ${outputFile}`);
    core.info(`Total workspaces documented: ${workspacesData.length}`);
  } catch (error) {
    core.setFailed(`Fatal error in main: ${error.message}`);
  }
};
