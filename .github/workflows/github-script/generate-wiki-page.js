// @ts-nocheck

const fs = require('fs').promises;
const { join } = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { load } = require('js-yaml');

const execFileAsync = promisify(execFile);

// Cache for repo checkouts to avoid cloning the same repo+commit multiple times
const checkoutCache = new Map();
// Cache for OCI image URL existence checks
const imageUrlCache = new Map();

// Debug counters for API usage tracking
const debugCounters = {
  githubApiCalls: 0,
  httpCalls: 0,
  gitOperations: 0,
  repoCacheHits: 0,
  imageCacheHits: 0
};

function logDebugCounters(core) {
  core.info('=== API Usage Debug Report ===');
  core.info(`GitHub API calls: ${debugCounters.githubApiCalls}`);
  core.info(`HTTP calls (OCI checks): ${debugCounters.httpCalls}`);
  core.info(`Git operations: ${debugCounters.gitOperations}`);
  core.info(`Repo cache hits: ${debugCounters.repoCacheHits}`);
  core.info(`Image cache hits: ${debugCounters.imageCacheHits}`);
  core.info('===============================');
}


async function getWorkspaceList(workspacesDir, core) {
  try {
    const entries = await fs.readdir(workspacesDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort();
  } catch (error) {
    core.setFailed(`Error reading workspaces directory ${workspacesDir}: ${error.message}`);
    throw error;
  }
}

async function parseSourceJson(workspacePath, core) {
  const sourceFile = join(workspacePath, 'source.json');
  try {
    const content = await fs.readFile(sourceFile, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    core.setFailed(`Error reading ${sourceFile}: ${error.message}`);
    throw error;
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
    core.setFailed(`Error reading ${pluginsFile}: ${error.message}`);
    throw error;
  }
}

/**
 * Ensures a shallow clone of the repo at the specified commit exists in /tmp.
 * Uses a cache to avoid re-cloning for the same repo+commit.
 */
async function ensureRepoCheckout(repoUrl, commitSha, core) {
  if (!repoUrl || !commitSha || !repoUrl.startsWith('https://github.com/')) {
    return null;
  }

  const cacheKey = `${repoUrl}@${commitSha}`;
  if (checkoutCache.has(cacheKey)) {
    debugCounters.repoCacheHits++;
    return checkoutCache.get(cacheKey);
  }

  const repoName = repoUrl.replace('https://github.com/', '').replace(/\/$/, '');
  const safeRepoName = repoName.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  const checkoutPath = join(os.tmpdir(), 'rhdh-wiki-repos', safeRepoName, commitSha.substring(0, 12));

  try {
    await fs.mkdir(checkoutPath, { recursive: true });

    const gitDir = join(checkoutPath, '.git');
    let hasGit = false;
    try {
      const stat = await fs.stat(gitDir);
      hasGit = stat.isDirectory();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        core.warning(`Error checking git dir in ${checkoutPath}: ${error.message}`);
      }
    }

    if (!hasGit) {
      core.info(`  Cloning ${repoUrl} at ${commitSha.substring(0, 7)}...`);
      debugCounters.gitOperations++;
      await execFileAsync('git', ['init'], { cwd: checkoutPath });
      await execFileAsync('git', ['remote', 'add', 'origin', repoUrl], { cwd: checkoutPath });
    }

    // Fetch only the specific commit (shallow, no history)
    debugCounters.gitOperations++;
    await execFileAsync('git', ['fetch', '--depth', '1', 'origin', commitSha], { cwd: checkoutPath });
    await execFileAsync('git', ['checkout', '--force', 'FETCH_HEAD'], { cwd: checkoutPath });

    checkoutCache.set(cacheKey, checkoutPath);
    return checkoutPath;
  } catch (error) {
    core.warning(`Error checking out ${repoUrl}@${commitSha}: ${error.message}`);
    checkoutCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Converts a package name to a container name for ghcr.io.
 */
function getContainerName(packageName) {
  if (!packageName) {
    return null;
  }

  if (packageName.startsWith('@')) {
    const withoutAt = packageName.substring(1);
    return withoutAt.replace('/', '-');
  }

  return packageName;
}

/**
 * Checks if an OCI image exists for the given package name at ghcr.io.
 * Returns the URL if it exists, null otherwise.
 */
async function getOciImageUrl(packageName, core) {
  const containerName = getContainerName(packageName);
  if (!containerName) {
    return null;
  }

  if (imageUrlCache.has(containerName)) {
    debugCounters.imageCacheHits++;
    return imageUrlCache.get(containerName);
  }

  const encodedPath = encodeURIComponent(`rhdh-plugin-export-overlays/${containerName}`);
  const url = `https://github.com/redhat-developer/rhdh-plugin-export-overlays/pkgs/container/${encodedPath}`;

  try {
    debugCounters.httpCalls++;
    let response = await fetch(url, { method: 'HEAD' });
    if (response.status === 405) {
      debugCounters.httpCalls++;
      response = await fetch(url);
    }

    if (response.status === 404) {
      imageUrlCache.set(containerName, null);
      return null;
    }

    if (response.ok || (response.status >= 300 && response.status < 400)) {
      imageUrlCache.set(containerName, url);
      return url;
    }

    imageUrlCache.set(containerName, null);
    return null;
  } catch (error) {
    core.warning(`Error checking OCI image for ${containerName}: ${error.message}`);
    imageUrlCache.set(containerName, null);
    return null;
  }
}

/**
 * Gets plugin details (name@version) by reading package.json from a local checkout.
 * Also checks for OCI image availability.
 */
async function getPluginDetails(repoUrl, commitSha, pluginPath, shouldCheckImage, core) {
  const result = { details: pluginPath, packageName: null, imageUrl: null };

  if (!repoUrl || !repoUrl.startsWith('https://github.com/')) {
    return result;
  }

  const repoPath = await ensureRepoCheckout(repoUrl, commitSha, core);
  if (!repoPath) {
    return result;
  }

  const cleanPluginPath = pluginPath === '.' ? '' : pluginPath;
  const packageJsonPath = cleanPluginPath
    ? join(repoPath, cleanPluginPath, 'package.json')
    : join(repoPath, 'package.json');

  try {
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(content);
    const name = packageJson.name || 'unknown';
    const version = packageJson.version || 'unknown';
    
    // Check for OCI image only if requested (e.g. for supported/tech-preview plugins)
    let imageUrl = null;
    if (shouldCheckImage) {
      imageUrl = await getOciImageUrl(name, core);
    }
    
    return {
      details: `${name}@${version}`,
      packageName: name,
      imageUrl
    };
  } catch (error) {
    core.warning(`Error reading package.json for ${pluginPath}: ${error.message}`);
  }

  return result;
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
      core.warning(`Error reading backstage.json from ${workspacePath}: ${error.message}`);
    }
  }
  return null;
}

/**
 * Gets the source backstage version directly from source.json's repo-backstage-version field.
 */
function getSourceBackstageVersion(sourceData) {
  if (sourceData && sourceData['repo-backstage-version']) {
    return sourceData['repo-backstage-version'];
  }
  return null;
}

async function loadPluginLists(core) {
  const supported = [];
  const community = [];
  const techpreview = [];

  const supportedPath = 'rhdh-supported-packages.txt';
  try {
    const content = await fs.readFile(supportedPath, 'utf-8');
    supported.push(...content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
    );
  } catch (error) {
    core.setFailed(`Error reading ${supportedPath}: ${error.message}`);
    throw error;
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
    core.setFailed(`Error reading ${communityPath}: ${error.message}`);
    throw error;
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
    core.setFailed(`Error reading ${techpreviewPath}: ${error.message}`);
    throw error;
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
    core.warning(`Error counting files in ${dirPath}: ${error.message}`);
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
        core.warning(`Error counting files in ${dirPath}: ${error.message}`);
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
        const imageUrl = p.imageUrl;
        const packageName = p.packageName;

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

        // Add OCI image link if available, or fallback to search for Supported/TechPreview
        // For Community/Unknown, link to the general packages page
        let imageLink = '';
        if (imageUrl) {
          imageLink = ` [📦](${imageUrl} "OCI Image")`;
        } else if (packageName) {
          const containerName = getContainerName(packageName) || packageName;
          const searchUrl = `https://github.com/orgs/redhat-developer/packages?tab=packages&q=${encodeURIComponent(containerName)}`;
          imageLink = ` [📦](${searchUrl} "Search OCI Image")`;
        } else {
           const generalPackagesUrl = "https://github.com/orgs/redhat-developer/packages?repo_name=rhdh-plugin-export-overlays";
           imageLink = ` [📦](${generalPackagesUrl} "Browse Packages")`;
        }
        
        return `<span title="${tooltip}">${icon}</span> <sub>\`${nameVer}\`</sub>${imageLink}`;
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
module.exports = async ({github, context, core, checkOciImages = false}) => {
  try {
    const branchName = context.ref.replace('refs/heads/', '');
    const repoName = `${context.repo.owner}/${context.repo.repo}`;
    
    core.info(`Generating wiki page for branch: ${branchName}`);
    core.info(`Repository: ${repoName}`);

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
      let repoUrl = null;
      let repoFlat = false;

      if (sourceData) {
        repoUrl = sourceData.repo || null;
        commitSha = sourceData['repo-ref'] || null;
        repoFlat = sourceData['repo-flat'] || false;

        if (commitSha) {
          commitShort = commitSha.substring(0, 7);
        }
      }

      const overlayBackstageVersion = await getLocalBackstageVersion(wsPath, core);
      const sourceBackstageVersion = getSourceBackstageVersion(sourceData);

      const enhancedPlugins = [];
      if (repoUrl && commitSha) {
        core.info(`  Fetching plugin details for ${plugins.length} plugins...`);
        for (const pluginPath of plugins) {
          const cleanPath = pluginPath.replace(/^\.?\//, '');
          const fullPluginPath = repoFlat
            ? cleanPath
            : `workspaces/${wsName}/${cleanPath}`;

          // Check support status first to determine if we should check for OCI image
          const supportStatus = checkSupportStatus(pluginPath, wsName, supportedPlugins, communityPlugins, techpreviewPlugins);
          const shouldCheckImage = checkOciImages && (supportStatus === 'Supported' || supportStatus === 'TechPreview');

          // Uses local git checkout instead of API
          const pluginInfo = await getPluginDetails(repoUrl, commitSha, fullPluginPath, shouldCheckImage, core);

          enhancedPlugins.push({
            details: pluginInfo.details,
            imageUrl: pluginInfo.imageUrl,
            packageName: pluginInfo.packageName,
            path: pluginPath,
            status: supportStatus
          });
        }
      } else {
        for (const pluginPath of plugins) {
          const supportStatus = checkSupportStatus(pluginPath, wsName, supportedPlugins, communityPlugins, techpreviewPlugins);
          enhancedPlugins.push({
            details: pluginPath,
            imageUrl: null,
            packageName: null,
            path: pluginPath,
            status: supportStatus
          });
        }
      }

      const additionalFiles = await countAdditionalFiles(wsPath, core);

      workspacesData.push({
        name: wsName,
        repo_url: repoUrl,
        commit_sha: commitSha,
        commit_short: commitShort,
        repo_flat: repoFlat,
        overlay_backstage_version: overlayBackstageVersion,
        source_backstage_version: sourceBackstageVersion,
        plugins: enhancedPlugins,
        additional_files: additionalFiles
      });
    }

    core.info('Generating Markdown content...');
    const markdownContent = generateMarkdown(branchName, workspacesData, repoName);

    const safeBranchName = branchName.replace(/\//g, '-');
    const outputFile = `${safeBranchName}.md`;
    await fs.writeFile(outputFile, markdownContent, 'utf-8');

    logDebugCounters(core);
    core.info(`Wiki page generated: ${outputFile}`);
    core.info(`Total workspaces documented: ${workspacesData.length}`);
  } catch (error) {
    core.setFailed(`Fatal error in main: ${error.message}`);
  }
};
