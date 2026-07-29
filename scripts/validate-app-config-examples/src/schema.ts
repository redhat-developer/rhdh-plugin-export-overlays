/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// Semantic validation of appConfigExamples against the plugin's own config
// schema (RHIDP-13509).
//
// Schemas come from the *published* package rather than the source repo: the
// metadata already pins `packageName` + `version`, that tarball is the artifact
// users actually install, and it needs no cross-repo SHA resolution.
//
// @backstage/config-loader reads `configSchema` from package.json and handles
// both forms found across this catalogue — a compiled `config.schema.json`, and
// a raw `config.d.ts` it compiles with the TypeScript compiler.
//
// Known gap: a `config.d.ts` that imports types from the plugin's dependencies
// cannot compile, because `npm pack` fetches the package alone with no
// node_modules. config-loader compiles with `skipLibCheck: false` and rejects
// on any semantic diagnostic, so those packages resolve to `unavailable`. On a
// 29-package sample, 6 were affected. Installing each package's dependency tree
// would fix it at a cost this check cannot justify, so the gap is reported
// rather than hidden — see the outcome tally in validate.ts.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfigSchema } from "@backstage/config-loader";
import { errorProperty, isPlainObject } from "./json.js";

const execFileAsync = promisify(execFile);

/** How many lines of a multi-line diagnostic reach the report. */
const DIAGNOSTIC_LINES = 3;

export type SchemaOutcome =
  | { kind: "ok" }
  | { kind: "invalid"; errors: string[] }
  | { kind: "no-schema" }
  | { kind: "unavailable"; reason: string };

export type ResolvedSchema =
  | { kind: "schema"; schema: Awaited<ReturnType<typeof loadConfigSchema>> }
  | { kind: "no-schema" }
  | { kind: "unavailable"; reason: string };

/**
 * Where `validateExample` gets a schema from.
 *
 * Declared structurally rather than as the concrete class so tests can supply
 * an in-memory schema built with `loadConfigSchema({ serialized })` — the class
 * has private fields, which would make a fake fail to type-check.
 */
export type SchemaSource = {
  resolve(name: string, version: string): Promise<ResolvedSchema>;
};

// The leading character is deliberately narrower than npm's own grammar: it
// must not be `-`, or the value reaches `npm pack` as a flag. Note the dash sits
// last inside each class — `[a-z0-9-~]` would read `9-~` as a range covering
// most of printable ASCII, which is how the first version of this let `--foo`
// through.
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const PACKAGE_VERSION = /^\d[\da-zA-Z.+-]*$/;

/**
 * True when the pair is safe to hand to `npm pack` as a package spec.
 *
 * Both halves come from a metadata YAML that a fork's pull request controls.
 * `execFile` rules out a shell, but not npm's own argument parsing: a name
 * beginning with `-` would be read as a flag, so `--registry=…` could redirect
 * the fetch to a registry of the author's choosing.
 */
export function isSafePackageSpec(name: string, version: string): boolean {
  return PACKAGE_NAME.test(name) && PACKAGE_VERSION.test(version);
}

/**
 * Downloads a published package and loads its config schema.
 *
 * Results are cached by `name@version`, a key the registry treats as immutable,
 * so a full-tree run fetches each tarball once rather than once per metadata
 * file referencing it.
 */
export class SchemaResolver implements SchemaSource {
  private readonly cache = new Map<string, Promise<ResolvedSchema>>();
  private readonly tempDirs: string[] = [];

  async resolve(name: string, version: string): Promise<ResolvedSchema> {
    if (!isSafePackageSpec(name, version)) {
      return {
        kind: "unavailable",
        reason: `refusing to fetch unsafe package spec ${name}@${version}`,
      };
    }
    const key = `${name}@${version}`;
    let pending = this.cache.get(key);
    if (!pending) {
      // Catch before caching: a rejected promise stored here would be re-thrown
      // for every later file with the same package, escaping validateExample
      // and aborting the whole run instead of failing one row.
      pending = this.load(key).catch((error) => ({
        kind: "unavailable" as const,
        reason: describeError(error),
      }));
      this.cache.set(key, pending);
    }
    return pending;
  }

  /** Removes every temp directory this resolver created. */
  async cleanup(): Promise<void> {
    await Promise.all(
      this.tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    this.tempDirs.length = 0;
  }

  private async load(spec: string): Promise<ResolvedSchema> {
    let dir: string;
    try {
      dir = await mkdtemp(join(tmpdir(), "app-config-schema-"));
      this.tempDirs.push(dir);
    } catch (error) {
      return { kind: "unavailable", reason: `temp dir failed: ${error}` };
    }

    let packageDir: string;
    try {
      packageDir = await extractPackage(spec, dir);
    } catch (error) {
      // Plenty of packages in this catalogue are not on the public registry.
      // That is not a metadata defect, so it is reported rather than failed.
      return { kind: "unavailable", reason: describeError(error) };
    }

    try {
      const schema = await loadConfigSchema({
        packagePaths: [join(packageDir, "package.json")],
        // Only this package's own schema matters; pulling in its dependency
        // tree would validate the example against unrelated plugins' keys.
        dependencies: [],
        excludePackageDependencies: true,
      });
      // A package with no `configSchema` still yields a schema object — an
      // empty one that accepts anything. Detect that so the result is reported
      // honestly instead of as a vacuous pass.
      if (!hasConstraints(schema.serialize())) {
        return { kind: "no-schema" };
      }
      return { kind: "schema", schema };
    } catch (error) {
      return { kind: "unavailable", reason: describeError(error) };
    }
  }
}

/** `npm pack` the spec into `dir` and unpack it. Returns the package root. */
async function extractPackage(spec: string, dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", spec, "--pack-destination", dir, "--loglevel", "error"],
    { cwd: dir },
  );
  const tarball = stdout.trim().split("\n").pop()?.trim();
  if (!tarball) {
    throw new Error(`npm pack produced no tarball for ${spec}`);
  }
  // --no-same-owner: on a runner executing as root, tar would otherwise honour
  // ownership recorded in the archive, letting a crafted tarball drop files
  // owned by an arbitrary uid.
  await execFileAsync("tar", ["-xzf", tarball, "--no-same-owner", "-C", dir], {
    cwd: dir,
  });
  return findPackageRoot(dir, spec);
}

/**
 * Picks the unpacked package directory out of `dir`.
 *
 * npm tarballs conventionally unpack into `package/`, but readdir order is
 * filesystem-dependent, so picking "the first directory" could silently choose
 * wrong — and choosing wrong is invisible: config-loader skips a missing path
 * and returns an empty schema, which reads downstream as "declares no
 * configSchema", a vacuous pass. Requiring a package.json makes a surprising
 * layout fail loudly instead.
 */
export async function findPackageRoot(
  dir: string,
  spec: string,
): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(conventionalFirst);

  for (const candidate of candidates) {
    const root = join(dir, candidate);
    if (await isFile(join(root, "package.json"))) {
      return root;
    }
  }
  throw new Error(`no unpacked package directory for ${spec}`);
}

/** Orders the conventional `package/` directory ahead of anything else. */
function conventionalFirst(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a === "package") {
    return -1;
  }
  return b === "package" ? 1 : 0;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * True when a serialized schema actually constrains anything.
 *
 * config-loader always returns a wrapper document; for a package without a
 * `configSchema` the wrapper carries no per-package schemas. Treating that as
 * a pass would let every example through regardless of content.
 */
export function hasConstraints(serialized: unknown): boolean {
  if (!isPlainObject(serialized)) {
    return false;
  }
  const { schemas } = serialized;
  return Array.isArray(schemas) && schemas.length > 0;
}

/**
 * Reduces an error to a line worth printing.
 *
 * Not just the first line: config-loader's TypeScript failures open with the
 * bare header "Invalid TypeScript configuration schema:" and carry the actual
 * diagnostic on the lines after it, and `execFile` failures keep npm's real
 * complaint on `stderr`. Taking only line one turned both into content-free
 * notes, which is what kept the config.d.ts gap invisible.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stderr = errorProperty(error, "stderr");
  const parts = [
    ...error.message.split("\n"),
    ...(typeof stderr === "string" ? stderr.split("\n") : []),
  ]
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (parts.length === 0) {
    return String(error);
  }
  // Enough to identify the failure without pasting a compiler transcript into
  // the table — but say when there is more, rather than truncating silently.
  const shown = parts.slice(0, DIAGNOSTIC_LINES);
  const dropped = parts.length - shown.length;
  return dropped > 0
    ? `${shown.join("; ")} (+${dropped} more)`
    : shown.join("; ");
}

/**
 * Validates one example's content against a package's schema.
 *
 * Two limits worth knowing, both verified against the real compiler:
 *
 * - Undeclared keys are tolerated. Examples legitimately carry RHDH wiring that
 *   belongs to no plugin schema — most of this catalogue's examples contain a
 *   `dynamicPlugins` block and many contain nothing else — so rejecting
 *   undeclared keys would fail them en masse.
 * - config-loader builds Ajv with `coerceTypes: true`, so a scalar that *can*
 *   be coerced passes: `port: "8080"` against a declared number is accepted.
 *   What is caught is non-coercible scalars (`port: "high"`), wrong nesting
 *   (a scalar where an object or array is declared), bad enum values, and
 *   missing required properties.
 *
 * Errors are returned rather than thrown so one bad example cannot abort a run.
 */
export async function validateExample(
  source: SchemaSource,
  pkg: { name: string; version: string },
  label: string,
  content: unknown,
): Promise<SchemaOutcome> {
  const resolved = await source.resolve(pkg.name, pkg.version);
  if (resolved.kind !== "schema") {
    return resolved.kind === "no-schema"
      ? { kind: "no-schema" }
      : { kind: "unavailable", reason: resolved.reason };
  }

  if (!isPlainObject(content)) {
    return {
      kind: "invalid",
      errors: ["app-config content must be a mapping"],
    };
  }

  try {
    resolved.schema.process(
      [{ data: content, context: label }],
      // No visibility filter: an example documents a full app-config, so
      // frontend and backend keys are both legitimate.
      { ignoreSchemaErrors: false },
    );
    return { kind: "ok" };
  } catch (error) {
    return { kind: "invalid", errors: splitSchemaErrors(error) };
  }
}

/**
 * One finding per line.
 *
 * config-loader attaches the individual violations to `error.messages` and also
 * flattens them into a single `message` joined with "; " — so splitting on
 * newlines, as this once did, always yielded one long line. Prefer the
 * structured array and fall back to splitting the flattened form.
 */
export function splitSchemaErrors(error: unknown): string[] {
  if (error instanceof Error) {
    const messages = errorProperty(error, "messages");
    if (Array.isArray(messages) && messages.length > 0) {
      return messages.map(String);
    }
    const flattened = error.message.replace(
      /^Config validation failed,\s*/,
      "",
    );
    const parts = flattened
      .split(/[;\n]/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (parts.length > 0) {
      return parts;
    }
  }
  return [String(error)];
}
