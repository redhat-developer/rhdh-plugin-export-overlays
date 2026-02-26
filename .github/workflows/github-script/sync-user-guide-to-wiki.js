// @ts-nocheck
/**
 * Sync User Guide to GitHub Wiki
 * 
 * This script:
 * 1. Reads repository data (versions.json, plugins-regexps, workspaces)
 * 2. Generates dynamic content sections
 * 3. Transforms user guide files for wiki format
 * 4. Pushes changes to the wiki repository
 */

const fs = require('fs').promises;
const { join } = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);

// File mapping: source path -> wiki page name
const FILE_MAP = {
  'user-guide/README.md': 'User-Guide-Overview',
  'user-guide/01-getting-started.md': 'Getting-Started',
  'user-guide/02-export-tools.md': 'Export-Tools',
  'user-guide/03-plugin-owner-responsibilities.md': 'Plugin-Owner-Guide',
  'user-guide/04-metadata-synchronization.md': 'Metadata-Synchronization',
  'user-guide/05-version-updates.md': 'Version-Updates',
  'user-guide/06-patch-management.md': 'Patch-Management',
};

// Link transformations for wiki format
// Using standard markdown links: [Text](Page-Name) or [Text](Page-Name#anchor)
const LINK_TRANSFORMS = [
  { from: /\[([^\]]+)\]\(\.\/01-getting-started\.md(#[^\)]+)?\)/g, to: '[$1](Getting-Started$2)' },
  { from: /\[([^\]]+)\]\(\.\/02-export-tools\.md(#[^\)]+)?\)/g, to: '[$1](Export-Tools$2)' },
  { from: /\[([^\]]+)\]\(\.\/03-plugin-owner-responsibilities\.md(#[^\)]+)?\)/g, to: '[$1](Plugin-Owner-Guide$2)' },
  { from: /\[([^\]]+)\]\(\.\/04-metadata-synchronization\.md(#[^\)]+)?\)/g, to: '[$1](Metadata-Synchronization$2)' },
  { from: /\[([^\]]+)\]\(\.\/05-version-updates\.md(#[^\)]+)?\)/g, to: '[$1](Version-Updates$2)' },
  { from: /\[([^\]]+)\]\(\.\/06-patch-management\.md(#[^\)]+)?\)/g, to: '[$1](Patch-Management$2)' },
];

// Source repository metadata
const SOURCE_REPOS = {
  '@backstage-community/': {
    name: 'Backstage Community Plugins',
    url: 'https://github.com/backstage/community-plugins'
  },
  '@red-hat-developer-hub/': {
    name: 'Red Hat Developer Hub Plugins',
    url: 'https://github.com/redhat-developer/rhdh-plugins'
  },
  '@roadiehq/': {
    name: 'Roadie Backstage Plugins',
    url: 'https://github.com/RoadieHQ/roadie-backstage-plugins'
  }
};

/**
 * Read and parse versions.json
 */
async function readVersionsJson(repoRoot) {
  try {
    const content = await fs.readFile(join(repoRoot, 'versions.json'), 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

/**
 * Read plugins-regexps to get supported scopes
 */
async function readPluginsRegexps(repoRoot) {
  try {
    const content = await fs.readFile(join(repoRoot, 'plugins-regexps'), 'utf-8');
    return content.trim().split('\n').filter(line => line.trim());
  } catch (error) {
    return [];
  }
}

/**
 * Get list of workspaces with basic stats
 */
async function getWorkspaceStats(repoRoot) {
  const workspacesDir = join(repoRoot, 'workspaces');
  const stats = {
    total: 0,
    withPatches: 0,
    workspaces: []
  };
  
  try {
    const entries = await fs.readdir(workspacesDir, { withFileTypes: true });
    const workspaceDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
    
    for (const dir of workspaceDirs) {
      const wsPath = join(workspacesDir, dir.name);
      const wsInfo = { name: dir.name, hasPatches: false, patchCount: 0 };
      
      // Check for patches
      try {
        const patchesDir = join(wsPath, 'patches');
        const patches = await fs.readdir(patchesDir);
        const patchFiles = patches.filter(f => f.endsWith('.patch'));
        if (patchFiles.length > 0) {
          wsInfo.hasPatches = true;
          wsInfo.patchCount = patchFiles.length;
          stats.withPatches++;
        }
      } catch {
        // No patches directory
      }
      
      stats.workspaces.push(wsInfo);
      stats.total++;
    }
    
    stats.workspaces.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    // Ignore errors
  }
  
  return stats;
}

/**
 * Generate dynamic content based on repository data
 */
function generateDynamicContent(versions, regexps, workspaceStats, owner, repo) {
  const content = {};
  
  // Versions table
  if (versions) {
    content.VERSIONS_TABLE = `| Component | Version |
|-----------|---------|
| Backstage | \`${versions.backstage}\` |
| Node.js | \`${versions.node}\` |
| CLI | \`${versions.cliPackage}@${versions.cli}\` |`;

    content.BACKSTAGE_VERSION = versions.backstage;
    content.NODE_VERSION = versions.node;
    content.CLI_VERSION = versions.cli;
    content.CLI_PACKAGE = versions.cliPackage;
  }
  
  // Supported source repos
  if (regexps.length > 0) {
    const repoLines = regexps.map(regex => {
      const scope = regex.replace(/\\\//g, '/');
      const info = SOURCE_REPOS[scope];
      if (info) {
        return `| \`${scope}\` | [${info.name}](${info.url}) |`;
      }
      return `| \`${scope}\` | — |`;
    });
    content.SOURCE_REPOS_TABLE = `| Scope | Repository |
|-------|------------|
${repoLines.join('\n')}`;
  }
  
  // Workspace stats
  content.WORKSPACE_COUNT = workspaceStats.total.toString();
  content.WORKSPACES_WITH_PATCHES = workspaceStats.withPatches.toString();
  
  // Workflow URLs
  const baseUrl = `https://github.com/${owner}/${repo}`;
  content.WORKFLOW_EXPORT = `${baseUrl}/actions/workflows/export-workspaces-as-dynamic.yaml`;
  content.WORKFLOW_UPDATE_REFS = `${baseUrl}/actions/workflows/update-plugins-repo-refs.yaml`;
  content.WIKI_URL = `${baseUrl}/wiki`;
  content.WORKSPACE_STATUS_REPORTS_PAGE = 'Workspace-Status-Reports';
  
  return content;
}

/**
 * Replace placeholders in content with dynamic values
 * Placeholders use format: <!-- AUTO:KEY --> or {{AUTO:KEY}}
 */
function injectDynamicContent(content, dynamicContent) {
  let result = content;
  
  for (const [key, value] of Object.entries(dynamicContent)) {
    // Replace <!-- AUTO:KEY --> blocks
    const commentRegex = new RegExp(`<!--\\s*AUTO:${key}\\s*-->`, 'g');
    result = result.replace(commentRegex, value);
    
    // Replace {{AUTO:KEY}} inline placeholders
    const inlineRegex = new RegExp(`\\{\\{AUTO:${key}\\}\\}`, 'g');
    result = result.replace(inlineRegex, value);
  }
  
  return result;
}

/**
 * Transform markdown content for wiki format
 */
function transformForWiki(content, dynamicContent) {
  let transformed = content;
  
  // Inject dynamic content first
  transformed = injectDynamicContent(transformed, dynamicContent);
  
  // Transform links for wiki format
  for (const { from, to } of LINK_TRANSFORMS) {
    transformed = transformed.replace(from, to);
  }
  
  return transformed;
}

/**
 * Generate the wiki sidebar navigation
 */
function generateSidebar(workspaceStats, reportPages) {
  const reportLinks = reportPages.length > 0
    ? reportPages.map(({ branchName, pageName }) => `  * [${branchName}](${pageName})`).join('\n')
    : '  * [main](main)';

  return `### 📚 User Guide
* [Home](Home)
* [Getting Started](Getting-Started)
* [Export Tools](Export-Tools)

### 🔧 Plugin Maintenance
* [Plugin Owner Guide](Plugin-Owner-Guide)
* [Metadata Synchronization](Metadata-Synchronization)
* [Version Updates](Version-Updates)
* [Patch Management](Patch-Management)

### 📊 Generated Reports
* [Backstage Compatibility Report](Backstage-Compatibility-Report)
* [Workspace Status Reports](Workspace-Status-Reports)
${reportLinks}

### 📈 Stats
* **${workspaceStats.total}** workspaces
* **${workspaceStats.withPatches}** with patches

### 🔗 External Resources
* [Dynamic Plugins Docs](https://github.com/redhat-developer/rhdh/tree/main/docs/dynamic-plugins)
* [Export CLI Reference](https://github.com/redhat-developer/rhdh/blob/main/docs/dynamic-plugins/export-derived-package.md)
* [Backstage Documentation](https://backstage.io/docs)
`;
}

/**
 * Detect branch-specific workspace status pages in the wiki.
 * Expected page names are `main` and `release-*`.
 */
async function detectWorkspaceStatusReportPages(wikiDir) {
  const files = await fs.readdir(wikiDir, { withFileTypes: true });
  const pages = files
    .filter(file => file.isFile() && file.name.endsWith('.md'))
    .map(file => file.name.replace(/\.md$/, ''))
    .filter(name => name === 'main' || name.startsWith('release-'))
    .sort((a, b) => {
      if (a === 'main') return -1;
      if (b === 'main') return 1;
      return b.localeCompare(a, undefined, { numeric: true });
    })
    .map(pageName => ({ pageName, branchName: pageName }));

  if (!pages.some(page => page.pageName === 'main')) {
    pages.unshift({ pageName: 'main', branchName: 'main' });
  }

  return pages;
}

/**
 * Generate a discoverability page for branch-specific workspace status reports.
 */
function generateWorkspaceStatusReportsPage(reportPages) {
  const pageLinks = reportPages
    .map(({ branchName, pageName }) => `- [\`${branchName}\`](${pageName})`)
    .join('\n');

  return `# Workspace Status Reports

This repository publishes regularly generated workspace status pages for merged content on \`main\` and each maintained \`release-*\` branch. There is one generated status page per branch.

## Available Branch Reports

${pageLinks}

## What These Reports Contain

- A **last updated** timestamp for the generated report
- The **total workspaces** count for that branch snapshot
- A **Workspace Overview** table that summarizes each workspace
- Searchable details for each workspace, including workspace name, source repository and ref, Backstage version, plugin package/version details, and visual warnings/markers (for example version override warnings and metadata status indicators)

## How to Use These Pages

- Start with the branch that matches your target deployment line (for example \`main\` or \`release-1.9\`)
- Use your browser search to quickly locate a workspace by name or package
- Compare source repo/ref and Backstage version data when validating updates or troubleshooting exports
- Check markers and warnings to spot metadata gaps, overlays/patch usage, and version overrides
`;
}

/**
 * Generate the wiki home page with dynamic content
 */
function generateHomePage(versions, workspaceStats, owner, repo) {
  const backstageVersion = versions?.backstage || 'N/A';
  const cliInfo = versions ? `${versions.cliPackage}@${versions.cli}` : 'N/A';
  
  return `# Dynamic Plugins Overlay Repository

Welcome to the documentation for the \`rhdh-plugin-export-overlays\` repository.

## Current Versions

| Component | Version |
|-----------|---------|
| Target Backstage | \`${backstageVersion}\` |
| Node.js | \`${versions?.node || 'N/A'}\` |
| Export CLI | \`${cliInfo}\` |

> 🔄 *Auto-generated from \`versions.json\`*

## Quick Start

- **New to this repo?** Start with [Getting Started](Getting-Started)
- **Adding a plugin?** See [Adding a New Plugin](Getting-Started#adding-a-new-plugin)
- **Plugin owner?** Review [Plugin Owner Guide](Plugin-Owner-Guide)

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](Getting-Started) | Core concepts, repository structure |
| [Export Tools](Export-Tools) | CLI arguments, workflow inputs |
| [Plugin Owner Guide](Plugin-Owner-Guide) | Maintenance responsibilities |
| [Metadata Synchronization](Metadata-Synchronization) | Keeping source and overlay in sync |
| [Version Updates](Version-Updates) | Backstage version management |
| [Patch Management](Patch-Management) | Creating and maintaining patches |

## Repository Stats

| Metric | Count |
|--------|-------|
| Total Workspaces | ${workspaceStats.total} |
| Workspaces with Patches | ${workspaceStats.withPatches} |

> 🔄 *Auto-generated from repository structure*

## Status & Reports

- [Backstage Compatibility Report](Backstage-Compatibility-Report) - Current compatibility status across workspaces

## External Resources

- [Dynamic Plugins Documentation](https://github.com/redhat-developer/rhdh/tree/main/docs/dynamic-plugins)
- [Export CLI Reference](https://github.com/redhat-developer/rhdh/blob/main/docs/dynamic-plugins/export-derived-package.md)
- [Backstage Official Documentation](https://backstage.io/docs)

---
*Last synced: ${new Date().toISOString().split('T')[0]}*
`;
}

/**
 * Clone the wiki repository
 */
async function cloneWiki(wikiUrl, targetDir, core) {
  core.info(`Cloning wiki repository to ${targetDir}...`);
  
  await fs.mkdir(targetDir, { recursive: true });
  
  try {
    await execFileAsync('git', ['clone', '--depth', '1', wikiUrl, targetDir]);
    core.info('Wiki repository cloned successfully');
  } catch (error) {
    core.warning(`Could not clone wiki (may not exist yet): ${error.message}`);
    await execFileAsync('git', ['init'], { cwd: targetDir });
    await execFileAsync('git', ['remote', 'add', 'origin', wikiUrl], { cwd: targetDir });
  }
}

/**
 * Commit and push changes to wiki
 */
async function pushWikiChanges(wikiDir, commitMessage, core) {
  try {
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: wikiDir });
    
    if (!status.trim()) {
      core.info('No changes to push to wiki');
      return false;
    }
    
    core.info('Committing and pushing wiki changes...');
    
    await execFileAsync('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: wikiDir });
    await execFileAsync('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: wikiDir });
    await execFileAsync('git', ['add', '.'], { cwd: wikiDir });
    await execFileAsync('git', ['commit', '-m', commitMessage], { cwd: wikiDir });
    await execFileAsync('git', ['push', 'origin', 'master'], { cwd: wikiDir });
    
    core.info('Wiki changes pushed successfully');
    return true;
  } catch (error) {
    core.error(`Failed to push wiki changes: ${error.message}`);
    throw error;
  }
}

/**
 * Main sync function
 */
async function syncUserGuideToWiki({ github, context, core }) {
  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const wikiUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${owner}/${repo}.wiki.git`;
  const wikiDir = join(os.tmpdir(), `wiki-sync-${Date.now()}`);
  const dryRun = process.env.DRY_RUN === 'true';
  
  core.info('=== Wiki Sync Script ===');
  core.info(`Repository: ${owner}/${repo}`);
  core.info(`Dry run: ${dryRun}`);
  
  try {
    // Read repository data
    core.info('\nReading repository data...');
    const versions = await readVersionsJson(repoRoot);
    const regexps = await readPluginsRegexps(repoRoot);
    const workspaceStats = await getWorkspaceStats(repoRoot);
    
    core.info(`  Backstage version: ${versions?.backstage || 'N/A'}`);
    core.info(`  Supported scopes: ${regexps.length}`);
    core.info(`  Workspaces: ${workspaceStats.total} (${workspaceStats.withPatches} with patches)`);
    
    // Generate dynamic content
    const dynamicContent = generateDynamicContent(versions, regexps, workspaceStats, owner, repo);
    
    // Clone wiki
    await cloneWiki(wikiUrl, wikiDir, core);

    // Detect existing workspace status report pages before writing new content
    const reportPages = await detectWorkspaceStatusReportPages(wikiDir);
    core.info(`Detected ${reportPages.length} workspace status report pages`);
    
    // Process each user guide file
    core.info('\nProcessing user guide files...');
    let filesProcessed = 0;
    
    for (const [srcPath, wikiName] of Object.entries(FILE_MAP)) {
      const srcFile = join(repoRoot, srcPath);
      const destFile = join(wikiDir, `${wikiName}.md`);
      
      try {
        const content = await fs.readFile(srcFile, 'utf-8');
        const transformed = transformForWiki(content, dynamicContent);
        await fs.writeFile(destFile, transformed, 'utf-8');
        core.info(`  ✓ ${srcPath} -> ${wikiName}.md`);
        filesProcessed++;
      } catch (error) {
        if (error.code === 'ENOENT') {
          core.warning(`  ⚠ ${srcPath} not found, skipping`);
        } else {
          throw error;
        }
      }
    }
    
    // Generate sidebar with stats
    core.info('Generating _Sidebar.md...');
    await fs.writeFile(join(wikiDir, '_Sidebar.md'), generateSidebar(workspaceStats, reportPages), 'utf-8');

    // Generate workspace status reports index page
    core.info('Generating Workspace-Status-Reports.md...');
    await fs.writeFile(
      join(wikiDir, 'Workspace-Status-Reports.md'),
      generateWorkspaceStatusReportsPage(reportPages),
      'utf-8'
    );
    
    // Always regenerate home page with latest stats
    core.info('Generating Home.md with dynamic content...');
    await fs.writeFile(join(wikiDir, 'Home.md'), generateHomePage(versions, workspaceStats, owner, repo), 'utf-8');
    
    // Summary
    core.info(`\nProcessed ${filesProcessed} user guide files`);
    
    // Show changes
    const { stdout: diffStat } = await execFileAsync('git', ['status', '--short'], { cwd: wikiDir });
    if (diffStat.trim()) {
      core.info('\nChanges:');
      core.info(diffStat);
    }
    
    // Push changes
    if (!dryRun) {
      const commitMessage = `docs: sync user guide from main repository

Synced from commit: ${context.sha?.substring(0, 7) || 'unknown'}
Backstage version: ${versions?.backstage || 'unknown'}
Workspaces: ${workspaceStats.total}
Triggered by: ${context.eventName}`;
      
      const pushed = await pushWikiChanges(wikiDir, commitMessage, core);
      
      if (pushed) {
        core.info('\n✅ Wiki updated successfully');
        core.info(`View at: https://github.com/${owner}/${repo}/wiki`);
      }
    } else {
      core.info('\n🔍 Dry run complete - no changes pushed');
    }
    
    return { success: true, filesProcessed, versions, workspaceStats };
    
  } catch (error) {
    core.setFailed(`Wiki sync failed: ${error.message}`);
    throw error;
  } finally {
    try {
      await fs.rm(wikiDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

module.exports = syncUserGuideToWiki;
