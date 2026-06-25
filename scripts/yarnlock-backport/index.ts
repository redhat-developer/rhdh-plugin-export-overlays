#!/usr/bin/env node
/** CLI entrypoint — see backport.ts for prepare/generate workflow. */

import { parseArgs } from 'node:util';
import { generateBackport, prepareWorkspace } from './backport.ts';

const USAGE = `Usage:
  yarnlock-backport prepare  --release <version> --overlay-workspace <path> --plugins-repo <path> [--skip-patch] [--force] [--dry-run]
  yarnlock-backport generate --release <version> --overlay-workspace <path> --plugins-repo <path> --cve <ids> [--dry-run]`;

const common = {
  release: { type: 'string' as const },
  'overlay-workspace': { type: 'string' as const },
  'plugins-repo': { type: 'string' as const },
  'dry-run': { type: 'boolean' as const, default: false },
};

function requirePaths(values: Record<string, unknown>, extra: string[] = []): void {
  const missing = ['release', 'overlay-workspace', 'plugins-repo', ...extra].filter(k => !values[k]);
  if (missing.length) {
    console.error(USAGE);
    process.exit(1);
  }
}

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === 'prepare') {
    const { values } = parseArgs({
      args: rest,
      options: { ...common, 'skip-patch': { type: 'boolean', default: false }, force: { type: 'boolean', default: false } },
      strict: true,
    });
    requirePaths(values);
    await prepareWorkspace({
      release: values.release!,
      overlayWorkspace: values['overlay-workspace']!,
      pluginsRepo: values['plugins-repo']!,
      skipPatch: values['skip-patch'],
      force: values.force,
      dryRun: values['dry-run'],
    });
  } else if (command === 'generate') {
    const { values } = parseArgs({ args: rest, options: { ...common, cve: { type: 'string' as const } }, strict: true });
    requirePaths(values, ['cve']);
    await generateBackport({
      release: values.release!,
      overlayWorkspace: values['overlay-workspace']!,
      pluginsRepo: values['plugins-repo']!,
      cve: values.cve!,
      dryRun: values['dry-run'],
    });
  } else {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : 'command failed');
  process.exit(1);
}
