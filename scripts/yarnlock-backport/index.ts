#!/usr/bin/env node
/** CLI entrypoint — see backport.ts for prepare/generate workflow. */

import { parseArgs } from 'node:util';
import { generateBackport, prepareWorkspace } from './backport.ts';

const USAGE = `Usage:
  yarnlock-backport prepare  --release <version> --overlay-workspace <path> --plugins-repo <path> [--skip-patch] [--force] [--verbose] [--dry-run]
  yarnlock-backport generate --release <version> --overlay-workspace <path> --plugins-repo <path> --cve <ids> [--verbose] [--dry-run]`;

const common = {
  release: { type: 'string' as const },
  'overlay-workspace': { type: 'string' as const },
  'plugins-repo': { type: 'string' as const },
  verbose: { type: 'boolean' as const, default: false },
  'dry-run': { type: 'boolean' as const, default: false },
};

function requirePaths(values: Record<string, unknown>, extra: string[] = []): void {
  const missing = ['release', 'overlay-workspace', 'plugins-repo', ...extra].filter(k => !values[k]);
  if (missing.length) {
    const flags = missing.map(k => `--${k}`).join(', ');
    console.error(`Missing required flags: ${flags}`);
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
      verbose: values.verbose,
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
      verbose: values.verbose,
    });
  } else {
    console.error(USAGE);
    process.exit(1);
  }
} catch (err) {
  if (err instanceof Error && !err.message.startsWith('command failed:')) {
    console.error(err.message);
  }
  process.exit(1);
}
