import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import {
  applyProposals,
  classifyFallbacks,
  main,
  packageDirInSource,
  pluginVersionFromTag,
  resolveTool,
  type FetchJson,
  type Proposal,
  type RunGitLog,
  type RunNpm,
} from '../proposeSourceJsonUpdates.ts';

const OLD_SHA = 'e4ca4f128d1aaa550bd0e4e8d041188f2ed5f52b';
const NEW_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const ROADIE_WS = 'roadie-backstage-plugins';
const ROADIE_PKG = '@roadiehq/scaffolder-backend-module-http-request';
const ROADIE_CONTAINER = 'roadiehq-scaffolder-backend-module-http-request';

function writeWorkspace(
  overlays: string,
  opts: {
    workspace: string;
    repoRef: string;
    repoFlat: boolean;
    packageName: string;
    version: string;
    repo?: string;
  },
): void {
  const ws = path.join(overlays, 'workspaces', opts.workspace);
  mkdirSync(path.join(ws, 'metadata'), { recursive: true });
  writeFileSync(
    path.join(ws, 'source.json'),
    `${JSON.stringify({
      repo: opts.repo ?? 'https://github.com/RoadieHQ/roadie-backstage-plugins',
      'repo-ref': opts.repoRef,
      'repo-flat': opts.repoFlat,
      'repo-backstage-version': '1.55.2',
    })}\n`,
  );
  const slug = opts.packageName.replace(/^@/, '').replaceAll('/', '-');
  writeFileSync(
    path.join(ws, 'metadata', `${slug}.yaml`),
    `spec:\n  packageName: ${opts.packageName}\n  version: ${opts.version}\n`,
  );
}

function writeFallback(
  builds: string,
  opts: {
    workspace: string;
    container: string;
    have: string;
    want: string;
    workspacePath: string;
  },
): void {
  const ws = path.join(builds, opts.workspace);
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    path.join(ws, `${opts.container}.json`),
    JSON.stringify({
      [opts.container]: {
        workspacePath: opts.workspacePath,
        registryReference: `quay.io/rhdh/${opts.container}:${opts.have}`,
        fallback: true,
        requestedTag: opts.want,
      },
    }),
  );
}

function fetchFactory(versionsByUrlSubstr: Record<string, string>): FetchJson {
  return (url: string) => {
    for (const [needle, version] of Object.entries(versionsByUrlSubstr)) {
      if (url.includes(needle)) {
        if (url.endsWith('backstage.json')) return { version: '1.55.2' };
        return { version };
      }
    }
    return null;
  };
}

function classifyRoadie(opts: {
  repoRef: string;
  pluginPath: string;
  versions: Record<string, string>;
  npmGitHead: RunNpm;
  gitLogSha?: RunGitLog;
}): ReturnType<typeof classifyFallbacks> {
  const root = mkdtempSync(path.join(tmpdir(), 'source-json-'));
  const overlays = path.join(root, 'overlay-repo');
  const builds = path.join(root, 'plugin_builds');
  writeWorkspace(overlays, {
    workspace: ROADIE_WS,
    repoRef: opts.repoRef,
    repoFlat: true,
    packageName: ROADIE_PKG,
    version: '5.9.0',
  });
  writeFallback(builds, {
    workspace: ROADIE_WS,
    container: ROADIE_CONTAINER,
    have: '2.1.0--5.8.0',
    want: '2.1.0--5.9.0',
    workspacePath: `${ROADIE_WS}/plugins/${opts.pluginPath}`,
  });
  return classifyFallbacks(overlays, builds, {
    fetchJson: fetchFactory(opts.versions),
    npmGitHead: opts.npmGitHead,
    gitLogSha: opts.gitLogSha ?? (() => null),
  });
}

describe('proposeSourceJsonUpdates', () => {
  it('resolves git and curl to absolute paths', () => {
    expect(resolveTool('git')).toMatch(/^\/.+/);
    expect(resolveTool('curl')).toMatch(/^\/.+/);
  });

  it('parses plugin versions from Quay and GHCR tags', () => {
    expect(pluginVersionFromTag('2.1.0--5.9.0')).toBe('5.9.0');
    expect(pluginVersionFromTag('bs_1.54.9__5.8.0')).toBe('5.8.0');
    expect(pluginVersionFromTag('')).toBeNull();
  });

  it('maps workspacePath to source package dirs', () => {
    expect(
      packageDirInSource(
        ROADIE_WS,
        `${ROADIE_WS}/plugins/http-request`,
        true,
      ),
    ).toBe('plugins/http-request');
    expect(packageDirInSource('topology', 'topology/plugins/topology', false)).toBe(
      'workspaces/topology/plugins/topology',
    );
  });

  it('classifies a SHA workspace as a stale pin', () => {
    const { proposals, skips } = classifyRoadie({
      repoRef: OLD_SHA,
      pluginPath: 'scaffolder-actions/scaffolder-backend-module-http-request',
      versions: {
        [`${OLD_SHA}/plugins/`]: '5.8.0',
        [`${NEW_SHA}/plugins/`]: '5.9.0',
      },
      npmGitHead: (name, version) => {
        expect(name).toBe(ROADIE_PKG);
        expect(version).toBe('5.9.0');
        return NEW_SHA;
      },
    });
    expect(skips).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      workspace: ROADIE_WS,
      oldRef: OLD_SHA,
      newRef: NEW_SHA,
      reason: 'stale-pin',
    });
  });

  it('skips image-lag when the pin already matches the requested version', () => {
    const { proposals, skips } = classifyRoadie({
      repoRef: NEW_SHA,
      pluginPath: 'http-request',
      versions: { [`${NEW_SHA}/plugins/`]: '5.9.0' },
      npmGitHead: () => NEW_SHA,
    });
    expect(proposals).toEqual([]);
    expect(skips.some((s) => s.includes('image-lag'))).toBe(true);
  });

  it('rewrites a package-tag repo-ref', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'source-json-'));
    const overlays = path.join(root, 'overlay-repo');
    const builds = path.join(root, 'plugin_builds');
    const pkg = '@backstage-community/plugin-topology';
    writeWorkspace(overlays, {
      workspace: 'topology',
      repoRef: `${pkg}@1.5.4`,
      repoFlat: false,
      packageName: pkg,
      version: '1.6.0',
      repo: 'https://github.com/backstage/community-plugins',
    });
    writeFallback(builds, {
      workspace: 'topology',
      container: 'backstage-community-plugin-topology',
      have: '2.1.0--1.5.4',
      want: '2.1.0--1.6.0',
      workspacePath: 'topology/plugins/topology',
    });
    const { proposals, skips } = classifyFallbacks(overlays, builds, {
      fetchJson: fetchFactory({
        '@backstage-community/plugin-topology@1.5.4': '1.5.4',
        '@backstage-community/plugin-topology@1.6.0': '1.6.0',
      }),
      npmGitHead: () => null,
      gitLogSha: () => null,
    });
    expect(skips).toEqual([]);
    expect(proposals[0].newRef).toBe(`${pkg}@1.6.0`);
  });

  it('skips when a new ref cannot be resolved', () => {
    const { proposals, skips } = classifyRoadie({
      repoRef: OLD_SHA,
      pluginPath: 'http-request',
      versions: { [`${OLD_SHA}/plugins/`]: '5.8.0' },
      npmGitHead: () => null,
    });
    expect(proposals).toEqual([]);
    expect(skips.some((s) => s.includes('could not resolve'))).toBe(true);
  });

  it('applies repo-ref updates to source.json', () => {
    const overlays = mkdtempSync(path.join(tmpdir(), 'source-json-'));
    writeWorkspace(overlays, {
      workspace: ROADIE_WS,
      repoRef: OLD_SHA,
      repoFlat: true,
      packageName: '@roadiehq/http-request',
      version: '5.9.0',
    });
    const proposal: Proposal = {
      workspace: ROADIE_WS,
      oldRef: OLD_SHA,
      newRef: NEW_SHA,
      plugins: [{ packageName: '@roadiehq/http-request', version: '5.9.0' }],
      reason: 'stale-pin',
      newBackstage: '1.55.2',
    };
    applyProposals(overlays, [proposal]);
    const data = JSON.parse(
      readFileSync(path.join(overlays, 'workspaces', ROADIE_WS, 'source.json'), 'utf8'),
    );
    expect(data['repo-ref']).toBe(NEW_SHA);
    expect(data['repo-backstage-version']).toBe('1.55.2');
  });

  it('CLI --json with empty trees exits 0', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'source-json-'));
    mkdirSync(path.join(root, 'overlay-repo'));
    mkdirSync(path.join(root, 'plugin_builds'));
    const rc = main([
      '--overlays-dir',
      path.join(root, 'overlay-repo'),
      '--plugin-builds-dir',
      path.join(root, 'plugin_builds'),
      '--json',
    ]);
    expect(rc).toBe(0);
  });
});
