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
//   3. undeclared keys — within the subtrees a plugin's schema owns, a key it
//      does not declare is a typo (RHIDP-15902). Off by default; enable with
//      --check-undeclared-keys. Reports, never fails.

import { realpathSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import {
  examplesWithContent,
  evaluateFile,
  isMetadataPath,
  packageCoordinates,
  type Status,
} from "./metadata.js";
import { byCodepoint } from "./json.js";
import {
  SchemaResolver,
  findUndeclaredKeys,
  validateExample,
  type SchemaOutcome,
  type SchemaRequest,
  type SchemaSource,
} from "./schema.js";

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
 *
 * All four count *files*, not examples. Mixing units made the row meaningless:
 * a file with three good examples would add 3 to `validated` while a file whose
 * package has no schema added 1 to `noSchema`, printed side by side as if
 * comparable. Individual mismatches are already listed under their row.
 */
export type SchemaTally = {
  validated: number;
  mismatched: number;
  noSchema: number;
  unavailable: number;
};

/**
 * How the undeclared-key layer fared, printed when it runs.
 *
 * Separate from SchemaTally because the two answer different questions and
 * cover different files: a package can be validated against its schema while
 * declaring no top-level key the example touches, which leaves nothing for this
 * layer to inspect. Counting files, like SchemaTally, so the two read the same.
 */
export type UndeclaredTally = {
  /** Files where the plugin's schema declares a top-level key the example sets. */
  withOwnedSubtree: number;
  /** Files where a key inside such a subtree is not declared. */
  withFindings: number;
};

/** Table rule width beyond the status column — inherited from the Python table. */
const RULE_PADDING = 75;

const USAGE = `Usage: validate-app-config-examples [options]

  --since <SHA>      Only validate metadata YAML changed in SHA...HEAD.
                     Exits 0 when the range touches no metadata.
  --check-schemas    Also validate each example against the plugin's config
                     schema, resolved from the published package.
  --check-undeclared-keys
                     Also report keys the plugin's schema does not declare,
                     within the subtrees it owns. Its own findings never fail
                     the run, but it implies --check-schemas, which does fail
                     on a mismatch unless --warn-only is also given.
  --warn-only        Report schema mismatches without failing. Structural
                     failures still fail the run.
  --help             Show this message.
`;

export async function main(
  argv: string[] = process.argv.slice(2),
  write: (text: string) => void = (text) => process.stdout.write(text),
  writeError: (text: string) => void = (text) => process.stderr.write(text),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string" },
      "check-schemas": { type: "boolean", default: false },
      "check-undeclared-keys": { type: "boolean", default: false },
      "warn-only": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    write(USAGE);
    return 0;
  }

  // Reported paths are repo-relative, so everything is resolved against the
  // repo root explicitly rather than by moving the process there — the tool can
  // then be invoked from any directory without its behaviour changing.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  // `--since ''` is a caller mistake, not a request to scan everything: with
  // --check-schemas that would silently become a full-tree download.
  if (values.since !== undefined && values.since.trim() === "") {
    writeError("--since needs a commit-ish\n");
    return 2;
  }

  const paths = values.since
    ? await changedMetadataPaths(values.since, repoRoot)
    : await collectAllMetadata(repoRoot);

  if (values.since && paths.length === 0) {
    write(
      "No workspaces/*/metadata/*.yaml changes in range; nothing to validate.\n",
    );
    return 0;
  }

  // Undeclared keys are found by comparing a strict schema against the lenient
  // one, so the schema layer has to be running for this to mean anything.
  const checkUndeclared = values["check-undeclared-keys"] ?? false;
  const checkSchemasFlag =
    (values["check-schemas"] ?? false) || checkUndeclared;

  const resolver = new SchemaResolver();
  const rows: Row[] = [];
  const tally: SchemaTally = {
    validated: 0,
    mismatched: 0,
    noSchema: 0,
    unavailable: 0,
  };
  const undeclared: UndeclaredTally | undefined = checkUndeclared
    ? { withOwnedSubtree: 0, withFindings: 0 }
    : undefined;

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
      if (checkSchemasFlag && result.status === "PASS") {
        await checkSchemas(
          row,
          result.doc,
          resolver,
          values["warn-only"] ?? false,
          tally,
          await workspacePatches(repoRoot, path),
          undeclared,
        );
      }
    }
  } finally {
    await resolver.cleanup();
  }

  printReport(
    rows,
    tally,
    { checked: checkSchemasFlag, undeclared },
    write,
    writeError,
  );
  return exitCodeFor(rows);
}

/** Validates every example on one row, recording the file's outcome in `tally`. */
async function checkSchemas(
  row: Row,
  doc: Record<string, unknown> | undefined,
  source: SchemaSource,
  warnOnly: boolean,
  tally: SchemaTally,
  patches: readonly string[],
  undeclared: UndeclaredTally | undefined,
): Promise<void> {
  const examples = examplesWithContent(doc);
  if (examples.length === 0) {
    return;
  }

  const coordinates = packageCoordinates(doc);
  if (!coordinates) {
    row.notes.push("no packageName/version — schema check skipped");
    tally.unavailable += 1;
    return;
  }
  const pkg = { ...coordinates, patches };

  let validatedAny = false;
  let mismatchedAny = false;

  for (const example of examples) {
    const label = `${row.path} (${example.title})`;
    const outcome = await validateExample(source, pkg, label, example.content);

    // no-schema and unavailable are properties of the package, not the example,
    // so the first one settles the whole file — and leave before the undeclared
    // pass below, which has no schema to be strict about either.
    if (outcome.kind === "no-schema" || outcome.kind === "unavailable") {
      recordPackageOutcome(row, pkg.name, outcome, warnOnly, tally);
      return;
    }

    if (outcome.kind === "ok") {
      validatedAny = true;
    } else {
      mismatchedAny = true;
      recordMismatch(row, example.title, outcome.errors, warnOnly);
    }
  }

  if (mismatchedAny) {
    tally.mismatched += 1;
  } else if (validatedAny) {
    tally.validated += 1;
  }

  if (undeclared) {
    await checkUndeclaredKeys(row, source, pkg, examples, undeclared);
  }
}

/**
 * Annotates a row with the undeclared keys in every example, and counts the file.
 *
 * A separate pass rather than another arm inside the schema loop: the two
 * answer different questions and keep separate tallies, and interleaving them
 * left one function carrying four accumulators. The schema resolution it needs
 * is already cached by the time this runs.
 */
async function checkUndeclaredKeys(
  row: Row,
  source: SchemaSource,
  pkg: SchemaRequest,
  examples: { title: string; content: unknown }[],
  undeclared: UndeclaredTally,
): Promise<void> {
  let ownsSubtreeAny = false;
  let findingAny = false;

  for (const example of examples) {
    const outcome = await findUndeclaredKeys(
      source,
      pkg,
      `${row.path} (${example.title})`,
      example.content,
    );
    ownsSubtreeAny ||= outcome.ownsSubtree;
    findingAny ||= outcome.findings.length > 0;
    for (const finding of outcome.findings) {
      row.notes.push(`undeclared key in "${example.title}": ${finding}`);
    }
  }

  if (ownsSubtreeAny) {
    undeclared.withOwnedSubtree += 1;
  }
  if (findingAny) {
    undeclared.withFindings += 1;
  }
}

/**
 * Annotates a row with an outcome that belongs to the package rather than to
 * one example — no schema to check against, or none that could be loaded.
 */
function recordPackageOutcome(
  row: Row,
  packageName: string,
  outcome: Extract<SchemaOutcome, { kind: "no-schema" | "unavailable" }>,
  warnOnly: boolean,
  tally: SchemaTally,
): void {
  if (outcome.kind === "no-schema") {
    tally.noSchema += 1;
    row.notes.push(
      `${packageName} declares no configSchema — nothing to validate against`,
    );
    return;
  }

  tally.unavailable += 1;
  row.notes.push(`schema unavailable: ${outcome.reason}`);
  // A patch that has stopped applying is a defect in this repo, not a fact
  // about the registry, and it silently removes a package from validation.
  // Failing is the only way the weekly sweep can surface it: every other
  // unavailable reason leaves the row PASS, and exitCodeFor reads status.
  if (outcome.patchFailure && !warnOnly) {
    row.status = "FAIL";
    row.detail = "a workspace patch no longer applies to this package";
  }
}

/** Annotates a row with one example's schema errors. */
function recordMismatch(
  row: Row,
  title: string,
  errors: string[],
  warnOnly: boolean,
): void {
  if (!warnOnly) {
    row.status = "FAIL";
    // Without this the row keeps the structural verdict and prints
    // "FAIL ... # has non-empty first example content", which reads as a broken
    // tool rather than a failed example.
    row.detail = "example does not match the plugin config schema";
  }
  const label = warnOnly ? "schema warning" : "schema error";
  for (const error of errors) {
    row.notes.push(`${label} in "${title}": ${error}`);
  }
}

const execFileAsync = promisify(execFile);

/** True when this module is the script node was asked to run. */
function isInvokedDirectly(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/**
 * Metadata paths added/copied/modified/renamed between `since` and HEAD.
 *
 * Lives next to collectAllMetadata because the two answer the same question —
 * which files does this run look at — rather than in metadata.ts, which is
 * about what a document means.
 */
async function changedMetadataPaths(
  since: string,
  repoRoot: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${since}...HEAD`],
    { cwd: repoRoot },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && isMetadataPath(line))
    .sort(byCodepoint);
}

/**
 * The workspace patches that apply to a metadata file's package.
 *
 * This repo exports a *patched* build — `workspaces/<ws>/patches/*.patch` is
 * applied to the source before packaging — so a patch touching `config.d.ts`
 * makes the published schema differ from the one the artifact enforces. The
 * resolver needs them to reconstruct what actually ships.
 */
const patchesByWorkspace = new Map<string, Promise<string[]>>();

async function workspacePatches(
  repoRoot: string,
  metadataPath: string,
): Promise<string[]> {
  const workspace = metadataPath.split("/")[1];
  if (!workspace) {
    return [];
  }
  // Memoised: a workspace holds many metadata files and the answer is the same
  // for all of them, so without this a full-tree run globs 180 times to answer
  // ~40 distinct questions.
  let pending = patchesByWorkspace.get(workspace);
  if (!pending) {
    pending = globPatches(repoRoot, workspace);
    patchesByWorkspace.set(workspace, pending);
  }
  return pending;
}

async function globPatches(
  repoRoot: string,
  workspace: string,
): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of glob(`workspaces/${workspace}/patches/*.patch`, {
    cwd: repoRoot,
  })) {
    found.push(join(repoRoot, entry));
  }
  return found.sort(byCodepoint);
}

async function collectAllMetadata(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of glob("workspaces/*/metadata/*.yaml", {
    cwd: repoRoot,
  })) {
    found.push(entry);
  }
  return found.sort(byCodepoint);
}

/** The run's exit code: 1 when any row failed, 0 otherwise. */
export function exitCodeFor(rows: Row[]): number {
  return rows.some((row) => row.status === "FAIL") ? 1 : 0;
}

export function printReport(
  rows: Row[],
  tally: SchemaTally,
  schemas: { checked: boolean; undeclared?: UndeclaredTally },
  write: (text: string) => void,
  writeError: (text: string) => void,
): void {
  const { checked: checkedSchemas, undeclared } = schemas;
  const statusWidth = Math.max(
    "STATUS".length,
    ...rows.map((row) => row.status.length),
  );

  write(`${"STATUS".padEnd(statusWidth)}  FILE\n`);
  write(`${"-".repeat(statusWidth + RULE_PADDING)}\n`);
  for (const row of rows) {
    let line = `${row.status.padEnd(statusWidth)}  ${row.path}`;
    if (row.status !== "PASS") {
      line += `  # ${row.detail}`;
    }
    write(`${line}\n`);
    for (const note of row.notes) {
      write(`${" ".repeat(statusWidth + 2)}  - ${note}\n`);
    }
  }

  const failures = rows.filter((row) => row.status === "FAIL").length;
  const passes = rows.filter((row) => row.status === "PASS").length;
  write("\n");
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
        "NOTE: no example was checked against a schema. The result above says " +
          "nothing about whether the examples are correct.\n",
      );
    }
  }

  if (undeclared) {
    write(
      `Undeclared keys — plugin-owned subtrees: ${undeclared.withOwnedSubtree}  ` +
        `with findings: ${undeclared.withFindings}\n`,
    );
    if (undeclared.withOwnedSubtree === 0) {
      write(
        "NOTE: no example had a subtree its plugin's schema declares, so no " +
          "undeclared key could have been found.\n",
      );
    } else if (undeclared.withFindings > 0) {
      // Only worth saying when there is something to be advisory about — after
      // the line above it would read as "we found nothing, and nothing we found
      // would have failed".
      write(
        "NOTE: undeclared keys are reported, never failed. Not every finding " +
          "is a typo; see the README.\n",
      );
    }
  }

  if (failures > 0) {
    writeError("\nValidation failed.\n");
  }
}

// Only run the CLI when invoked directly, so tests can import main() and report()
// without the module executing on import.
// Node resolves a module's own path through realpath, but leaves argv[1] as
// given — so comparing them directly skips the CLI when invoked via a symlink.
if (isInvokedDirectly()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // Exit 2 marks a tool failure, distinct from exit 1 for a validation
    // failure — CI can tell "the metadata is wrong" from "the check broke".
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`,
    );
    process.exitCode = 2;
  }
}
