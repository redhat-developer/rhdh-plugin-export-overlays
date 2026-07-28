/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
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
import {
  SchemaResolver,
  validateExample,
  type SchemaSource,
} from './schema.js';

export type Row = {
  status: Status;
  path: string;
  detail: string;
  /** Non-fatal notes (missing schema, registry hiccup) shown under the row. */
  notes: string[];
};

/**
 * How the semantic layer fared, printed in the summary.
 *
 * Counted and always shown because the failure modes are quiet: a package with
 * no schema, or one that cannot be fetched or compiled, produces a note and
 * nothing else. Without a tally an offline runner reports "PASS: 178, FAIL: 0"
 * having validated nothing at all, and the gate looks green because it is
 * inert.
 */
export type SchemaTally = {
  validated: number;
  mismatched: number;
  noSchema: number;
  unavailable: number;
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

export async function main(
  argv: string[] = process.argv.slice(2),
  write: (text: string) => void = text => process.stdout.write(text),
  writeError: (text: string) => void = text => process.stderr.write(text),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: 'string' },
      'check-schemas': { type: 'boolean', default: false },
      'warn-only': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    write(USAGE);
    return 0;
  }

  // Reported paths are repo-relative, so everything is resolved against the
  // repo root explicitly rather than by moving the process there — the tool can
  // then be invoked from any directory without its behaviour changing.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  // `--since ''` is a caller mistake, not a request to scan everything: with
  // --check-schemas that would silently become a full-tree download.
  if (values.since !== undefined && values.since.trim() === '') {
    writeError('--since needs a commit-ish\n');
    return 2;
  }

  const paths = values.since
    ? await changedMetadataPaths(values.since, repoRoot)
    : await collectAllMetadata(repoRoot);

  if (values.since && paths.length === 0) {
    write('No workspaces/*/metadata/*.yaml changes in range; nothing to validate.\n');
    return 0;
  }

  const resolver = new SchemaResolver();
  const rows: Row[] = [];
  const tally: SchemaTally = {
    validated: 0,
    mismatched: 0,
    noSchema: 0,
    unavailable: 0,
  };

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
      if (values['check-schemas'] && result.status === 'PASS') {
        await checkSchemas(
          row,
          result.doc,
          resolver,
          values['warn-only'] ?? false,
          tally,
        );
      }
    }
  } finally {
    await resolver.cleanup();
  }

  return report(rows, tally, values['check-schemas'] ?? false, write, writeError);
}

/** Validates every example on one row, recording outcomes into `tally`. */
async function checkSchemas(
  row: Row,
  doc: Record<string, unknown> | undefined,
  source: SchemaSource,
  warnOnly: boolean,
  tally: SchemaTally,
): Promise<void> {
  const pkg = packageCoordinates(doc);
  const examples = configExamples(doc);
  if (examples.length === 0) {
    return;
  }
  if (!pkg) {
    row.notes.push('no packageName/version — schema check skipped');
    tally.unavailable += 1;
    return;
  }

  for (const example of examples) {
    const outcome = await validateExample(
      source,
      pkg,
      `${row.path} (${example.title})`,
      example.content,
    );
    if (outcome.kind === 'invalid') {
      tally.mismatched += 1;
      if (!warnOnly) {
        row.status = 'FAIL';
        // Without this the row keeps the structural verdict and prints
        // "FAIL ... # has non-empty first example content", which reads as a
        // broken tool rather than a failed example.
        row.detail = 'example does not match the plugin config schema';
      }
      const label = warnOnly ? 'schema warning' : 'schema error';
      for (const error of outcome.errors) {
        row.notes.push(`${label} in "${example.title}": ${error}`);
      }
    } else if (outcome.kind === 'ok') {
      tally.validated += 1;
    } else if (outcome.kind === 'no-schema') {
      tally.noSchema += 1;
      row.notes.push(
        `${pkg.name} declares no configSchema — nothing to validate against`,
      );
      break;
    } else {
      tally.unavailable += 1;
      row.notes.push(`schema unavailable: ${outcome.reason}`);
      break;
    }
  }
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

export function report(
  rows: Row[],
  tally: SchemaTally,
  checkedSchemas: boolean,
  write: (text: string) => void,
  writeError: (text: string) => void,
): number {
  const statusWidth = Math.max(
    'STATUS'.length,
    ...rows.map(row => row.status.length),
  );

  write(`${'STATUS'.padEnd(statusWidth)}  FILE\n`);
  write(`${'-'.repeat(statusWidth + 3 + 72)}\n`);
  for (const row of rows) {
    let line = `${row.status.padEnd(statusWidth)}  ${row.path}`;
    if (row.status !== 'PASS') {
      line += `  # ${row.detail}`;
    }
    write(`${line}\n`);
    for (const note of row.notes) {
      write(`${' '.repeat(statusWidth + 2)}  - ${note}\n`);
    }
  }

  const failures = rows.filter(row => row.status === 'FAIL').length;
  const passes = rows.filter(row => row.status === 'PASS').length;
  write('\n');
  write(`Total: ${rows.length}  PASS: ${passes}  FAIL: ${failures}\n`);

  if (checkedSchemas) {
    write(
      `Schemas — validated: ${tally.validated}  ` +
        `mismatched: ${tally.mismatched}  ` +
        `no schema: ${tally.noSchema}  ` +
        `unavailable: ${tally.unavailable}\n`,
    );
    if (tally.validated === 0) {
      write(
        'NOTE: no example was checked against a schema. The result above says ' +
          'nothing about whether the examples are correct.\n',
      );
    }
  }

  if (failures > 0) {
    writeError('\nValidation failed.\n');
    return 1;
  }
  return 0;
}

// Only run the CLI when invoked directly, so tests can import main() and report()
// without the module executing on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    code => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Exit 2 marks a tool failure, distinct from exit 1 for a validation
      // failure — CI can tell "the metadata is wrong" from "the check broke".
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 2;
    },
  );
}
