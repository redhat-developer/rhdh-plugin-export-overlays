#!/usr/bin/env node
/**
 * Propose (and optionally open) overlay source.json PRs for stale repo-refs.
 *
 * Failures never abort catalog index generation. When a PR cannot be opened,
 * a unified patch is written and its path is logged.
 *
 * Copyright (c) Red Hat, Inc. SPDX-License-Identifier: EPL-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JIRA_ISSUE_DEFAULT = 'RHIDP-17975';
const OVERLAYS_GITHUB = 'redhat-developer/rhdh-plugin-export-overlays';
const BOT_NAME = 'rhdh-bot';
const BOT_EMAIL = 'rhdh-bot@redhat.com';
const PACKAGE_TAG_RE = /^(@[^/]+\/[^@]+|[^@]+)@([^@]+)$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export type JsonMap = Record<string, unknown>;
export type FetchJson = (url: string) => JsonMap | null;
export type RunNpm = (packageName: string, version: string) => string | null;
export type RunGitLog = (repoUrl: string, needle: string, pathName: string) => string | null;

export type PluginMeta = { packageName: string; version: string };
export type StalePlugin = PluginMeta & { container: string; pinned?: string };
export type FallbackEntry = {
  container: string;
  haveTag: string;
  requestedTag: string;
  workspace: string;
};
export type Proposal = {
  workspace: string;
  oldRef: string;
  newRef: string;
  plugins: PluginMeta[];
  reason: string;
  newBackstage: string | null;
};

function logInfo(msg: string): void {
  console.log(`[INFO] ${msg}`);
}
function logWarn(msg: string): void {
  console.log(`[WARN] ${msg}`);
}
function logError(msg: string): void {
  console.error(`[ERROR] ${msg}`);
}

export function pluginVersionFromTag(tag: string): string | null {
  if (!tag) return null;
  if (tag.includes('__')) return tag.split('__').pop() ?? null;
  if (tag.includes('--')) return tag.split('--').pop() ?? null;
  return null;
}

function parseVersion(version: string): number[] {
  const parts: number[] = [];
  for (const token of version.trim().split(/[.+-]/)) {
    if (/^\d+$/.test(token)) parts.push(Number(token));
    else break;
  }
  return parts.length ? parts : [0];
}

export function versionNewer(requested: string, pinned: string): boolean {
  const a = parseVersion(requested);
  const b = parseVersion(pinned);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

export function githubOwnerRepo(repoUrl: string): [string, string] | null {
  const match = (repoUrl || '').match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return [match[1], match[2].replace(/\.git$/, '')];
}

export function packageDirInSource(
  workspace: string,
  workspacePath: string,
  repoFlat: boolean,
): string {
  let rel = workspacePath.replace(/^\/+|\/+$/g, '');
  rel = rel.startsWith(`${workspace}/`) ? rel.slice(workspace.length + 1) : rel;
  if (repoFlat) return rel;
  if (rel.startsWith('workspaces/')) return rel;
  return rel ? `workspaces/${workspace}/${rel}` : `workspaces/${workspace}`;
}

export function isPackageTag(repoRef: string): boolean {
  return PACKAGE_TAG_RE.test(repoRef || '') && !SHA_RE.test(repoRef || '');
}

function loadSourceJson(overlaysDir: string, workspace: string): JsonMap | null {
  const file = path.join(overlaysDir, 'workspaces', workspace, 'source.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as JsonMap)
      : null;
  } catch {
    return null;
  }
}

function loadMetadataPlugins(overlaysDir: string, workspace: string): PluginMeta[] {
  const metaDir = path.join(overlaysDir, 'workspaces', workspace, 'metadata');
  if (!existsSync(metaDir)) return [];
  const plugins: PluginMeta[] = [];
  for (const name of readdirSync(metaDir).sort()) {
    if (!name.endsWith('.yaml')) continue;
    const text = readFileSync(path.join(metaDir, name), 'utf8');
    const pkg = text.match(/packageName:\s*["']?([^\s"']+)/);
    const ver = text.match(/^\s*version:\s*["']?([^\s"']+)/m);
    if (pkg?.[1] && ver?.[1]) {
      plugins.push({ packageName: pkg[1], version: ver[1] });
    }
  }
  return plugins;
}

export function collectFallbackEntries(pluginBuildsDir: string): FallbackEntry[] {
  const fallbacks: FallbackEntry[] = [];
  if (!existsSync(pluginBuildsDir)) return fallbacks;
  for (const workspace of readdirSync(pluginBuildsDir).sort()) {
    const wsDir = path.join(pluginBuildsDir, workspace);
    let files: string[];
    try {
      files = readdirSync(wsDir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      let data: JsonMap;
      try {
        data = JSON.parse(readFileSync(path.join(wsDir, file), 'utf8')) as JsonMap;
      } catch {
        continue;
      }
      for (const [pluginName, pluginData] of Object.entries(data)) {
        if (!pluginData || typeof pluginData !== 'object' || Array.isArray(pluginData)) {
          continue;
        }
        const plugin = pluginData as JsonMap;
        if (!plugin.fallback) continue;
        const ref = typeof plugin.registryReference === 'string' ? plugin.registryReference : '';
        const haveTag = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : '';
        const wantTag = typeof plugin.requestedTag === 'string' ? plugin.requestedTag : '';
        fallbacks.push({
          container: pluginName,
          haveTag,
          requestedTag: wantTag,
          workspace,
        });
      }
    }
  }
  return fallbacks.sort((a, b) => a.container.localeCompare(b.container));
}

function pluginBuildsWorkspacePaths(
  pluginBuildsDir: string,
  workspace: string,
): Record<string, string> {
  const paths: Record<string, string> = {};
  const wsDir = path.join(pluginBuildsDir, workspace);
  if (!existsSync(wsDir)) return paths;
  for (const file of readdirSync(wsDir).filter((f) => f.endsWith('.json'))) {
    let data: JsonMap;
    try {
      data = JSON.parse(readFileSync(path.join(wsDir, file), 'utf8')) as JsonMap;
    } catch {
      continue;
    }
    for (const [name, plugin] of Object.entries(data)) {
      if (plugin && typeof plugin === 'object' && !Array.isArray(plugin)) {
        const wp = (plugin as JsonMap).workspacePath;
        if (typeof wp === 'string') paths[name] = wp;
      }
    }
  }
  return paths;
}

export function defaultFetchJson(url: string): JsonMap | null {
  try {
    const result = spawnSync('curl', ['-fsSL', '--max-time', '20', url], {
      encoding: 'utf8',
    });
    if (result.status !== 0) return null;
    return JSON.parse(result.stdout) as JsonMap;
  } catch {
    return null;
  }
}

export function defaultNpmGitHead(packageName: string, version: string): string | null {
  const result = spawnSync(
    'npm',
    ['view', `${packageName}@${version}`, 'gitHead', '--json'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (result.status !== 0) return null;
  const raw = (result.stdout || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string' && SHA_RE.test(parsed)) return parsed;
  } catch {
    const stripped = raw.replace(/^["']|["']$/g, '');
    if (SHA_RE.test(stripped)) return stripped;
  }
  return null;
}

export function defaultGitLogSha(
  repoUrl: string,
  needle: string,
  pathName: string,
): string | null {
  const tmp = mkdtempSync(path.join(tmpdir(), 'source-json-git-'));
  try {
    const clone = spawnSync(
      'git',
      ['clone', '--filter=blob:none', '--no-checkout', repoUrl, tmp],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (clone.status !== 0) return null;
    const log = spawnSync(
      'git',
      ['-C', tmp, 'log', '-1', '--format=%H', '-S', needle, '--', pathName],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const sha = (log.stdout || '').trim();
    return SHA_RE.test(sha) ? sha : null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function fetchPackageVersionAtRef(
  repoUrl: string,
  repoRef: string,
  packageDir: string,
  fetchJson: FetchJson,
): string | null {
  const ownerRepo = githubOwnerRepo(repoUrl);
  if (!ownerRepo) return null;
  const [owner, repo] = ownerRepo;
  const encodedRef = repoRef.replaceAll('/', '%2F');
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodedRef}/${packageDir}/package.json`;
  const data = fetchJson(url);
  const version = data && typeof data.version === 'string' ? data.version.trim() : '';
  return version || null;
}

function fetchBackstageVersionAtRef(
  repoUrl: string,
  repoRef: string,
  workspace: string,
  repoFlat: boolean,
  fetchJson: FetchJson,
): string | null {
  const ownerRepo = githubOwnerRepo(repoUrl);
  if (!ownerRepo) return null;
  const [owner, repo] = ownerRepo;
  const encodedRef = repoRef.replaceAll('/', '%2F');
  const rel = repoFlat ? 'backstage.json' : `workspaces/${workspace}/backstage.json`;
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodedRef}/${rel}`;
  const data = fetchJson(url);
  const version = data && typeof data.version === 'string' ? data.version.trim() : '';
  return version || null;
}

function resolveNewRepoRef(
  source: JsonMap,
  plugins: PluginMeta[],
  npmGitHead: RunNpm,
  gitLogSha: RunGitLog,
  fetchJson: FetchJson,
  packageDirs: Record<string, string>,
): string | null {
  const repoRef = String(source['repo-ref'] || '');
  const repoUrl = String(source.repo || '');
  if (isPackageTag(repoRef) && plugins.length === 1) {
    return `${plugins[0].packageName}@${plugins[0].version}`;
  }
  let candidate: string | null = null;
  for (const plugin of plugins) {
    const head = npmGitHead(plugin.packageName, plugin.version);
    if (head) {
      candidate = head;
      break;
    }
  }
  if (!candidate) {
    for (const plugin of plugins) {
      const pkgDir = packageDirs[plugin.packageName] || '';
      if (!pkgDir) continue;
      candidate = gitLogSha(
        repoUrl,
        `"version": "${plugin.version}"`,
        `${pkgDir}/package.json`,
      );
      if (candidate) break;
    }
  }
  if (!candidate) return null;
  for (const plugin of plugins) {
    const pkgDir = packageDirs[plugin.packageName] || '';
    if (!pkgDir) continue;
    const found = fetchPackageVersionAtRef(repoUrl, candidate, pkgDir, fetchJson);
    if (found !== plugin.version) {
      logError(
        `Ref ${candidate} has ${plugin.packageName}@${found || 'missing'}, need ${plugin.version}; skip workspace`,
      );
      return null;
    }
  }
  return candidate;
}

function finishClassify(
  workspace: string,
  source: JsonMap,
  repoUrl: string,
  repoRef: string,
  repoFlat: boolean,
  stale: StalePlugin[],
  packageDirs: Record<string, string>,
  fetchJson: FetchJson,
  npmGitHead: RunNpm,
  gitLogSha: RunGitLog,
): Proposal | string {
  const pinVersions: string[] = [];
  for (const plugin of stale) {
    const pkgDir = packageDirs[plugin.packageName] || '';
    if (!pkgDir) continue;
    const pinned = fetchPackageVersionAtRef(repoUrl, repoRef, pkgDir, fetchJson);
    if (pinned) {
      pinVersions.push(pinned);
      plugin.pinned = pinned;
    }
  }
  if (!pinVersions.length) pinVersions.push('');

  let needsBump = false;
  for (const plugin of stale) {
    const pinned = plugin.pinned || pinVersions[0] || '';
    if (!pinned) {
      needsBump = true;
      continue;
    }
    if (versionNewer(plugin.version, pinned)) needsBump = true;
    else if (pinned === plugin.version) continue;
    else {
      return `${workspace}: pinned ${plugin.packageName}@${pinned} is not older than requested ${plugin.version}`;
    }
  }
  if (!needsBump) {
    return `${workspace}: image-lag (source.json already at requested version)`;
  }
  const requested = stale.map((p) => ({
    packageName: p.packageName,
    version: p.version,
  }));
  const newRef = resolveNewRepoRef(
    source,
    requested,
    npmGitHead,
    gitLogSha,
    fetchJson,
    packageDirs,
  );
  if (!newRef) return `${workspace}: could not resolve a repo-ref for ${JSON.stringify(requested)}`;
  if (newRef === repoRef) {
    return `${workspace}: image-lag (resolved ref matches current pin)`;
  }
  return {
    workspace,
    oldRef: repoRef,
    newRef,
    plugins: requested,
    reason: 'stale-pin',
    newBackstage: fetchBackstageVersionAtRef(
      repoUrl,
      newRef,
      workspace,
      repoFlat,
      fetchJson,
    ),
  };
}

export function classifyFallbacks(
  overlaysDir: string,
  pluginBuildsDir: string,
  deps: {
    fetchJson?: FetchJson;
    npmGitHead?: RunNpm;
    gitLogSha?: RunGitLog;
  } = {},
): { proposals: Proposal[]; skips: string[] } {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const npmGitHead = deps.npmGitHead ?? defaultNpmGitHead;
  const gitLogSha = deps.gitLogSha ?? defaultGitLogSha;
  const byWs = new Map<string, FallbackEntry[]>();
  for (const entry of collectFallbackEntries(pluginBuildsDir)) {
    const list = byWs.get(entry.workspace) ?? [];
    list.push(entry);
    byWs.set(entry.workspace, list);
  }
  const proposals: Proposal[] = [];
  const skips: string[] = [];
  for (const workspace of [...byWs.keys()].sort()) {
    const entries = byWs.get(workspace) ?? [];
    const paths = pluginBuildsWorkspacePaths(pluginBuildsDir, workspace);
    const source = loadSourceJson(overlaysDir, workspace);
    if (!source) {
      skips.push(`${workspace}: missing source.json`);
      continue;
    }
    const repoFlat = Boolean(source['repo-flat']);
    const stale: StalePlugin[] = [];
    const packageDirs: Record<string, string> = {};
    const metadata = loadMetadataPlugins(overlaysDir, workspace);
    const metaByContainer = new Map<string, PluginMeta>();
    for (const plugin of metadata) {
      const slug = plugin.packageName.replace(/^@/, '').replaceAll('/', '-');
      metaByContainer.set(slug, plugin);
    }
    for (const entry of entries) {
      const wantVer = pluginVersionFromTag(entry.requestedTag);
      let meta = metaByContainer.get(entry.container);
      if (!meta) meta = metadata.find((p) => p.version === wantVer);
      if (!meta && metadata.length === 1) meta = metadata[0];
      if (!meta) {
        skips.push(`${workspace}/${entry.container}: no metadata`);
        continue;
      }
      const wsPath = paths[entry.container] || '';
      const pkgDir = wsPath ? packageDirInSource(workspace, wsPath, repoFlat) : '';
      stale.push({
        packageName: meta.packageName,
        version: wantVer || meta.version,
        container: entry.container,
      });
      if (pkgDir) packageDirs[meta.packageName] = pkgDir;
    }
    if (!stale.length) continue;
    const finished = finishClassify(
      workspace,
      source,
      String(source.repo || ''),
      String(source['repo-ref'] || ''),
      repoFlat,
      stale,
      packageDirs,
      fetchJson,
      npmGitHead,
      gitLogSha,
    );
    if (typeof finished === 'string') skips.push(finished);
    else proposals.push(finished);
  }
  return { proposals, skips };
}

export function applyProposals(overlaysDir: string, proposals: Proposal[]): string[] {
  const changed: string[] = [];
  for (const proposal of proposals) {
    const file = path.join(overlaysDir, 'workspaces', proposal.workspace, 'source.json');
    const original = readFileSync(file, 'utf8');
    const data = JSON.parse(original) as JsonMap;
    data['repo-ref'] = proposal.newRef;
    if (proposal.newBackstage) data['repo-backstage-version'] = proposal.newBackstage;
    const text = original.includes('\n  ')
      ? `${JSON.stringify(data, null, 2)}\n`
      : `${JSON.stringify(data)}\n`;
    writeFileSync(file, text, 'utf8');
    changed.push(file);
  }
  return changed;
}

function writePatch(overlaysDir: string, patchPath: string): void {
  const result = spawnSync('git', ['-C', overlaysDir, 'diff', '--', 'workspaces'], {
    encoding: 'utf8',
  });
  mkdirSync(path.dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, result.stdout || '', 'utf8');
}

export function prBody(proposals: Proposal[], issue: string): string {
  const lines = [
    '## Summary',
    'Bump overlay `source.json` `repo-ref` values so they match catalog metadata versions that currently fall back to an older published image.',
    '',
    `Jira: https://redhat.atlassian.net/browse/${issue}`,
    '',
    '| Workspace | Old repo-ref | New repo-ref | Plugins |',
    '| --- | --- | --- | --- |',
  ];
  for (const proposal of proposals) {
    const plugins = proposal.plugins
      .map((p) => `${p.packageName} ${p.version}`)
      .join(', ');
    lines.push(
      `| \`${proposal.workspace}\` | \`${proposal.oldRef}\` | \`${proposal.newRef}\` | ${plugins} |`,
    );
  }
  lines.push(
    '',
    '## Test plan',
    '- [ ] source.json repo-ref package.json versions match metadata spec.version',
    '- [ ] `/publish` exports the requested tags',
    '',
    'Generated-by: cursor',
    '',
  );
  return lines.join('\n');
}

function findCreatePrMr(): string | null {
  const candidates = [
    process.env.RHDH_PR_MR_SCRIPT || '',
    path.join(homedir(), '.claude/skills/rhdh-pr-mr/scripts/create-pr-mr.sh'),
    path.join(homedir(), '.agents/skills/rhdh-pr-mr/scripts/create-pr-mr.sh'),
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

function git(cwd: string, args: string[], check = true) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || BOT_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || BOT_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || BOT_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || BOT_EMAIL,
    },
  });
  if (check && result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result;
}

export function openOverlaysPr(
  overlaysDir: string,
  branch: string,
  proposals: Proposal[],
  issue: string,
  patchDir: string,
): string | null {
  const stamp = String(Math.floor(Date.now() / 1000));
  const head = `chore/source-json-${branch}-bump-${stamp}`;
  const work = mkdtempSync(path.join(tmpdir(), 'source-json-pr-'));
  const failPatch = (dir: string, reason: string): null => {
    logError(reason);
    const patchPath = path.join(patchDir, `source-json-${branch}-${stamp}.patch`);
    writePatch(dir, patchPath);
    logError(`Could not open PR; patch written to ${patchPath}`);
    return null;
  };
  try {
    const clone = spawnSync(
      'git',
      ['clone', '--branch', branch, overlaysDir, work],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (clone.status !== 0) {
      applyProposals(overlaysDir, proposals);
      return failPatch(overlaysDir, `git clone failed: ${(clone.stderr || '').trim()}`);
    }
    git(work, ['checkout', '-B', head]);
    applyProposals(work, proposals);
    git(work, ['add', 'workspaces']);
    const status = git(work, ['status', '--porcelain'], false);
    if (!(status.stdout || '').trim()) {
      logInfo('No source.json changes to commit');
      return null;
    }
    git(work, [
      'commit',
      '-s',
      '-m',
      `chore: bump source.json repo-ref to match catalog metadata\n\nhttps://redhat.atlassian.net/browse/${issue}\n\nGenerated-by: cursor\n`,
    ]);
    const push = git(work, ['push', '-u', 'origin', `HEAD:${head}`], false);
    if (push.status !== 0) {
      return failPatch(work, `git push failed: ${(push.stderr || '').trim()}`);
    }
    const title = 'chore: bump source.json repo-ref to match catalog metadata';
    const bodyFile = path.join(work, 'PR_BODY.md');
    writeFileSync(bodyFile, prBody(proposals, issue), 'utf8');
    let url = '';
    const opener = findCreatePrMr();
    if (opener) {
      const opened = spawnSync(
        opener,
        [
          '--cwd',
          work,
          '--base',
          branch,
          '--head',
          head,
          '--title',
          title,
          '--body-file',
          bodyFile,
          '--issue',
          issue,
          '--no-open',
        ],
        { encoding: 'utf8' },
      );
      for (const line of (opened.stdout || '').split('\n')) {
        if (line.startsWith('url:')) url = line.slice(4).trim();
      }
      if (opened.status !== 0 && !url) {
        logWarn(`create-pr-mr.sh failed: ${(opened.stderr || '').trim()}`);
      }
    }
    if (!url) {
      const created = spawnSync(
        'gh',
        [
          'pr',
          'create',
          '--repo',
          OVERLAYS_GITHUB,
          '--base',
          branch,
          '--head',
          head,
          '--title',
          `${title} [${branch}]`,
          '--body-file',
          bodyFile,
        ],
        { encoding: 'utf8', cwd: work },
      );
      const lines = (created.stdout || '').trim().split('\n').filter(Boolean);
      url = lines.at(-1) || '';
      if (created.status !== 0 && !url) {
        return failPatch(
          work,
          `gh pr create failed: ${(created.stderr || '').trim()}`,
        );
      }
    }
    if (url) {
      spawnSync('gh', ['pr', 'comment', url, '--body', '/publish'], {
        encoding: 'utf8',
      });
      spawnSync('gh', ['pr', 'merge', url, '--auto', '--squash'], {
        encoding: 'utf8',
      });
    }
    return url || null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function printReport(
  proposals: Proposal[],
  skips: string[],
  url: string | null,
): void {
  if (skips.length) {
    console.log('\n========');
    logWarn(`source.json skip: ${skips.length} workspace(s)`);
    for (const skip of skips) console.log(`  - ${skip}`);
  }
  if (!proposals.length) return;
  console.log('\n========');
  logInfo(`Stale source.json pins: ${proposals.length} workspace(s)`);
  for (const proposal of proposals) {
    const plugins = proposal.plugins
      .map((p) => `${p.packageName} ${p.version}`)
      .join(', ');
    console.log(
      `  - ${proposal.workspace}: ${proposal.oldRef} → ${proposal.newRef} (${plugins})`,
    );
  }
  if (url) logInfo(`Opened overlays PR: ${url}`);
  else logInfo('Would open an overlays PR (pass --open-prs to create it)');
}

export function parseArgs(argv: string[]): {
  overlaysDir: string;
  pluginBuildsDir: string;
  overlaysBranch: string;
  openPrs: boolean;
  issue: string;
  patchDir: string;
  json: boolean;
} {
  const args = {
    overlaysDir: '',
    pluginBuildsDir: '',
    overlaysBranch: 'main',
    openPrs: false,
    issue: process.env.JIRA_ISSUE || JIRA_ISSUE_DEFAULT,
    patchDir: '',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--overlays-dir') {
      args.overlaysDir = next;
      i += 1;
    } else if (key === '--plugin-builds-dir') {
      args.pluginBuildsDir = next;
      i += 1;
    } else if (key === '--overlays-branch') {
      args.overlaysBranch = next;
      i += 1;
    } else if (key === '--issue') {
      args.issue = next;
      i += 1;
    } else if (key === '--patch-dir') {
      args.patchDir = next;
      i += 1;
    } else if (key === '--open-prs') args.openPrs = true;
    else if (key === '--json') args.json = true;
  }
  if (!args.overlaysDir || !args.pluginBuildsDir) {
    throw new Error('--overlays-dir and --plugin-builds-dir are required');
  }
  return args;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err));
    return 0;
  }
  const overlaysDir = path.resolve(args.overlaysDir);
  const pluginBuildsDir = path.resolve(args.pluginBuildsDir);
  const patchDir = args.patchDir ? path.resolve(args.patchDir) : tmpdir();
  let proposals: Proposal[] = [];
  let skips: string[] = [];
  try {
    ({ proposals, skips } = classifyFallbacks(overlaysDir, pluginBuildsDir));
  } catch (err) {
    logError(`proposeSourceJsonUpdates failed: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
  if (args.json) {
    console.log(JSON.stringify({ proposals, skips }, null, 2));
  }
  let url: string | null = null;
  if (proposals.length && args.openPrs) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
      logError('GH_TOKEN/GITHUB_TOKEN missing; cannot open overlays PR');
      applyProposals(overlaysDir, proposals);
      const patchPath = path.join(patchDir, `source-json-${args.overlaysBranch}.patch`);
      writePatch(overlaysDir, patchPath);
      logError(`Could not open PR; patch written to ${patchPath}`);
    } else {
      try {
        url = openOverlaysPr(
          overlaysDir,
          args.overlaysBranch,
          proposals,
          args.issue,
          patchDir,
        );
      } catch (err) {
        logError(`Could not open PR: ${err instanceof Error ? err.message : err}`);
        try {
          applyProposals(overlaysDir, proposals);
          const patchPath = path.join(patchDir, `source-json-${args.overlaysBranch}.patch`);
          writePatch(overlaysDir, patchPath);
          logError(`Patch written to ${patchPath}`);
        } catch (patchErr) {
          logError(`Could not write patch: ${patchErr instanceof Error ? patchErr.message : patchErr}`);
        }
      }
    }
  }
  if (!args.json) printReport(proposals, skips, url);
  return 0;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) process.exit(main());
