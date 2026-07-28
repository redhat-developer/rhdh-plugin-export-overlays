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

// Validates Package metadata under workspaces/*/metadata/*.yaml.
//
// Two layers:
//   1. structural — every Package must carry a non-empty first
//      appConfigExamples[].content, or opt out via spec.appConfigNotRequired.
//      Ported unchanged from the previous Python script (RHIDP-12590).
//   2. semantic — each example's content must satisfy the plugin's own config
//      schema, read from the published package (RHIDP-13509). Off by default;
//      enable with --check-schemas.

import { glob } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedMetadataPaths,
  configExamples,
  evaluateFile,
  packageCoordinates,
  type Status,
} from './metadata.js';
import { SchemaResolver, validateExample } from './schema.js';

type Row = {
  status: Status;
  path: string;
  detail: string;
  /** Non-fatal notes (missing schema, registry hiccup) shown under the row. */
  notes: string[];
};

const USAGE = `Usage: validate-app-config-examples [options]

  --since <SHA>      Only validate metadata YAML changed in SHA...HEAD.
                     Exits 0 when the range touches no metadata.
  --check-schemas    Also validate each example against the plugin's config
                     schema, resolved from the published package.
  --warn-only        Report schema mismatches without failing. Structural
                     failures still fail the run.
  --help             Show this message.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      since: { type: 'string' },
      'check-schemas': { type: 'boolean', default: false },
      'warn-only': { type: 'boolean', default: false },
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

  const resolver = new SchemaResolver();
  const rows: Row[] = [];
  let schemaFailures = 0;

  try {
    for (const path of paths) {
      const result = await evaluateFile(join(repoRoot, path));
      const row: Row = {
        status: result.status,
        path,
        detail: result.detail,
        notes: [],
      };
      rows.push(row);

      // Only structurally sound Packages are worth schema-checking: a file that
      // failed above has nothing meaningful to validate.
      if (!values['check-schemas'] || result.status !== 'PASS') {
        continue;
      }

      const pkg = packageCoordinates(result.doc);
      if (!pkg) {
        row.notes.push('no packageName/version — schema check skipped');
        continue;
      }

      for (const example of configExamples(result.doc)) {
        const outcome = await validateExample(
          resolver,
          pkg,
          `${path} (${example.title})`,
          example.content,
        );
        if (outcome.kind === 'invalid') {
          schemaFailures += 1;
          if (!values['warn-only']) {
            row.status = 'FAIL';
          }
          const label = values['warn-only'] ? 'schema warning' : 'schema error';
          for (const error of outcome.errors) {
            row.notes.push(`${label} in "${example.title}": ${error}`);
          }
        } else if (outcome.kind === 'no-schema') {
          row.notes.push(
            `${pkg.name} declares no configSchema — nothing to validate against`,
          );
          break;
        } else if (outcome.kind === 'unavailable') {
          row.notes.push(`schema unavailable: ${outcome.reason}`);
          break;
        }
      }
    }
  } finally {
    await resolver.cleanup();
  }

  return report(rows, schemaFailures, values['warn-only'] ?? false);
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

function report(rows: Row[], schemaFailures: number, warnOnly: boolean): number {
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
    for (const note of row.notes) {
      process.stdout.write(`${' '.repeat(statusWidth + 2)}  - ${note}\n`);
    }
  }

  const failures = rows.filter(row => row.status === 'FAIL').length;
  const passes = rows.filter(row => row.status === 'PASS').length;
  process.stdout.write('\n');
  process.stdout.write(
    `Total: ${rows.length}  PASS: ${passes}  FAIL: ${failures}\n`,
  );
  if (schemaFailures > 0) {
    const noun = schemaFailures === 1 ? 'mismatch' : 'mismatches';
    process.stdout.write(
      `Schema ${noun}: ${schemaFailures}${warnOnly ? ' (warn-only)' : ''}\n`,
    );
  }

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
