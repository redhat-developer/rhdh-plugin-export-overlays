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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import { loadConfigSchema } from "@backstage/config-loader";
import type { JsonObject } from "@backstage/types";
import { byCodepoint, errorProperty, isPlainObject } from "./json.js";

const execFileAsync = promisify(execFile);

/** What `loadConfigSchema` hands back — named to keep the signatures readable. */
type LoadedSchema = Awaited<ReturnType<typeof loadConfigSchema>>;

/** How many lines of a multi-line diagnostic reach the report. */
const DIAGNOSTIC_LINES = 3;

export type SchemaOutcome =
  | { kind: "ok" }
  | { kind: "invalid"; errors: string[] }
  | { kind: "no-schema" }
  | { kind: "unavailable"; reason: string; patchFailure?: boolean };

/**
 * What the undeclared-key layer made of one example.
 *
 * `ownsSubtree` is not derivable from `findings`: an empty list means "clean"
 * for an example the plugin owns part of, and "there was nothing to look at"
 * for one it does not. Reporting those as the same number would overstate
 * coverage.
 *
 * It says the plugin declares at least one top-level key this example sets —
 * deliberately not "a typo here would have been caught". Strictness only closes
 * nodes that enumerate their properties, so a schema declaring a free-form
 * object, or describing its shape entirely through `$ref`, owns a subtree in
 * which nothing can be found.
 */
export type UndeclaredOutcome = {
  ownsSubtree: boolean;
  findings: string[];
};

/**
 * Marks the one Ajv error class this layer is about.
 *
 * config-loader renders an additional-properties violation with the offending
 * key in its params — `… { additionalProperty=hosst } at /acme`. Pinned by a
 * test, because the whole layer goes quiet if this stops matching.
 */
const UNDECLARED_PROPERTY = /additionalProperty=/;

export type ResolvedSchema =
  | { kind: "schema"; schema: LoadedSchema }
  | { kind: "no-schema" }
  /**
   * `patchFailure` separates a defect in this repo from a fact about the
   * registry. A package that is unpublished or whose config.d.ts needs its
   * dependencies is nobody's bug; a workspace patch that has stopped applying
   * is ours, and is the one thing here worth failing a run over.
   */
  | { kind: "unavailable"; reason: string; patchFailure?: boolean };

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
      return {
        kind: "unavailable",
        reason: describeError(error),
        patchFailure: true,
      };
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
 * `target` is the path the diff writes, prefix and all — `b/…` normally, or the
 * `a/…` pre-image when the post-image is `/dev/null` because the file is being
 * deleted. The prefix stays because the strip level counts its components.
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

    const candidates = splitDiffByFile(patch).filter(
      (section) => (section.target.split("/").pop() ?? "") === schemaFile,
    );
    // The filename is all that ties a section to this package: the directory
    // that would say *which* plugin it belongs to is exactly what the strip
    // level discards. One candidate is unambiguous. Two means the patch touches
    // the same-named schema in two plugins of the same upstream monorepo, and
    // guessing would validate this package against a sibling's schema — so say
    // so instead, and let the caller report it as unavailable.
    if (candidates.length > 1) {
      throw new Error(
        `workspace patch ${basename(patchPath)} rewrites ${schemaFile} for ` +
          `${candidates.length} plugins (${candidates.map((c) => c.target).join(", ")}); ` +
          "cannot tell which belongs to this package",
      );
    }
    for (const section of candidates) {
      await applySection(schemaDir, patchPath, section);
    }
  }
}

/**
 * The `configSchema` file a package declares, relative to its root.
 *
 * Undefined when the field is missing, when it holds an inline schema object
 * rather than a path, or when the path points outside the package. The last one
 * matters because this value comes out of a third-party tarball: `join` resolves
 * `../` rather than rejecting it, so an unchecked `configSchema` would let a
 * published package steer a file write and delete anywhere on the runner.
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
  if (typeof configSchema !== "string" || configSchema === "") {
    return undefined;
  }
  return isInside(packageDir, configSchema) ? configSchema : undefined;
}

/** True when `candidate`, resolved against `root`, stays under it. */
export function isInside(root: string, candidate: string): boolean {
  const target = relative(root, resolve(root, candidate));
  return target !== "" && !target.startsWith("..") && !isAbsolute(target);
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
 *
 * The character class is upstream's verbatim — `[^{}]`, not `[^}]`. It excludes
 * `{` too, so `${A{B}` is *not* a placeholder to Backstage; a looser class here
 * would excuse a schema violation on a value that never gets substituted.
 *
 * Hand-rolled because config-loader keeps `createSubstitutionTransform` out of
 * its public exports (`dist/index.cjs.js` ships only the loaders and sources),
 * and the one public route to it — `FileConfigSource.create({substitutionFunc})`
 * — needs the example on disk. Kept in sync by hand; a test pins the escape.
 */
const PLACEHOLDER = /(?<!\$)\$\{[^{}]*\}/;

/**
 * The same pattern, global, for rewriting every occurrence in one string.
 *
 * Separate from PLACEHOLDER because a global regex carries `lastIndex` state
 * across calls, which `test()` would advance and then start skipping matches.
 */
const PLACEHOLDER_SPANS = /(?<!\$)\$\{[^{}]*\}/g;

/**
 * Values a placeholder might hold once substituted, as far as a schema can tell.
 *
 * Substitution yields a *string* when the variable is set. When it is unset,
 * config-loader's transform returns undefined and applyConfigTransforms drops
 * the key entirely — a fourth runtime shape this list deliberately does not
 * model, because adding "absent" as a candidate would mask genuine
 * missing-required-property findings. The consequence is stated where it bites:
 * a required property behind a placeholder is accepted here and still fails at
 * Backstage startup with the variable unset.
 *
 * Given a string, Ajv's `coerceTypes` decides whether it satisfies a declared
 * boolean or number. "placeholder" stands for the overwhelmingly common case of
 * a plain string field; the rest exist because a declared boolean accepts only
 * "true"/"false" and a declared number only digits. Each is pinned by a test —
 * deleting one used to leave the suite green.
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
 * Returns a copy because it is a pure transform, not because anything downstream
 * mutates — config-loader deep-clones before validating.
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
    // Function form: a `$` in the replacement would otherwise be read as a
    // capture reference. No candidate contains one today; this keeps that from
    // becoming a trap for whoever adds the next.
    return value.replace(PLACEHOLDER_SPANS, () => replacement);
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
  schema: LoadedSchema,
  data: JsonObject,
  label: string,
): string[] | undefined {
  try {
    schema.process(
      // Cloned defensively, not because Ajv mutates: config-loader reads through
      // `Config.getOptional`, which deep-clones first, so the caller's object is
      // never reached. The retry loop below is only correct if every attempt
      // starts from unmodified input, and this is cheap insurance against
      // config-loader ever dropping that clone.
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
      : {
          kind: "unavailable",
          reason: resolved.reason,
          patchFailure: resolved.patchFailure,
        };
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
 * The strict twin of a loaded schema, built once per schema.
 *
 * Derived from the serialized form rather than loaded again from the package:
 * `noUndeclaredProperties` is a post-processing option, and re-reading the
 * package would re-run the TypeScript compiler — by far the most expensive part
 * of a sweep — to arrive at the same document.
 */
const strictSchemas = new WeakMap<
  LoadedSchema,
  Promise<LoadedSchema | undefined>
>();

function strictVariant(
  schema: LoadedSchema,
): Promise<LoadedSchema | undefined> {
  let pending = strictSchemas.get(schema);
  if (!pending) {
    // Cloned because `serialize()` hands out the live `schemas` array rather
    // than a copy, and loadConfigSchema keeps a reference to what it is given —
    // without this the lenient and strict schemas would share one mutable
    // document.
    const document = structuredClone(schema.serialize());
    pending = loadConfigSchema({
      serialized: rejectUndeclaredKeys(document),
      // Undefined rather than a rejection: this layer is advisory, and an
      // unhandled rejection here would escape checkSchemas and lose the
      // structural verdict for every file in the run.
    }).catch(() => undefined);
    strictSchemas.set(schema, pending);
  }
  return pending;
}

/**
 * JSON Schema keywords whose values are themselves schemas.
 *
 * `not` is deliberately absent: tightening a schema inside a negation *loosens*
 * the negation, so closing a node under `not` could manufacture a finding
 * instead of catching one. `if`/`then`/`else`, `contains`, `propertyNames`,
 * `dependentSchemas` and `prefixItems` are absent too — nodes under those are
 * simply never closed, so the layer under-reports there. Under-reporting is the
 * safe direction for an advisory check, and `ts-json-schema-generator` emits
 * none of them from the `config.d.ts` files this catalogue uses.
 */
const SCHEMA_VALUED = ["items", "additionalProperties"] as const;
/** Keywords holding a map of name to schema. */
const SCHEMA_MAPS = [
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
] as const;
/** Keywords holding a list of schemas. */
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf"] as const;

/**
 * Marks every node that enumerates its properties as closed.
 *
 * Deliberately not config-loader's `noUndeclaredProperties`, which closes every
 * subschema stating `type: "object"` whether or not it lists any properties.
 * That breaks unions: given `oneOf: [{required:[a]}, {required:[b]}]` with the
 * properties declared on the parent, closing the branches makes each reject the
 * other's key, and the strict run then reports valid documents as carrying
 * undeclared properties.
 *
 * Closing only nodes that actually enumerate properties leaves union branches
 * alone and still catches a typo among the keys a node does list. Nodes that
 * already declare `additionalProperties` keep whatever the plugin chose.
 *
 * The walk follows JSON Schema keywords rather than descending into every
 * object, so a config key that happens to be named `properties` is not mistaken
 * for a schema node.
 */
export function rejectUndeclaredKeys<T>(document: T): T {
  if (Array.isArray(document)) {
    return document.map(rejectUndeclaredKeys) as T;
  }
  if (!isPlainObject(document)) {
    return document;
  }

  const node: JsonObject = { ...document };

  for (const keyword of SCHEMA_MAPS) {
    const value = node[keyword];
    if (isPlainObject(value)) {
      node[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [
          name,
          rejectUndeclaredKeys(sub),
        ]),
      );
    }
  }
  for (const keyword of SCHEMA_LISTS) {
    const value = node[keyword];
    if (Array.isArray(value)) {
      node[keyword] = value.map(rejectUndeclaredKeys);
    }
  }
  for (const keyword of SCHEMA_VALUED) {
    if (keyword in node) {
      node[keyword] = rejectUndeclaredKeys(node[keyword]);
    }
  }
  // The wrapper config-loader serializes into: each entry's `value` is a schema.
  if (Array.isArray(node.schemas)) {
    node.schemas = node.schemas.map((entry) =>
      isPlainObject(entry) && "value" in entry
        ? { ...entry, value: rejectUndeclaredKeys(entry.value) }
        : entry,
    );
  }

  const { properties } = node;
  if (
    isPlainObject(properties) &&
    Object.keys(properties).length > 0 &&
    !("additionalProperties" in node)
  ) {
    node.additionalProperties = false;
  }
  return node as T;
}

/**
 * The top-level keys a plugin's own schema declares.
 *
 * config-loader's serialized form is a wrapper carrying one entry per package;
 * only this package's is present, because the resolver loads it with
 * `dependencies: []`.
 */
export function declaredTopLevelKeys(serialized: unknown): string[] {
  if (!isPlainObject(serialized) || !Array.isArray(serialized.schemas)) {
    return [];
  }
  const keys = new Set<string>();
  for (const entry of serialized.schemas) {
    if (!isPlainObject(entry) || !isPlainObject(entry.value)) {
      continue;
    }
    const { properties } = entry.value;
    if (isPlainObject(properties)) {
      for (const key of Object.keys(properties)) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort(byCodepoint);
}

/** The part of `content` whose top-level keys the plugin declares. */
export function projectOntoKeys(
  content: JsonObject,
  keys: readonly string[],
): JsonObject {
  const wanted = new Set(keys);
  return Object.fromEntries(
    Object.entries(content).filter(([key]) => wanted.has(key)),
  );
}

/**
 * Keys an example sets that the plugin's schema does not declare, reported only
 * within the subtrees that schema owns (RHIDP-15902).
 *
 * Turning config-loader's `noUndeclaredProperties` on wholesale does not work
 * here. It rejects *every* undeclared top-level key, and an example legitimately
 * carries keys belonging to no plugin schema — the `dynamicPlugins` wrapper, and
 * core Backstage blocks like `catalog`, `backend` and `proxy`. So the example is
 * first projected onto the keys this plugin actually declares; whatever remains
 * is the plugin's own territory, where a key it does not declare is a typo.
 *
 * Findings are the undeclared-property errors the strict schema reports and the
 * lenient one did not. Both halves are needed. Filtering to
 * `additionalProperty=` is what keeps the *label* honest: config-loader injects
 * `additionalProperties: false` into every object-typed subschema, including
 * `anyOf`/`oneOf` branches, which changes which branch a document satisfies —
 * so the strict run also emits `required` and `oneOf` errors about documents
 * that are perfectly valid. Reporting those as undeclared keys would be a
 * flatly false statement. Differencing against the lenient run is what stops a
 * genuine `additionalProperties` violation the plugin's own schema already
 * declares from being counted twice.
 *
 * That filter is a dependency on config-loader's message format, which
 * `splitSchemaErrors` has been caught getting wrong before — so a test pins the
 * wording. If it drifts, that test fails loudly rather than this layer quietly
 * reporting nothing.
 */
export async function findUndeclaredKeys(
  source: SchemaSource,
  pkg: SchemaRequest,
  label: string,
  content: unknown,
): Promise<UndeclaredOutcome> {
  const resolved = await source.resolve(pkg);
  if (resolved.kind !== "schema" || !isPlainObject(content)) {
    return { ownsSubtree: false, findings: [] };
  }

  const declared = declaredTopLevelKeys(resolved.schema.serialize());
  const projected = projectOntoKeys(content, declared);
  if (Object.keys(projected).length === 0) {
    return { ownsSubtree: false, findings: [] };
  }

  const strict = await strictVariant(resolved.schema);
  if (strict === undefined) {
    // The strict compile failed on a document the lenient one accepted. Nothing
    // can be found here, and saying otherwise would overstate the coverage.
    return { ownsSubtree: false, findings: [] };
  }
  const lenientErrors = new Set(
    runSchema(resolved.schema, projected, label) ?? [],
  );
  // Deduplicated: one undeclared key reached through several union branches is
  // one finding, and the raw list repeats it once per branch.
  const strictErrors = new Set(runSchema(strict, projected, label) ?? []);
  return {
    ownsSubtree: true,
    findings: [...strictErrors].filter(
      (error) => UNDECLARED_PROPERTY.test(error) && !lenientErrors.has(error),
    ),
  };
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
