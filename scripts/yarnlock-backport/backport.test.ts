import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

import {
  buildManifestRows,
  canonicalBaseDir,
  canonicalRepoFromUrl,
  collectInstallationPaths,
  formatManifestDocument,
  formatInstallationPathNotes,
  formatNpmLsSpine,
  formatPatchVersions,
  mergeManifestNotes,
  normalizeCveId,
  parseCveArg,
  parseCveCliToken,
  parseCveDetails,
  parsePatchVersions,
  pathUnderBase,
  releaseBranch,
  requireLockfileChange,
  resolveGitRemote,
  resolvePackageInLock,
  semverInAnyAffected,
  stripAutoNotes,
  versionsInLock,
  vulnerabilityNoteForRow,
  vulnerablePatchVersions,
} from './backport.ts';

describe('pathUnderBase', () => {
  it('allows paths inside the canonical base directory', () => {
    const base = canonicalBaseDir(tmpdir(), 'tmpdir');
    assert.doesNotThrow(() => pathUnderBase(base, 'yarnlock-backport-test'));
  });

  it('rejects path traversal outside the base directory', () => {
    const base = canonicalBaseDir(tmpdir(), 'tmpdir');
    assert.throws(() => pathUnderBase(base, '..', 'outside'), /Access denied/);
  });

  it('rejects relative CLI roots', () => {
    assert.throws(
      () => canonicalBaseDir('workspaces/orchestrator', 'overlay-workspace'),
      /absolute path/,
    );
  });
});

describe('requireLockfileChange', () => {
  it('accepts when baseline and patched differ', () => {
    assert.doesNotThrow(() => requireLockfileChange('a', 'b'));
  });

  it('rejects when lockfile is unchanged from repo-ref', () => {
    assert.throws(
      () => requireLockfileChange('same', 'same'),
      /yarn.lock unchanged from repo-ref baseline/,
    );
  });
});

describe('resolveGitRemote', () => {
  it('prefers upstream on fork clones', () => {
    const remotes = `origin\tgit@github.com:JessicaJHee/rhdh-plugin-export-overlays.git (fetch)
upstream\thttps://github.com/redhat-developer/rhdh-plugin-export-overlays.git (fetch)`;
    assert.equal(
      resolveGitRemote(
        remotes,
        'git@github.com:JessicaJHee/rhdh-plugin-export-overlays.git',
        'redhat-developer/rhdh-plugin-export-overlays',
      ),
      'upstream',
    );
  });

  it('uses origin for direct upstream clones', () => {
    const remotes = `origin\thttps://github.com/backstage/community-plugins.git (fetch)`;
    assert.equal(
      resolveGitRemote(
        remotes,
        'https://github.com/backstage/community-plugins.git',
        'backstage/community-plugins',
      ),
      'origin',
    );
  });

  it('errors when fork has no upstream remote', () => {
    const remotes = `origin\tgit@github.com:JessicaJHee/rhdh-plugins.git (fetch)`;
    assert.throws(
      () =>
        resolveGitRemote(
          remotes,
          'git@github.com:JessicaJHee/rhdh-plugins.git',
          'redhat-developer/rhdh-plugins',
        ),
      /no upstream remote/,
    );
  });

  it('ignores upstream remote that does not match the canonical repo', () => {
    const remotes = `origin\tgit@github.com:me/rhdh-plugins.git (fetch)
upstream\thttps://github.com/unrelated/other.git (fetch)`;
    assert.throws(
      () =>
        resolveGitRemote(remotes, 'git@github.com:me/rhdh-plugins.git', 'redhat-developer/rhdh-plugins'),
      /no upstream remote/,
    );
  });
});

describe('canonicalRepoFromUrl', () => {
  it('parses github HTTPS repo URLs', () => {
    assert.equal(
      canonicalRepoFromUrl('https://github.com/redhat-developer/rhdh-plugins'),
      'redhat-developer/rhdh-plugins',
    );
    assert.equal(
      canonicalRepoFromUrl('https://github.com/backstage/community-plugins.git'),
      'backstage/community-plugins',
    );
  });

  it('parses github tree URLs and SSH remotes', () => {
    assert.equal(
      canonicalRepoFromUrl(
        'https://github.com/backstage/community-plugins/tree/main/workspaces/pingidentity',
      ),
      'backstage/community-plugins',
    );
    assert.equal(
      canonicalRepoFromUrl('git@github.com:backstage/community-plugins.git'),
      'backstage/community-plugins',
    );
  });
});

describe('releaseBranch', () => {
  it('maps release version to branch name', () => {
    assert.equal(releaseBranch('1.10'), 'release-1.10');
  });

  it('accepts branch name as-is', () => {
    assert.equal(releaseBranch('release-1.10'), 'release-1.10');
  });

  it('rejects empty release', () => {
    assert.throws(() => releaseBranch('  '), /release is empty/);
  });
});

describe('normalizeCveId', () => {
  it('accepts valid CVE ids', () => {
    assert.equal(normalizeCveId('cve-2026-1234'), 'CVE-2026-1234');
  });

  it('rejects invalid CVE ids', () => {
    assert.throws(() => normalizeCveId('not-a-cve'), /not a CVE id/);
  });
});

describe('parseCveCliToken', () => {
  it('parses CVE id without package override', () => {
    assert.deepEqual(parseCveCliToken('CVE-2026-1234'), ['CVE-2026-1234', []]);
  });

  it('parses package override after slash', () => {
    assert.deepEqual(parseCveCliToken('CVE-2026-1234/axios'), ['CVE-2026-1234', ['axios']]);
  });

  it('parses comma-separated package overrides after slash', () => {
    assert.deepEqual(parseCveCliToken('CVE-2026-41674/@xmldom/xmldom,xmldom'), [
      'CVE-2026-41674',
      ['@xmldom/xmldom', 'xmldom'],
    ]);
  });
});

describe('parseCveArg', () => {
  it('rejects duplicate CVE ids', () => {
    assert.throws(() => parseCveArg('CVE-2026-1234,CVE-2026-1234'), /duplicate CVE/);
  });

  it('keeps package aliases together when listing multiple CVEs', () => {
    assert.deepEqual(parseCveArg('CVE-2026-44487,CVE-2026-41674/@xmldom/xmldom,xmldom'), [
      ['CVE-2026-44487', []],
      ['CVE-2026-41674', ['@xmldom/xmldom', 'xmldom']],
    ]);
  });
});

describe('parseCveDetails', () => {
  it('returns empty details for rejected CVE records', () => {
    const result = parseCveDetails({ cveMetadata: { state: 'REJECTED' }, containers: { cna: {} } });
    assert.equal(result.name, '');
    assert.deepEqual(result.names, []);
    assert.deepEqual(result.patch_versions, []);
    assert.deepEqual(result.affected_ranges, []);
  });

  it('extracts lessThan fix version and affected range', () => {
    const result = parseCveDetails({
      cveMetadata: { state: 'PUBLISHED' },
      containers: {
        cna: {
          affected: [
            { packageName: 'axios', versions: [{ status: 'affected', version: '0', lessThan: '1.18.1' }] },
          ],
        },
      },
    });
    assert.equal(result.name, 'axios');
    assert.deepEqual(result.names, ['axios']);
    assert.deepEqual(result.patch_versions, ['1.18.1']);
    assert.deepEqual(result.affected_ranges, [{ from: '0', to: '1.18.1', upper_inclusive: false }]);
  });

  it('treats lessThanOrEqual bound as affected, not a fix version', () => {
    const result = parseCveDetails({
      cveMetadata: { state: 'PUBLISHED' },
      containers: {
        cna: {
          affected: [
            {
              packageName: 'lodash',
              versions: [{ status: 'affected', version: '0', lessThanOrEqual: '4.17.20' }],
            },
          ],
        },
      },
    });
    assert.deepEqual(result.patch_versions, []);
    assert.deepEqual(result.affected_ranges, [{ from: '0', to: '4.17.20', upper_inclusive: true }]);
  });

  it('uses override package names from the CLI token', () => {
    const result = parseCveDetails(
      {
        cveMetadata: { state: 'PUBLISHED' },
        containers: {
          cna: {
            affected: [
              { product: 'wrong-name', versions: [{ status: 'affected', version: '0', lessThan: '0.8.11' }] },
            ],
          },
        },
      },
      ['@xmldom/xmldom', 'xmldom'],
    );
    assert.equal(result.name, '@xmldom/xmldom');
    assert.deepEqual(result.names, ['@xmldom/xmldom', 'xmldom']);
    assert.deepEqual(result.patch_versions, ['0.8.11']);
  });
});

describe('resolvePackageInLock', () => {
  it('uses the first override name present in yarn.lock', () => {
    const lockText = '"xmldom@npm:0.8.10":\n  resolution: "xmldom@npm:0.8.10"\n';
    const resolved = resolvePackageInLock(['@xmldom/xmldom', 'xmldom'], lockText);
    assert.equal(resolved?.package, 'xmldom');
    assert.deepEqual(resolved?.versions, ['0.8.10']);
  });
});

describe('semverInAnyAffected', () => {
  const wsRanges = [
    { from: '8.0.0', to: '8.21.0', upper_inclusive: false },
    { from: '7.0.0', to: '7.5.11', upper_inclusive: false },
  ];

  it('flags versions below the fix bound as vulnerable', () => {
    assert.equal(semverInAnyAffected('8.18.0', wsRanges), true);
    assert.equal(semverInAnyAffected('8.21.0', wsRanges), false);
  });
});

describe('vulnerabilityNoteForRow', () => {
  const npmLs = {
    name: '@internal/lightspeed',
    version: '1.0.0',
    dependencies: {
      '@backstage/cli-defaults': {
        version: '0.1.0',
        dependencies: {
          '@backstage/cli-module-build': {
            version: '0.1.2',
            dependencies: {
              '@module-federation/enhanced': {
                version: '0.21.6',
                dependencies: {
                  '@module-federation/dts-plugin': {
                    version: '0.21.6',
                    dependencies: {
                      ws: { version: '8.18.0' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it('notes still-vulnerable patch versions with an npm ls spine', () => {
    const row = {
      cve_ids: ['CVE-2026-45736'],
      package: 'ws',
      patch_version: '8.18.0, 8.21.0',
    };
    const cveDict = {
      'CVE-2026-45736': {
        name: 'ws',
        names: ['ws'],
        patch_versions: ['8.21.0'],
        affected_ranges: [{ from: '8.0.0', to: '8.21.0', upper_inclusive: false }],
      },
    };
    assert.deepEqual(
      vulnerablePatchVersions(parsePatchVersions(row.patch_version), row.cve_ids, cveDict),
      ['8.18.0'],
    );
    const note = vulnerabilityNoteForRow(row, cveDict, npmLs);
    assert.match(note!, /ws@8\.18\.0 is still in CVE affected range/);
    assert.match(note!, /@backstage\/cli-defaults@0\.1\.0/);
    assert.match(note!, /ws@8\.18\.0/);
  });

  it('collects installation paths for a specific version', () => {
    const paths = collectInstallationPaths(npmLs, 'ws', '8.18.0');
    assert.equal(paths.length, 1);
    assert.equal(formatNpmLsSpine(paths[0]).includes('ws@8.18.0'), true);
  });

  it('includes every installation path for a still-vulnerable version', () => {
    const npmLsMulti = {
      name: '@internal/orchestrator',
      version: '1.0.0',
      dependencies: {
        '@backstage/cli': {
          version: '0.34.5',
          dependencies: {
            jsdom: { version: '20.0.3', dependencies: { 'form-data': { version: '4.0.5' } } },
          },
        },
        '@backstage/repo-tools': {
          version: '0.16.0',
          dependencies: {
            axios: { version: '1.13.2', dependencies: { 'form-data': { version: '4.0.5' } } },
          },
        },
      },
    };
    const paths = collectInstallationPaths(npmLsMulti, 'form-data', '4.0.5');
    assert.equal(paths.length, 2);
    const spines = formatInstallationPathNotes(paths);
    assert.match(spines, /@backstage\/cli@0\.34\.5/);
    assert.match(spines, /@backstage\/repo-tools@0\.16\.0/);
    assert.match(spines, /\n\n/);

    const row = {
      cve_ids: ['CVE-2026-12143'],
      package: 'form-data',
      patch_version: '4.0.5',
    };
    const cveDict = {
      'CVE-2026-12143': {
        name: 'form-data',
        names: ['form-data'],
        patch_versions: ['2.5.6', '4.0.6'],
        affected_ranges: [
          { from: '0', to: '2.5.6', upper_inclusive: false },
          { from: '4.0.0', to: '4.0.6', upper_inclusive: false },
        ],
      },
    };
    const note = vulnerabilityNoteForRow(row, cveDict, npmLsMulti);
    assert.match(note!, /form-data@4\.0\.5 is still in CVE affected range/);
    assert.match(note!, /@backstage\/cli@0\.34\.5/);
    assert.match(note!, /@backstage\/repo-tools@0\.16\.0/);
  });
});

describe('mergeManifestNotes', () => {
  it('preserves manual notes and replaces auto-generated block', () => {
    const merged = mergeManifestNotes(
      'Upstream PR 123\n\n[auto] old auto note',
      '[auto] ws@8.18.0 is still in CVE affected range; verify dev-only',
    );
    assert.match(merged!, /Upstream PR 123/);
    assert.match(merged!, /ws@8\.18\.0 is still in CVE affected range/);
    assert.doesNotMatch(merged!, /old auto note/);
  });

  it('stripAutoNotes removes only the auto block', () => {
    assert.equal(stripAutoNotes('manual only'), 'manual only');
    assert.equal(stripAutoNotes('[auto] generated'), undefined);
  });
});

describe('formatManifestDocument', () => {
  it('includes patch_file, repo_ref, and backports', () => {
    const doc = formatManifestDocument('eb6cce6110fc8bd532e717e9d995764481b36f1b', [
      { cve_ids: ['CVE-2026-12143'], package: 'form-data', patch_version: '2.5.6' },
    ]);
    assert.match(doc, /patch_file: 0-cve-yarn-lock\.patch/);
    assert.match(doc, /repo_ref: eb6cce6110fc8bd532e717e9d995764481b36f1b/);
    assert.match(doc, /package: form-data/);
  });
});

describe('buildManifestRows', () => {
  it('merges CVEs with the same package and patch_version', () => {
    const rows = buildManifestRows([
      { cveId: 'CVE-2026-44486', package: 'axios', patch_versions: ['1.18.1'] },
      {
        cveId: 'CVE-2026-44487',
        package: 'axios',
        patch_versions: ['1.18.1'],
        notes: 'MITRE fix >= 1.16.0',
      },
    ]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].cve_ids, ['CVE-2026-44486', 'CVE-2026-44487']);
    assert.equal(rows[0].notes, 'MITRE fix >= 1.16.0');
  });

  it('omits notes when none are set', () => {
    const rows = buildManifestRows([
      { cveId: 'CVE-2026-12143', package: 'form-data', patch_versions: ['2.5.6', '4.0.6'] },
    ]);
    assert.equal(rows[0].patch_version, '2.5.6, 4.0.6');
    assert.equal(rows[0].notes, undefined);
  });
});

describe('formatPatchVersions', () => {
  it('joins sorted versions with comma and space', () => {
    assert.equal(formatPatchVersions(['4.0.6', '2.5.6']), '2.5.6, 4.0.6');
  });
});

describe('parsePatchVersions', () => {
  it('parses comma-separated versions', () => {
    assert.deepEqual(parsePatchVersions('4.0.6, 2.5.6'), ['2.5.6', '4.0.6']);
  });

  it('accepts a single version', () => {
    assert.deepEqual(parsePatchVersions('1.18.1'), ['1.18.1']);
  });
});

describe('versionsInLock', () => {
  it('returns all distinct versions present in yarn.lock', () => {
    const lockText = `
"form-data@npm:2.5.6":
  resolution: "form-data@npm:2.5.6"
"form-data@npm:4.0.6":
  resolution: "form-data@npm:4.0.6"
`;
    assert.deepEqual(versionsInLock(lockText, 'form-data'), ['2.5.6', '4.0.6']);
  });
});
