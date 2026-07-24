#!/usr/bin/env node
/*
 * Copyright (c) Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
/** CLI entrypoint — see backport.ts for prepare/generate workflow. */

import { parseArgs } from 'node:util';
import { generateBackport, prepareWorkspace } from './backport.ts';

const USAGE = `Usage:
  yarnlock-backport prepare  --release <version> --overlay-workspace <path> --plugins-repo <path> [--skip-patch] [--skip-overlay-sync] [--force] [--verbose] [--dry-run]
  yarnlock-backport generate --release <version> --overlay-workspace <path> --plugins-repo <path> --cve <ids> [--skip-overlay-sync] [--force] [--verbose] [--dry-run]`;

const common = {
  release: { type: 'string' as const },
  'overlay-workspace': { type: 'string' as const },
  'plugins-repo': { type: 'string' as const },
  'skip-overlay-sync': { type: 'boolean' as const, default: false },
  force: { type: 'boolean' as const, default: false },
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
      options: { ...common, 'skip-patch': { type: 'boolean', default: false } },
      strict: true,
    });
    requirePaths(values);
    await prepareWorkspace({
      release: values.release!,
      overlayWorkspace: values['overlay-workspace']!,
      pluginsRepo: values['plugins-repo']!,
      skipPatch: values['skip-patch'],
      skipOverlaySync: values['skip-overlay-sync'],
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
      skipOverlaySync: values['skip-overlay-sync'],
      force: values.force,
      dryRun: values['dry-run'],
      verbose: values.verbose,
    });
  } else {
    console.error(USAGE);
    process.exit(1);
  }
} catch (err) {
  // exec() already printed "command failed:" summaries to stderr — avoid duplicating them.
  if (err instanceof Error) {
    if (!err.message.startsWith('command failed:')) {
      console.error(err.message);
      if (process.argv.includes('--verbose') && err.stack) console.error(err.stack);
    }
  } else {
    console.error(String(err));
  }
  process.exit(1);
}
