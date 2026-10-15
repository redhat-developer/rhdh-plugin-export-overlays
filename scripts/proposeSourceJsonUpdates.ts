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
const TOOL_BIN_CACHE = new Map<string, string>();
const TOOL_SEARCH_DIRS = ['/usr/bin', '/usr/local/bin', '/bin'];

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

type ClassifyDeps = {
  fetchJson: FetchJson;
  npmGitHead: RunNpm;
  gitLogSha: RunGitLog;
};

type ClassifyInput = ClassifyDeps & {
  workspace: string;
  source: JsonMap;
  stale: StalePlugin[];
  packageDirs: Record<string, string>;
};

type CliArgs = {
  overlaysDir: string;
  pluginBuildsDir: string;
  overlaysBranch: string;
  openPrs: boolean;
  issue: string;
  patchDir: string;
  json: boolean;
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const match = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(repoUrl || '');
  if (!match) return null;
  return [match[1], match[2].replace(/\.git$/, '')];
}

/** Absolute path for spawnSync (Sonar typescript:S4036). */
export function resolveTool(name: string): string {
  const cached = TOOL_BIN_CACHE.get(name);
  if (cached) return cached;
  const envKey = `RHDH_${name.toUpperCase()}_BIN`;
  const candidates = [
    process.env[envKey] || '',
    ...TOOL_SEARCH_DIRS.map((dir) => path.join(dir, name)),
    path.join(path.dirname(process.execPath), name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      TOOL_BIN_CACHE.set(name, candidate);
      return candidate;
    }
  }
  throw new Error(`${name} not found; set ${envKey} to an absolute path`);
}

function runTool(
  name: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2] = {},
) {
  return spawnSync(resolveTool(name), args, { encoding: 'utf8', ...options });
}

function sourceString(source: JsonMap, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charAt(start) === '/') start += 1;
  while (end > start && value.charAt(end - 1) === '/') end -= 1;
  return value.slice(start, end);
}

function yamlScalar(text: string, key: string): string | null {
  const prefix = `${key}:`;
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(prefix)) continue;
    let value = trimmed.slice(prefix.length).trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    const token = value.split(' ')[0] || '';
    return token || null;
  }
  return null;
}

function readJsonMap(file: string): JsonMap | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data as JsonMap;
  } catch {
    return null;
  }
}

function jsonMapsInDir(dir: string): JsonMap[] {
  if (!existsSync(dir)) return [];
  const maps: JsonMap[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const data = readJsonMap(path.join(dir, file));
    if (data) maps.push(data);
  }
  return maps;
}

function asPluginMap(value: unknown): JsonMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonMap;
}

export function packageDirInSource(
  workspace: string,
  workspacePath: string,
  repoFlat: boolean,
): string {
  let rel = trimSlashes(workspacePath);
  if (rel.startsWith(`${workspace}/`)) rel = rel.slice(workspace.length + 1);
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
  return readJsonMap(file);
}

function loadMetadataPlugins(overlaysDir: string, workspace: string): PluginMeta[] {
  const metaDir = path.join(overlaysDir, 'workspaces', workspace, 'metadata');
  if (!existsSync(metaDir)) return [];
  const plugins: PluginMeta[] = [];
  for (const name of readdirSync(metaDir).sort()) {
    if (!name.endsWith('.yaml')) continue;
    const text = readFileSync(path.join(metaDir, name), 'utf8');
    const pkg = yamlScalar(text, 'packageName');
    const ver = yamlScalar(text, 'version');
    if (pkg && ver) plugins.push({ packageName: pkg, version: ver });
  }
  return plugins;
}

function fallbackFromPlugin(
  workspace: string,
  pluginName: string,
  plugin: JsonMap,
): FallbackEntry | null {
  if (!plugin.fallback) return null;
  const ref = typeof plugin.registryReference === 'string' ? plugin.registryReference : '';
  const colon = ref.lastIndexOf(':');
  return {
    container: pluginName,
    haveTag: colon >= 0 ? ref.slice(colon + 1) : '',
    requestedTag: typeof plugin.requestedTag === 'string' ? plugin.requestedTag : '',
    workspace,
  };
}

export function collectFallbackEntries(pluginBuildsDir: string): FallbackEntry[] {
  const fallbacks: FallbackEntry[] = [];
  if (!existsSync(pluginBuildsDir)) return fallbacks;
  for (const workspace of readdirSync(pluginBuildsDir).sort()) {
    for (const data of jsonMapsInDir(path.join(pluginBuildsDir, workspace))) {
      for (const [pluginName, pluginData] of Object.entries(data)) {
        const plugin = asPluginMap(pluginData);
        const entry = plugin ? fallbackFromPlugin(workspace, pluginName, plugin) : null;
        if (entry) fallbacks.push(entry);
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
  for (const data of jsonMapsInDir(path.join(pluginBuildsDir, workspace))) {
    for (const [name, pluginData] of Object.entries(data)) {
      const plugin = asPluginMap(pluginData);
      const wp = plugin?.workspacePath;
      if (typeof wp === 'string') paths[name] = wp;
    }
  }
  return paths;
}

export function defaultFetchJson(url: string): JsonMap | null {
  try {
    const result = runTool('curl', ['-fsSL', '--max-time', '20', url]);
    if (result.status !== 0) return null;
    return JSON.parse(result.stdout) as JsonMap;
  } catch {
    return null;
  }
}

export function defaultNpmGitHead(packageName: string, version: string): string | null {
  const result = runTool(
    'npm',
    ['view', `${packageName}@${version}`, 'gitHead', '--json'],
    { timeout: 30_000 },
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
    const clone = runTool(
      'git',
      ['clone', '--filter=blob:none', '--no-checkout', repoUrl, tmp],
      { timeout: 120_000 },
    );
    if (clone.status !== 0) return null;
    const log = runTool(
      'git',
      ['-C', tmp, 'log', '-1', '--format=%H', '-S', needle, '--', pathName],
      { timeout: 60_000 },
    );
    const sha = (log.stdout || '').trim();
    return SHA_RE.test(sha) ? sha : null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function fetchGithubFileJson(
  repoUrl: string,
  repoRef: string,
  relPath: string,
  fetchJson: FetchJson,
): string | null {
  const ownerRepo = githubOwnerRepo(repoUrl);
  if (!ownerRepo) return null;
  const [owner, repo] = ownerRepo;
  const encodedRef = repoRef.replaceAll('/', '%2F');
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodedRef}/${relPath}`;
  const data = fetchJson(url);
  const version = data && typeof data.version === 'string' ? data.version.trim() : '';
  return version || null;
}

function fetchPackageVersionAtRef(
  repoUrl: string,
  repoRef: string,
  packageDir: string,
  fetchJson: FetchJson,
): string | null {
  return fetchGithubFileJson(repoUrl, repoRef, `${packageDir}/package.json`, fetchJson);
}

function fetchBackstageVersionAtRef(
  repoUrl: string,
  repoRef: string,
  workspace: string,
  repoFlat: boolean,
  fetchJson: FetchJson,
): string | null {
  const rel = repoFlat ? 'backstage.json' : `workspaces/${workspace}/backstage.json`;
  return fetchGithubFileJson(repoUrl, repoRef, rel, fetchJson);
}

function firstNpmHead(plugins: PluginMeta[], npmGitHead: RunNpm): string | null {
  for (const plugin of plugins) {
    const head = npmGitHead(plugin.packageName, plugin.version);
    if (head) return head;
  }
  return null;
}

function firstGitHead(
  plugins: PluginMeta[],
  repoUrl: string,
  packageDirs: Record<string, string>,
  gitLogSha: RunGitLog,
): string | null {
  for (const plugin of plugins) {
    const pkgDir = packageDirs[plugin.packageName] || '';
    if (!pkgDir) continue;
    const sha = gitLogSha(repoUrl, `"version": "${plugin.version}"`, `${pkgDir}/package.json`);
    if (sha) return sha;
  }
  return null;
}

function refHasRequestedVersions(
  repoUrl: string,
  candidate: string,
  plugins: PluginMeta[],
  packageDirs: Record<string, string>,
  fetchJson: FetchJson,
): boolean {
  for (const plugin of plugins) {
    const pkgDir = packageDirs[plugin.packageName] || '';
    if (!pkgDir) continue;
    const found = fetchPackageVersionAtRef(repoUrl, candidate, pkgDir, fetchJson);
    if (found !== plugin.version) {
      logError(
        `Ref ${candidate} has ${plugin.packageName}@${found || 'missing'}, need ${plugin.version}; skip workspace`,
      );
      return false;
    }
  }
  return true;
}

function resolveNewRepoRef(
  source: JsonMap,
  plugins: PluginMeta[],
  deps: ClassifyDeps,
  packageDirs: Record<string, string>,
): string | null {
  const repoRef = sourceString(source, 'repo-ref');
  const repoUrl = sourceString(source, 'repo');
  if (isPackageTag(repoRef) && plugins.length === 1) {
    return `${plugins[0].packageName}@${plugins[0].version}`;
  }
  const candidate =
    firstNpmHead(plugins, deps.npmGitHead) ||
    firstGitHead(plugins, repoUrl, packageDirs, deps.gitLogSha);
  if (!candidate) return null;
  if (!refHasRequestedVersions(repoUrl, candidate, plugins, packageDirs, deps.fetchJson)) {
    return null;
  }
  return candidate;
}

function pinStalePlugins(
  stale: StalePlugin[],
  repoUrl: string,
  repoRef: string,
  packageDirs: Record<string, string>,
  fetchJson: FetchJson,
): string {
  let fallback = '';
  for (const plugin of stale) {
    const pkgDir = packageDirs[plugin.packageName] || '';
    if (!pkgDir) continue;
    const pinned = fetchPackageVersionAtRef(repoUrl, repoRef, pkgDir, fetchJson);
    if (pinned) {
      plugin.pinned = pinned;
      fallback = fallback || pinned;
    }
  }
  return fallback;
}

function bumpNeeded(workspace: string, stale: StalePlugin[], fallbackPin: string): string | true {
  let needsBump = false;
  for (const plugin of stale) {
    const pinned = plugin.pinned || fallbackPin;
    if (!pinned) {
      needsBump = true;
      continue;
    }
    if (versionNewer(plugin.version, pinned)) {
      needsBump = true;
      continue;
    }
    if (pinned === plugin.version) continue;
    return `${workspace}: pinned ${plugin.packageName}@${pinned} is not older than requested ${plugin.version}`;
  }
  if (!needsBump) return `${workspace}: image-lag (source.json already at requested version)`;
  return true;
}

function finishClassify(input: ClassifyInput): Proposal | string {
  const { workspace, source, stale, packageDirs } = input;
  const repoUrl = sourceString(source, 'repo');
  const repoRef = sourceString(source, 'repo-ref');
  const repoFlat = Boolean(source['repo-flat']);
  const fallbackPin = pinStalePlugins(
    stale,
    repoUrl,
    repoRef,
    packageDirs,
    input.fetchJson,
  );
  const bump = bumpNeeded(workspace, stale, fallbackPin);
  if (bump !== true) return bump;
  const requested = stale.map((p) => ({
    packageName: p.packageName,
    version: p.version,
  }));
  const newRef = resolveNewRepoRef(source, requested, input, packageDirs);
  if (!newRef) return `${workspace}: could not resolve a repo-ref for ${JSON.stringify(requested)}`;
  if (newRef === repoRef) return `${workspace}: image-lag (resolved ref matches current pin)`;
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
      input.fetchJson,
    ),
  };
}

function metaForFallback(
  entry: FallbackEntry,
  metadata: PluginMeta[],
  metaByContainer: Map<string, PluginMeta>,
): PluginMeta | undefined {
  const wantVer = pluginVersionFromTag(entry.requestedTag);
  let meta = metaByContainer.get(entry.container);
  meta ??= metadata.find((p) => p.version === wantVer);
  meta ??= metadata.length === 1 ? metadata[0] : undefined;
  return meta;
}

function staleForWorkspace(
  workspace: string,
  entries: FallbackEntry[],
  overlaysDir: string,
  pluginBuildsDir: string,
  repoFlat: boolean,
  skips: string[],
): { stale: StalePlugin[]; packageDirs: Record<string, string> } {
  const paths = pluginBuildsWorkspacePaths(pluginBuildsDir, workspace);
  const metadata = loadMetadataPlugins(overlaysDir, workspace);
  const metaByContainer = new Map<string, PluginMeta>();
  for (const plugin of metadata) {
    const slug = plugin.packageName.replace(/^@/, '').replaceAll('/', '-');
    metaByContainer.set(slug, plugin);
  }
  const stale: StalePlugin[] = [];
  const packageDirs: Record<string, string> = {};
  for (const entry of entries) {
    const meta = metaForFallback(entry, metadata, metaByContainer);
    if (!meta) {
      skips.push(`${workspace}/${entry.container}: no metadata`);
      continue;
    }
    const wsPath = paths[entry.container] || '';
    const pkgDir = wsPath ? packageDirInSource(workspace, wsPath, repoFlat) : '';
    const wantVer = pluginVersionFromTag(entry.requestedTag);
    stale.push({
      packageName: meta.packageName,
      version: wantVer || meta.version,
      container: entry.container,
    });
    if (pkgDir) packageDirs[meta.packageName] = pkgDir;
  }
  return { stale, packageDirs };
}

export function classifyFallbacks(
  overlaysDir: string,
  pluginBuildsDir: string,
  deps: Partial<ClassifyDeps> = {},
): { proposals: Proposal[]; skips: string[] } {
  const resolved: ClassifyDeps = {
    fetchJson: deps.fetchJson ?? defaultFetchJson,
    npmGitHead: deps.npmGitHead ?? defaultNpmGitHead,
    gitLogSha: deps.gitLogSha ?? defaultGitLogSha,
  };
  const byWs = new Map<string, FallbackEntry[]>();
  for (const entry of collectFallbackEntries(pluginBuildsDir)) {
    const list = byWs.get(entry.workspace) ?? [];
    list.push(entry);
    byWs.set(entry.workspace, list);
  }
  const proposals: Proposal[] = [];
  const skips: string[] = [];
  for (const workspace of [...byWs.keys()].sort((a, b) => a.localeCompare(b))) {
    const source = loadSourceJson(overlaysDir, workspace);
    if (!source) {
      skips.push(`${workspace}: missing source.json`);
      continue;
    }
    const { stale, packageDirs } = staleForWorkspace(
      workspace,
      byWs.get(workspace) ?? [],
      overlaysDir,
      pluginBuildsDir,
      Boolean(source['repo-flat']),
      skips,
    );
    if (!stale.length) continue;
    const finished = finishClassify({
      workspace,
      source,
      stale,
      packageDirs,
      ...resolved,
    });
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
  const result = runTool('git', ['-C', overlaysDir, 'diff', '--', 'workspaces']);
  mkdirSync(path.dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, result.stdout || '', 'utf8');
}

function writeFailPatch(overlaysDir: string, patchPath: string, reason: string): null {
  logError(reason);
  writePatch(overlaysDir, patchPath);
  logError(`Could not open PR; patch written to ${patchPath}`);
  return null;
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
  const result = runTool('git', ['-C', cwd, ...args], {
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

function urlFromOpener(work: string, branch: string, head: string, title: string, bodyFile: string, issue: string): string {
  const opener = findCreatePrMr();
  if (!opener) return '';
  const opened = spawnSync(
    opener,
    [
      '--cwd', work, '--base', branch, '--head', head, '--title', title,
      '--body-file', bodyFile, '--issue', issue, '--no-open',
    ],
    { encoding: 'utf8' },
  );
  let url = '';
  for (const line of (opened.stdout || '').split('\n')) {
    if (line.startsWith('url:')) url = line.slice(4).trim();
  }
  if (opened.status !== 0 && !url) {
    logWarn(`create-pr-mr.sh failed: ${(opened.stderr || '').trim()}`);
  }
  return url;
}

function urlFromGh(work: string, branch: string, head: string, title: string, bodyFile: string): string {
  const created = runTool(
    'gh',
    [
      'pr', 'create', '--repo', OVERLAYS_GITHUB, '--base', branch, '--head', head,
      '--title', `${title} [${branch}]`, '--body-file', bodyFile,
    ],
    { cwd: work },
  );
  const lines = (created.stdout || '').trim().split('\n').filter(Boolean);
  return lines.at(-1) || '';
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
  const patchPath = (dir: string) => path.join(patchDir, `source-json-${branch}-${stamp}.patch`);
  try {
    const clone = runTool(
      'git',
      ['clone', '--branch', branch, overlaysDir, work],
      { timeout: 120_000 },
    );
    if (clone.status !== 0) {
      applyProposals(overlaysDir, proposals);
      return writeFailPatch(overlaysDir, patchPath(overlaysDir), `git clone failed: ${(clone.stderr || '').trim()}`);
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
      return writeFailPatch(work, patchPath(work), `git push failed: ${(push.stderr || '').trim()}`);
    }
    const title = 'chore: bump source.json repo-ref to match catalog metadata';
    const bodyFile = path.join(work, 'PR_BODY.md');
    writeFileSync(bodyFile, prBody(proposals, issue), 'utf8');
    const url = urlFromOpener(work, branch, head, title, bodyFile, issue)
      || urlFromGh(work, branch, head, title, bodyFile);
    if (!url) {
      return writeFailPatch(work, patchPath(work), 'gh pr create failed');
    }
    runTool('gh', ['pr', 'comment', url, '--body', '/publish']);
    runTool('gh', ['pr', 'merge', url, '--auto', '--squash']);
    return url;
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

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    overlaysDir: '',
    pluginBuildsDir: '',
    overlaysBranch: 'main',
    openPrs: false,
    issue: process.env.JIRA_ISSUE || JIRA_ISSUE_DEFAULT,
    patchDir: '',
    json: false,
  };
  const take = new Map<string, (value: string) => void>([
    ['--overlays-dir', (v) => { args.overlaysDir = v; }],
    ['--plugin-builds-dir', (v) => { args.pluginBuildsDir = v; }],
    ['--overlays-branch', (v) => { args.overlaysBranch = v; }],
    ['--issue', (v) => { args.issue = v; }],
    ['--patch-dir', (v) => { args.patchDir = v; }],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const setter = take.get(key);
    if (setter) {
      setter(argv[i + 1]);
      i += 1;
    } else if (key === '--open-prs') args.openPrs = true;
    else if (key === '--json') args.json = true;
  }
  if (!args.overlaysDir || !args.pluginBuildsDir) {
    throw new Error('--overlays-dir and --plugin-builds-dir are required');
  }
  return args;
}

function patchProposals(overlaysDir: string, proposals: Proposal[], patchPath: string, reason: string): void {
  logError(reason);
  applyProposals(overlaysDir, proposals);
  writePatch(overlaysDir, patchPath);
  logError(`Could not open PR; patch written to ${patchPath}`);
}

function maybeOpenPrs(
  args: CliArgs,
  overlaysDir: string,
  pluginBuildsDir: string,
  patchDir: string,
): { proposals: Proposal[]; skips: string[]; url: string | null } {
  const { proposals, skips } = classifyFallbacks(overlaysDir, pluginBuildsDir);
  let url: string | null = null;
  if (!(proposals.length && args.openPrs)) return { proposals, skips, url };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const patchPath = path.join(patchDir, `source-json-${args.overlaysBranch}.patch`);
  if (!token) {
    patchProposals(overlaysDir, proposals, patchPath, 'GH_TOKEN/GITHUB_TOKEN missing; cannot open overlays PR');
    return { proposals, skips, url };
  }
  try {
    url = openOverlaysPr(overlaysDir, args.overlaysBranch, proposals, args.issue, patchDir);
  } catch (err) {
    try {
      patchProposals(overlaysDir, proposals, patchPath, `Could not open PR: ${errText(err)}`);
    } catch (patchErr) {
      logError(`Could not write patch: ${errText(patchErr)}`);
    }
  }
  return { proposals, skips, url };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    logError(errText(err));
    return 1;
  }
  const overlaysDir = path.resolve(args.overlaysDir);
  const pluginBuildsDir = path.resolve(args.pluginBuildsDir);
  const patchDir = args.patchDir ? path.resolve(args.patchDir) : tmpdir();
  try {
    const { proposals, skips, url } = maybeOpenPrs(args, overlaysDir, pluginBuildsDir, patchDir);
    if (args.json) console.log(JSON.stringify({ proposals, skips }, null, 2));
    else printReport(proposals, skips, url);
    return 0;
  } catch (err) {
    logError(`proposeSourceJsonUpdates failed: ${errText(err)}`);
    return 0;
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) process.exit(main());
