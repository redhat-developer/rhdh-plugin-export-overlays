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
// metadata already pins `packageName` + `version`, and it needs no cross-repo
// SHA resolution.
//
// That tarball is not quite what RHDH installs, though. This repo exports a
// patched build — `workspaces/<ws>/patches/*.patch` is applied to the source
// before packaging — and one of those patches rewrites a plugin's `config.d.ts`.
// So the resolver replays the config schema patches onto the extracted tarball
// before loading it; without that, `dynatrace-dql` reports a mismatch against a
// schema its own overlay already fixed. See applyConfigSchemaPatches.
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
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadConfigSchema } from "@backstage/config-loader";
import type { JsonObject } from "@backstage/types";
import { byCodepoint, errorProperty, isPlainObject } from "./json.js";

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
 * Which schema to load, and what this repo does to it before shipping.
 *
 * `patches` carries the workspace's `patches/*.patch` files. They matter
 * because a few of them rewrite the plugin's own `config.d.ts`, so the schema
 * in the published tarball is not the schema in the artifact RHDH installs —
 * see applyConfigSchemaPatches.
 */
export type SchemaRequest = {
  name: string;
  version: string;
  patches?: readonly string[];
};

/**
 * Where `validateExample` gets a schema from.
 *
 * Declared structurally rather than as the concrete class so tests can supply
 * an in-memory schema built with `loadConfigSchema({ serialized })` — the class
 * has private fields, which would make a fake fail to type-check.
 */
export type SchemaSource = {
  resolve(request: SchemaRequest): Promise<ResolvedSchema>;
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

  async resolve({
    name,
    version,
    patches = [],
  }: SchemaRequest): Promise<ResolvedSchema> {
    if (!isSafePackageSpec(name, version)) {
      return {
        kind: "unavailable",
        reason: `refusing to fetch unsafe package spec ${name}@${version}`,
      };
    }
    const spec = `${name}@${version}`;
    // The patch list joins the key because it changes the schema that comes
    // out: two workspaces pinning the same package can patch it differently.
    const key = [spec, ...patches].join("|");
    let pending = this.cache.get(key);
    if (!pending) {
      // Catch before caching: a rejected promise stored here would be re-thrown
      // for every later file with the same package, escaping validateExample
      // and aborting the whole run instead of failing one row.
      pending = this.load(spec, patches).catch((error) => ({
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

  private async load(
    spec: string,
    patches: readonly string[],
  ): Promise<ResolvedSchema> {
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
      await applyConfigSchemaPatches(packageDir, patches);
    } catch (error) {
      // Reported rather than validated against the unpatched schema: this repo
      // patches config.d.ts precisely where the published one is wrong, so
      // falling back to it would resurrect the mismatch the patch exists to fix.
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

/** What a unified diff writes in place of a path when a file is added or removed. */
const DEV_NULL = "/dev/null";

/**
 * One target file's slice of a unified diff.
 *
 * `target` is the post-image path exactly as the diff writes it, `b/` prefix
 * and all, because the strip level is derived from counting its components.
 */
export type DiffSection = { target: string; body: string };

/**
 * Splits a git-style unified diff into one section per target file.
 *
 * Only `diff --git` headers start a section. Patches in this repo are all
 * git-generated, and a headerless diff would leave the strip level a guess —
 * better to see no config-schema sections and leave the tarball alone than to
 * apply a hunk at a level nobody verified.
 */
export function splitDiffByFile(patch: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let lines: string[] = [];
  let source: string | undefined;
  let target: string | undefined;

  const flush = (): void => {
    // A deletion writes `+++ /dev/null`, so the pre-image path is the only
    // place the filename survives. Falling back to it keeps a patch that
    // removes a config schema from being silently skipped — and skipping it
    // would leave the validator reading a file the export does not ship.
    const path = target === DEV_NULL ? source : target;
    if (path !== undefined && path !== DEV_NULL && lines.length > 0) {
      sections.push({ target: path, body: `${lines.join("\n")}\n` });
    }
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      lines = [line];
      source = undefined;
      target = undefined;
      continue;
    }
    if (lines.length === 0) {
      continue;
    }
    lines.push(line);
    if (line.startsWith("--- ") && source === undefined) {
      source = line.slice("--- ".length).trim();
    }
    if (line.startsWith("+++ ") && target === undefined) {
      target = line.slice("+++ ".length).trim();
    }
  }
  flush();
  return sections;
}

/**
 * How many leading path components `git apply` must strip to leave a bare
 * filename, so a hunk written against the upstream repo layout
 * (`b/plugins/dql-backend/config.d.ts`) lands on the tarball's `config.d.ts`.
 */
export function stripLevelFor(target: string): number {
  return target.split("/").length - 1;
}

/**
 * Rewrites the extracted package with the workspace's config schema patches.
 *
 * The validator reads the *published* tarball, but this repo exports a patched
 * build: a workspace's `patches` directory is applied to the source before
 * packaging. Where a patch touches `config.d.ts`, the published schema is not
 * the schema RHDH ends up enforcing — `workspaces/dynatrace-dql` patches a
 * union-precedence bug that makes the published schema reject a config the
 * exported artifact accepts. Validating against the published copy would report
 * a mismatch in metadata that is correct.
 *
 * Throws when a config schema patch does not apply, so the caller reports the
 * package as unavailable rather than silently falling back to a schema known to
 * differ from what ships.
 */
export async function applyConfigSchemaPatches(
  packageDir: string,
  patches: readonly string[],
): Promise<void> {
  const schemaPath = await declaredConfigSchemaPath(packageDir);
  // No `configSchema` file means nothing here can be patched, and a workspace's
  // patches cover its whole upstream monorepo — most of them belong to sibling
  // packages. Without this, `dynatrace-dql`'s frontend package went from
  // "declares no configSchema" to "unavailable" because its sibling's patch
  // named a file it does not contain.
  if (schemaPath === undefined) {
    return;
  }
  const schemaDir = join(packageDir, dirname(schemaPath));
  const schemaFile = basename(schemaPath);

  // Sorted because the numbered filename prefix is how this repo orders patch
  // application, and a later patch may build on an earlier one's result.
  for (const patchPath of [...patches].sort(byCodepoint)) {
    let patch: string;
    try {
      patch = await readFile(patchPath, "utf8");
    } catch (error) {
      throw new Error(`cannot read patch ${patchPath}`, { cause: error });
    }

    for (const section of splitDiffByFile(patch)) {
      if ((section.target.split("/").pop() ?? "") !== schemaFile) {
        continue;
      }
      await applySection(schemaDir, patchPath, section);
    }
  }
}

/**
 * The `configSchema` file a package declares, relative to its root.
 *
 * Undefined when the field is missing, or when it holds an inline schema object
 * rather than a path — in both cases there is no file for a patch to rewrite.
 */
export async function declaredConfigSchemaPath(
  packageDir: string,
): Promise<string | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
  if (!isPlainObject(manifest)) {
    return undefined;
  }
  const { configSchema } = manifest;
  // Any path the package names, not a fixed list: config.d.ts and
  // config.schema.json are the two forms in this catalogue today, but the file
  // worth patching is whichever one config-loader will read.
  return typeof configSchema === "string" && configSchema !== ""
    ? configSchema
    : undefined;
}

/** Applies one diff section to the directory holding the schema file. */
async function applySection(
  schemaDir: string,
  patchPath: string,
  section: DiffSection,
): Promise<void> {
  const sectionFile = join(schemaDir, ".config-schema-patch.diff");
  try {
    await writeFile(sectionFile, section.body, "utf8");
    await execFileAsync(
      "git",
      ["apply", `-p${stripLevelFor(section.target)}`, sectionFile],
      { cwd: schemaDir },
    );
  } catch (error) {
    throw new Error(
      `workspace patch ${basename(patchPath)} does not apply to ${section.target}: ${describeError(error)}`,
      { cause: error },
    );
  } finally {
    // config-loader walks the package directory, so the scratch file does not
    // outlive the one apply it exists for.
    await rm(sectionFile, { force: true });
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
 * Matches an environment placeholder Backstage would have substituted away
 * before any schema saw the value.
 *
 * `$${` is Backstage's escape for a literal `${`, so a `$` immediately before
 * the brace means the author wanted the text and not a substitution.
 */
const PLACEHOLDER = /(?<!\$)\$\{[^}]*\}/;

/**
 * The same pattern, global, for rewriting every occurrence in one string.
 *
 * Separate from PLACEHOLDER because a global regex carries `lastIndex` state
 * across calls, which `test()` would advance and then start skipping matches.
 */
const PLACEHOLDER_SPANS = /(?<!\$)\$\{[^}]*\}/g;

/**
 * Values a placeholder might hold once substituted, as far as a schema can tell.
 *
 * Substitution yields a *string* — the environment has no other type — so these
 * are all strings, and Ajv's `coerceTypes` decides whether one satisfies a
 * declared boolean or number. "placeholder" stands for the overwhelmingly
 * common case of a plain string field; the rest exist because a declared
 * boolean accepts only "true"/"false" and a declared number only digits.
 */
const PLACEHOLDER_VALUES = ["placeholder", "true", "false", "0"];

/** True when substitution would rewrite this string. */
export function hasPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

/**
 * True when any leaf anywhere under `value` is a placeholder string.
 *
 * Deliberately a second walk rather than something `substitutePlaceholders`
 * could report on the way past: this one short-circuits on the first hit, and
 * it runs on every failing example to decide whether retrying is worth it at
 * all. Worth collapsing only if a third traversal ever appears.
 */
export function containsPlaceholder(value: unknown): boolean {
  if (typeof value === "string") {
    return hasPlaceholder(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsPlaceholder);
  }
  if (isPlainObject(value)) {
    return Object.values(value).some(containsPlaceholder);
  }
  return false;
}

/**
 * Deep copy of `value` with every placeholder *span* replaced by `replacement`.
 *
 * Spans, not whole strings: `url: "https://${HOST}/api"` substitutes to
 * `https://<something>/api`, so replacing the whole value would hand the schema
 * a bare `placeholder` and lose the shape a `pattern` or `format` constrains.
 *
 * Returns a copy rather than editing in place so a caller's example is never
 * left rewritten.
 */
export function substitutePlaceholders(
  value: JsonObject,
  replacement: string,
): JsonObject;
export function substitutePlaceholders(
  value: unknown,
  replacement: string,
): unknown;
export function substitutePlaceholders(
  value: unknown,
  replacement: string,
): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER_SPANS, replacement);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitutePlaceholders(item, replacement));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substitutePlaceholders(item, replacement),
      ]),
    );
  }
  return value;
}

/** Runs the schema over one document. Returns the errors, or undefined if clean. */
function runSchema(
  schema: Awaited<ReturnType<typeof loadConfigSchema>>,
  data: JsonObject,
  label: string,
): string[] | undefined {
  try {
    schema.process(
      // Cloned because config-loader builds Ajv with `coerceTypes`, which
      // rewrites the data it validates — so every attempt starts from the
      // document as written rather than from what the last one left behind.
      [{ data: structuredClone(data), context: label }],
      // No visibility filter: an example documents a full app-config, so
      // frontend and backend keys are both legitimate.
      { ignoreSchemaErrors: false },
    );
    return undefined;
  } catch (error) {
    return splitSchemaErrors(error);
  }
}

/**
 * Validates one example's content against a package's schema.
 *
 * Environment placeholders are the wrinkle. An example writes
 * `testMode: ${SEGMENT_TEST_MODE}`, and Backstage substitutes that before it
 * validates anything — so checking the literal `${...}` text against a declared
 * boolean rejects a value that never reaches a schema in that form. What
 * substitution produces is always a *string*, so an example is accepted when
 * some string assignment to its placeholders satisfies the schema. Only the
 * as-is errors are reported, since those name the text a maintainer will edit.
 *
 * Three limits worth knowing, all verified against the real compiler:
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
 * - The placeholder leniency is candidate-based, not schema-directed, so it
 *   only stretches as far as PLACEHOLDER_VALUES reaches. Four kinds of field
 *   still report despite some real environment value satisfying them: a
 *   declared `enum` (no candidate is a member), a numeric `minimum`/`maximum`
 *   that "0" falls outside, a `pattern` the candidate text does not match, and
 *   placeholders sitting on fields of *different* declared types at once, since
 *   substitution is uniform per attempt rather than a search over combinations.
 *   No example in this catalogue hits any of them today. The failure direction
 *   is a visible false positive naming the exact path, never a silent pass —
 *   and closing them means seeding candidates from the failing path's schema.
 *
 * Errors are returned rather than thrown so one bad example cannot abort a run.
 */
export async function validateExample(
  source: SchemaSource,
  pkg: SchemaRequest,
  label: string,
  content: unknown,
): Promise<SchemaOutcome> {
  const resolved = await source.resolve(pkg);
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

  const errors = runSchema(resolved.schema, content, label);
  if (errors === undefined) {
    return { kind: "ok" };
  }

  if (containsPlaceholder(content)) {
    for (const value of PLACEHOLDER_VALUES) {
      const substituted = substitutePlaceholders(content, value);
      if (runSchema(resolved.schema, substituted, label) === undefined) {
        return { kind: "ok" };
      }
    }
  }

  return { kind: "invalid", errors };
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
