import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  applyProposals,
  classifyFallbacks,
  main,
  packageDirInSource,
  pluginVersionFromTag,
  resolveTool,
  type FetchJson,
  type Proposal,
} from '../proposeSourceJsonUpdates.ts';

const OLD_SHA = 'e4ca4f128d1aaa550bd0e4e8d041188f2ed5f52b';
const NEW_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

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

describe('proposeSourceJsonUpdates', () => {
  it('resolves git and curl to absolute paths', () => {
    assert.match(resolveTool('git'), /^\/.+/);
    assert.match(resolveTool('curl'), /^\/.+/);
  });

  it('parses plugin versions from Quay and GHCR tags', () => {
    assert.equal(pluginVersionFromTag('2.1.0--5.9.0'), '5.9.0');
    assert.equal(pluginVersionFromTag('bs_1.54.9__5.8.0'), '5.8.0');
    assert.equal(pluginVersionFromTag(''), null);
  });

  it('maps workspacePath to source package dirs', () => {
    assert.equal(
      packageDirInSource(
        'roadie-backstage-plugins',
        'roadie-backstage-plugins/plugins/http-request',
        true,
      ),
      'plugins/http-request',
    );
    assert.equal(
      packageDirInSource('topology', 'topology/plugins/topology', false),
      'workspaces/topology/plugins/topology',
    );
  });

  it('classifies a SHA workspace as a stale pin', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'source-json-'));
    const overlays = path.join(root, 'overlay-repo');
    const builds = path.join(root, 'plugin_builds');
    const ws = 'roadie-backstage-plugins';
    const pkg = '@roadiehq/scaffolder-backend-module-http-request';
    const container = 'roadiehq-scaffolder-backend-module-http-request';
    writeWorkspace(overlays, {
      workspace: ws,
      repoRef: OLD_SHA,
      repoFlat: true,
      packageName: pkg,
      version: '5.9.0',
    });
    writeFallback(builds, {
      workspace: ws,
      container,
      have: '2.1.0--5.8.0',
      want: '2.1.0--5.9.0',
      workspacePath: `${ws}/plugins/scaffolder-actions/scaffolder-backend-module-http-request`,
    });
    const { proposals, skips } = classifyFallbacks(overlays, builds, {
      fetchJson: fetchFactory({
        [`${OLD_SHA}/plugins/`]: '5.8.0',
        [`${NEW_SHA}/plugins/`]: '5.9.0',
      }),
      npmGitHead: (name, version) => {
        assert.equal(name, pkg);
        assert.equal(version, '5.9.0');
        return NEW_SHA;
      },
      gitLogSha: () => null,
    });
    assert.deepEqual(skips, []);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].workspace, ws);
    assert.equal(proposals[0].oldRef, OLD_SHA);
    assert.equal(proposals[0].newRef, NEW_SHA);
    assert.equal(proposals[0].reason, 'stale-pin');
  });

  it('skips image-lag when the pin already matches the requested version', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'source-json-'));
    const overlays = path.join(root, 'overlay-repo');
    const builds = path.join(root, 'plugin_builds');
    const ws = 'roadie-backstage-plugins';
    const pkg = '@roadiehq/scaffolder-backend-module-http-request';
    const container = 'roadiehq-scaffolder-backend-module-http-request';
    writeWorkspace(overlays, {
      workspace: ws,
      repoRef: NEW_SHA,
      repoFlat: true,
      packageName: pkg,
      version: '5.9.0',
    });
    writeFallback(builds, {
      workspace: ws,
      container,
      have: '2.1.0--5.8.0',
      want: '2.1.0--5.9.0',
      workspacePath: `${ws}/plugins/http-request`,
    });
    const { proposals, skips } = classifyFallbacks(overlays, builds, {
      fetchJson: fetchFactory({ [`${NEW_SHA}/plugins/`]: '5.9.0' }),
      npmGitHead: () => NEW_SHA,
      gitLogSha: () => null,
    });
    assert.deepEqual(proposals, []);
    assert.ok(skips.some((s) => s.includes('image-lag')));
  });

  it('rewrites a package-tag repo-ref', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'source-json-'));
    const overlays = path.join(root, 'overlay-repo');
    const builds = path.join(root, 'plugin_builds');
    const ws = 'topology';
    const pkg = '@backstage-community/plugin-topology';
    const container = 'backstage-community-plugin-topology';
    writeWorkspace(overlays, {
      workspace: ws,
      repoRef: `${pkg}@1.5.4`,
      repoFlat: false,
      packageName: pkg,
      version: '1.6.0',
      repo: 'https://github.com/backstage/community-plugins',
    });
    writeFallback(builds, {
      workspace: ws,
      container,
      have: '2.1.0--1.5.4',
      want: '2.1.0--1.6.0',
      workspacePath: `${ws}/plugins/topology`,
    });
    const { proposals, skips } = classifyFallbacks(overlays, builds, {
      fetchJson: fetchFactory({
        '@backstage-community/plugin-topology@1.5.4': '1.5.4',
        '@backstage-community/plugin-topology@1.6.0': '1.6.0',
      }),
      npmGitHead: () => null,
      gitLogSha: () => null,
    });
    assert.deepEqual(skips, []);
    assert.equal(proposals[0].newRef, `${pkg}@1.6.0`);
  });

  it('skips when a new ref cannot be resolved', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'source-json-'));
    const overlays = path.join(root, 'overlay-repo');
    const builds = path.join(root, 'plugin_builds');
    const ws = 'roadie-backstage-plugins';
    const pkg = '@roadiehq/scaffolder-backend-module-http-request';
    const container = 'roadiehq-scaffolder-backend-module-http-request';
    writeWorkspace(overlays, {
      workspace: ws,
      repoRef: OLD_SHA,
      repoFlat: true,
      packageName: pkg,
      version: '5.9.0',
    });
    writeFallback(builds, {
      workspace: ws,
      container,
      have: '2.1.0--5.8.0',
      want: '2.1.0--5.9.0',
      workspacePath: `${ws}/plugins/http-request`,
    });
    const { proposals, skips } = classifyFallbacks(overlays, builds, {
      fetchJson: fetchFactory({ [`${OLD_SHA}/plugins/`]: '5.8.0' }),
      npmGitHead: () => null,
      gitLogSha: () => null,
    });
    assert.deepEqual(proposals, []);
    assert.ok(skips.some((s) => s.includes('could not resolve')));
  });

  it('applies repo-ref updates to source.json', () => {
    const overlays = mkdtempSync(path.join(tmpdir(), 'source-json-'));
    const ws = 'roadie-backstage-plugins';
    writeWorkspace(overlays, {
      workspace: ws,
      repoRef: OLD_SHA,
      repoFlat: true,
      packageName: '@roadiehq/http-request',
      version: '5.9.0',
    });
    const proposal: Proposal = {
      workspace: ws,
      oldRef: OLD_SHA,
      newRef: NEW_SHA,
      plugins: [{ packageName: '@roadiehq/http-request', version: '5.9.0' }],
      reason: 'stale-pin',
      newBackstage: '1.55.2',
    };
    applyProposals(overlays, [proposal]);
    const data = JSON.parse(
      readFileSync(path.join(overlays, 'workspaces', ws, 'source.json'), 'utf8'),
    );
    assert.equal(data['repo-ref'], NEW_SHA);
    assert.equal(data['repo-backstage-version'], '1.55.2');
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
    assert.equal(rc, 0);
  });
});
