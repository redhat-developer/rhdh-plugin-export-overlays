/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Validates Package metadata under workspaces/*/metadata/*.yaml: every Package
// must carry a non-empty first appConfigExamples[].content, or opt out via
// spec.appConfigNotRequired.
//
// Behaviour-preserving port of scripts/validate-app-config-examples.py
// (RHIDP-12590) — same verdicts, same wording, same exit codes.

import { glob } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedMetadataPaths,
  evaluateFile,
  type Status,
} from './metadata.js';

type Row = {
  status: Status;
  path: string;
  detail: string;
};

const USAGE = `Usage: validate-app-config-examples [options]

  --since <SHA>      Only validate metadata YAML changed in SHA...HEAD.
                     Exits 0 when the range touches no metadata.
  --help             Show this message.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      since: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Reported paths are repo-relative, so everything is resolved against the
  // repo root explicitly rather than by moving the process there — the tool can
  // then be invoked from any directory without its behaviour changing.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  const paths = values.since
    ? await changedMetadataPaths(values.since, repoRoot)
    : await collectAllMetadata(repoRoot);

  if (values.since && paths.length === 0) {
    process.stdout.write(
      'No workspaces/*/metadata/*.yaml changes in range; nothing to validate.\n',
    );
    return 0;
  }

  const rows: Row[] = [];
  for (const path of paths) {
    const result = await evaluateFile(join(repoRoot, path));
    rows.push({ status: result.status, path, detail: result.detail });
  }

  return report(rows);
}

async function collectAllMetadata(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of glob('workspaces/*/metadata/*.yaml', {
    cwd: repoRoot,
  })) {
    found.push(entry);
  }
  return found.sort();
}

function report(rows: Row[]): number {
  const statusWidth = Math.max(
    'STATUS'.length,
    ...rows.map(row => row.status.length),
  );

  process.stdout.write(`${'STATUS'.padEnd(statusWidth)}  FILE\n`);
  process.stdout.write(`${'-'.repeat(statusWidth + 3 + 72)}\n`);
  for (const row of rows) {
    let line = `${row.status.padEnd(statusWidth)}  ${row.path}`;
    if (row.status !== 'PASS') {
      line += `  # ${row.detail}`;
    }
    process.stdout.write(`${line}\n`);
  }

  const failures = rows.filter(row => row.status === 'FAIL').length;
  const passes = rows.filter(row => row.status === 'PASS').length;
  process.stdout.write('\n');
  process.stdout.write(
    `Total: ${rows.length}  PASS: ${passes}  FAIL: ${failures}\n`,
  );
  if (failures > 0) {
    process.stderr.write('\nValidation failed.\n');
    return 1;
  }
  return 0;
}

main().then(
  code => {
    process.exitCode = code;
  },
  error => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 2;
  },
);
