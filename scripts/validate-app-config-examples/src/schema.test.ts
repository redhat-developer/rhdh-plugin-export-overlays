/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// The semantic layer, tested without network access. loadConfigSchema has a
// `serialized` overload that builds a real ConfigSchema in memory, so these
// exercise the actual Backstage validator rather than a stand-in for it.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfigSchema } from "@backstage/config-loader";
import {
  applyConfigSchemaPatches,
  containsPlaceholder,
  describeError,
  findPackageRoot,
  hasConstraints,
  hasPlaceholder,
  isSafePackageSpec,
  splitDiffByFile,
  splitSchemaErrors,
  stripLevelFor,
  substitutePlaceholders,
  validateExample,
  type SchemaSource,
} from "./schema.js";

const PKG = { name: "@scope/plugin", version: "1.0.0" };

/** A source backed by a real in-memory schema — no registry, no tarball. */
async function sourceWithSchema(): Promise<SchemaSource> {
  const schema = await loadConfigSchema({
    serialized: {
      backstageConfigSchemaVersion: 1,
      schemas: [
        {
          path: "plugin/config.d.ts",
          value: {
            type: "object",
            properties: {
              acme: {
                type: "object",
                required: ["baseUrl"],
                properties: {
                  baseUrl: { type: "string" },
                  retries: { type: "number" },
                  hosts: { type: "array", items: { type: "string" } },
                  mode: { type: "string", enum: ["fast", "slow"] },
                },
              },
            },
          },
        },
      ],
    },
  });
  return { resolve: async () => ({ kind: "schema", schema }) };
}

describe("validateExample", () => {
  it("accepts an example that satisfies the schema", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      { acme: { baseUrl: "https://example.test", retries: 3 } },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it("rejects wrong nesting on a declared key", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      {
        acme: { baseUrl: "https://example.test", hosts: "not-a-list" },
      },
    );
    assert.equal(outcome.kind, "invalid");
    assert.equal(outcome.kind === "invalid" && outcome.errors.length, 1);
    assert.match(
      outcome.kind === "invalid" ? outcome.errors[0] : "",
      /must be array .* at \/acme\/hosts/,
    );
  });

  it("rejects a missing required property", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      {
        acme: { retries: 1 },
      },
    );
    assert.equal(outcome.kind, "invalid");
    assert.match(
      outcome.kind === "invalid" ? outcome.errors.join(" ") : "",
      /baseUrl/,
    );
  });

  it("rejects a value outside a declared enum", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      {
        acme: { baseUrl: "x", mode: "sideways" },
      },
    );
    assert.equal(outcome.kind, "invalid");
  });

  it('accepts a coercible scalar — Ajv runs with coerceTypes, so "3" passes for a number', async () => {
    // Pins a real limit of the check rather than an aspiration: this is why the
    // docs promise non-coercible scalars, not all type mismatches.
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      {
        acme: { baseUrl: "x", retries: "3" },
      },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it("rejects a scalar that cannot be coerced to the declared type", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      {
        acme: { baseUrl: "x", retries: "many" },
      },
    );
    assert.equal(outcome.kind, "invalid");
  });

  it("tolerates undeclared keys — examples carry RHDH wiring no plugin schema owns", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      {
        dynamicPlugins: { frontend: {} },
      },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it("reports non-mapping content as invalid rather than throwing", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      ["a"],
    );
    assert.deepEqual(outcome, {
      kind: "invalid",
      errors: ["app-config content must be a mapping"],
    });
  });

  it("passes a no-schema resolution straight through, without inspecting content", async () => {
    const source: SchemaSource = {
      resolve: async () => ({ kind: "no-schema" }),
    };
    assert.deepEqual(await validateExample(source, PKG, "label", "garbage"), {
      kind: "no-schema",
    });
  });

  it("passes an unavailable resolution through with its reason intact", async () => {
    const source: SchemaSource = {
      resolve: async () => ({ kind: "unavailable", reason: "HTTP 404" }),
    };
    assert.deepEqual(await validateExample(source, PKG, "label", "garbage"), {
      kind: "unavailable",
      reason: "HTTP 404",
    });
  });
});

describe("hasPlaceholder", () => {
  it("matches a substitution", () => {
    assert.equal(hasPlaceholder("${SEGMENT_TEST_MODE}"), true);
    assert.equal(hasPlaceholder("https://${HOST}/api"), true);
  });

  it("does not match plain text or a bare dollar", () => {
    assert.equal(hasPlaceholder("true"), false);
    assert.equal(hasPlaceholder("$HOME"), false);
    assert.equal(hasPlaceholder("costs $5 {maybe}"), false);
  });

  it("does not match Backstage's $${ escape for a literal brace", () => {
    assert.equal(hasPlaceholder("$${NOT_SUBSTITUTED}"), false);
  });
});

describe("containsPlaceholder", () => {
  it("finds a placeholder at any depth, including inside arrays", () => {
    assert.equal(containsPlaceholder({ a: { b: ["x", "${TOKEN}"] } }), true);
  });

  it("is false for a document with no placeholder", () => {
    assert.equal(
      containsPlaceholder({ a: { b: ["x"] }, n: 1, t: true }),
      false,
    );
  });
});

describe("substitutePlaceholders", () => {
  it("replaces placeholder leaves and leaves everything else alone", () => {
    assert.deepEqual(
      substitutePlaceholders(
        { keep: "plain", swap: "${A}", nested: { list: ["${B}", 7, false] } },
        "true",
      ),
      { keep: "plain", swap: "true", nested: { list: ["true", 7, false] } },
    );
  });

  it("replaces only the placeholder span within a longer string", () => {
    assert.deepEqual(
      substitutePlaceholders(
        { url: "https://${HOST}/api", both: "${A}-${B}" },
        "x",
      ),
      { url: "https://x/api", both: "x-x" },
    );
  });

  it("leaves an escaped $${ alone", () => {
    assert.deepEqual(substitutePlaceholders({ a: "$${KEEP}" }, "x"), {
      a: "$${KEEP}",
    });
  });

  it("does not modify the input", () => {
    const original = { swap: "${A}" };
    substitutePlaceholders(original, "true");
    assert.deepEqual(original, { swap: "${A}" });
  });
});

/**
 * A schema shaped like `@backstage-community/plugin-analytics-provider-segment`:
 * a union discriminated on a *literal* boolean, which no `${...}` text can
 * satisfy before substitution.
 */
async function sourceWithBooleanLiteralUnion(): Promise<SchemaSource> {
  const schema = await loadConfigSchema({
    serialized: {
      backstageConfigSchemaVersion: 1,
      schemas: [
        {
          path: "plugin/config.d.ts",
          value: {
            type: "object",
            properties: {
              acme: {
                type: "object",
                properties: {
                  segment: {
                    anyOf: [
                      {
                        type: "object",
                        required: ["testMode"],
                        properties: {
                          writeKey: { type: "string" },
                          testMode: { type: "boolean", enum: [true] },
                        },
                      },
                      {
                        type: "object",
                        required: ["writeKey"],
                        properties: {
                          writeKey: { type: "string" },
                          testMode: { type: "boolean", enum: [false] },
                        },
                      },
                    ],
                  },
                  home: { type: "object", properties: {} },
                },
              },
            },
          },
        },
      ],
    },
  });
  return { resolve: async () => ({ kind: "schema", schema }) };
}

/** A schema whose one field constrains the *shape* of the string, not just its type. */
async function sourceWithPattern(): Promise<SchemaSource> {
  const schema = await loadConfigSchema({
    serialized: {
      backstageConfigSchemaVersion: 1,
      schemas: [
        {
          path: "plugin/config.d.ts",
          value: {
            type: "object",
            properties: {
              acme: {
                type: "object",
                properties: {
                  url: { type: "string", pattern: "^https://[a-z.]+/api$" },
                },
              },
            },
          },
        },
      ],
    },
  });
  return { resolve: async () => ({ kind: "schema", schema }) };
}

describe("validateExample with environment placeholders", () => {
  it("accepts a placeholder on a field declaring a boolean literal", async () => {
    // The RHIDP-15903 segment finding. Backstage substitutes before it
    // validates, so the raw `${...}` text never reaches a schema at runtime.
    const outcome = await validateExample(
      await sourceWithBooleanLiteralUnion(),
      PKG,
      "label",
      { acme: { segment: { writeKey: "${KEY}", testMode: "${TEST_MODE}" } } },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it("accepts a placeholder on a declared string", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      { acme: { baseUrl: "${BASE_URL}" } },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it("accepts a placeholder on a declared number", async () => {
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      { acme: { baseUrl: "x", retries: "${RETRIES}" } },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it("still reports a placeholder where an object is declared", async () => {
    // Substitution can only ever yield a string, so this one is a genuine
    // defect however the variable is set — the leniency must not swallow it.
    const outcome = await validateExample(
      await sourceWithBooleanLiteralUnion(),
      PKG,
      "label",
      { acme: { segment: { writeKey: "k" }, home: "${HOME_PAGE}" } },
    );
    assert.equal(outcome.kind, "invalid");
    assert.match(
      outcome.kind === "invalid" ? outcome.errors.join(" ") : "",
      /must be object .* at \/acme\/home/,
    );
  });

  it("still reports a structural mismatch that has nothing to do with placeholders", async () => {
    // The RHIDP-15903 dynatrace finding in miniature: every leaf is a
    // placeholder, but the shape is wrong whatever they hold.
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      { acme: { baseUrl: "${URL}", hosts: "${HOSTS}" } },
    );
    assert.equal(outcome.kind, "invalid");
    assert.match(
      outcome.kind === "invalid" ? outcome.errors.join(" ") : "",
      /must be array .* at \/acme\/hosts/,
    );
  });

  it("reports the as-is errors, naming the text the maintainer will edit", async () => {
    // `retries` holds a placeholder, so every retry clears its error while
    // `hosts` keeps failing. Reporting a retry's errors would therefore lose
    // the /acme/retries line — its presence is what proves the untouched
    // document is the one being reported.
    const outcome = await validateExample(
      await sourceWithSchema(),
      PKG,
      "label",
      { acme: { baseUrl: "x", retries: "${RETRIES}", hosts: "nope" } },
    );
    assert.equal(outcome.kind, "invalid");
    // As-is yields two errors; the "0" retry would yield only /acme/hosts, so
    // the count is what makes this fail on the regression it guards.
    assert.equal(outcome.kind === "invalid" && outcome.errors.length, 2);
    assert.match(
      outcome.kind === "invalid" ? outcome.errors.join(" ") : "",
      /at \/acme\/retries/,
    );
  });

  it("substitutes the placeholder span, keeping the rest of the string", async () => {
    // Replacing the whole value would hand the schema a bare "placeholder" and
    // lose the shape a pattern constrains.
    const source = await sourceWithPattern();
    const outcome = await validateExample(source, PKG, "label", {
      acme: { url: "https://${HOST}/api" },
    });
    assert.deepEqual(outcome, { kind: "ok" });
  });
});

describe("hasConstraints", () => {
  it("is false for a schema document that constrains nothing", async () => {
    const empty = await loadConfigSchema({
      serialized: { backstageConfigSchemaVersion: 1, schemas: [] },
    });
    assert.equal(hasConstraints(empty.serialize()), false);
  });

  it("is true once a schema is present", async () => {
    const schema = await sourceWithSchema();
    const resolved = await schema.resolve(PKG);
    assert.equal(resolved.kind, "schema");
    assert.equal(
      hasConstraints(
        resolved.kind === "schema" ? resolved.schema.serialize() : undefined,
      ),
      true,
    );
  });

  it("is false for values that are not schema documents", () => {
    assert.equal(hasConstraints(null), false);
    assert.equal(hasConstraints([]), false);
    assert.equal(hasConstraints("nope"), false);
  });
});

describe("splitSchemaErrors", () => {
  it("reports one finding per violation using the structured messages", () => {
    const error = Object.assign(new Error("Config validation failed, a; b"), {
      messages: ["a", "b"],
    });
    assert.deepEqual(splitSchemaErrors(error), ["a", "b"]);
  });

  it("splits the flattened message when no structured messages are attached", () => {
    // config-loader joins violations with "; " into one line, so splitting on
    // newlines — as this once did — always yielded a single wall of text.
    const error = new Error(
      "Config validation failed, must be number at /a; must be boolean at /b",
    );
    assert.deepEqual(splitSchemaErrors(error), [
      "must be number at /a",
      "must be boolean at /b",
    ]);
  });

  it("falls back to the raw value for anything else", () => {
    assert.deepEqual(splitSchemaErrors("boom"), ["boom"]);
  });
});

describe("describeError", () => {
  it("keeps the diagnostic that follows the headline", () => {
    // The TypeScript failure opens with a bare header; taking only the first
    // line reduced the whole note to "Invalid TypeScript configuration schema:".
    const error = new Error(
      "Invalid TypeScript configuration schema:\nconfig.d.ts(17,67): error TS2307: Cannot find module",
    );
    const described = describeError(error);
    assert.match(described, /TS2307/);
  });

  it("includes stderr for exec failures, where npm puts the real complaint", () => {
    const error = Object.assign(new Error("Command failed: npm pack"), {
      stderr: "npm error code E404\nnpm error 404 Not Found",
    });
    assert.match(describeError(error), /E404/);
  });

  it("stringifies non-errors", () => {
    assert.equal(describeError("plain"), "plain");
  });
});

describe("isSafePackageSpec", () => {
  it("accepts ordinary scoped and unscoped names", () => {
    assert.equal(isSafePackageSpec("@scope/plugin-name", "1.2.3"), true);
    assert.equal(isSafePackageSpec("plugin", "0.1.0-rc.1"), true);
  });

  it("rejects a name npm would read as a flag", () => {
    // Metadata comes from fork pull requests, and this value becomes argv for
    // `npm pack` — a leading dash could redirect the fetch to another registry.
    assert.equal(
      isSafePackageSpec("--registry=http://evil.test", "1.0.0"),
      false,
    );
    assert.equal(isSafePackageSpec("-rf", "1.0.0"), false);
  });

  it("rejects a version that is not version-shaped", () => {
    assert.equal(isSafePackageSpec("plugin", "--force"), false);
    assert.equal(isSafePackageSpec("plugin", "latest"), false);
  });
});

describe("findPackageRoot", () => {
  it("prefers the conventional package/ directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "find-root-"));
    try {
      await mkdir(join(dir, "package"));
      await writeFile(join(dir, "package", "package.json"), "{}");
      await mkdir(join(dir, "other"));
      await writeFile(join(dir, "other", "package.json"), "{}");
      assert.equal(await findPackageRoot(dir, "spec"), join(dir, "package"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly when nothing unpacked looks like a package", async () => {
    // Choosing wrong here is invisible downstream: config-loader skips a
    // missing path and returns an empty schema, which reads as "no configSchema"
    // and lets every example pass vacuously.
    const dir = await mkdtemp(join(tmpdir(), "find-root-"));
    try {
      await mkdir(join(dir, "not-a-package"));
      await assert.rejects(
        () => findPackageRoot(dir, "spec"),
        /no unpacked package/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("splitDiffByFile", () => {
  const patch = [
    "diff --git a/plugins/dql-backend/config.d.ts b/plugins/dql-backend/config.d.ts",
    "index 403d30a..1334dc1 100644",
    "--- a/plugins/dql-backend/config.d.ts",
    "+++ b/plugins/dql-backend/config.d.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/plugins/dql-backend/index.ts b/plugins/dql-backend/index.ts",
    "--- a/plugins/dql-backend/index.ts",
    "+++ b/plugins/dql-backend/index.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");

  it("returns one section per target file, with the post-image path", () => {
    const sections = splitDiffByFile(patch);
    assert.deepEqual(
      sections.map((section) => section.target),
      ["b/plugins/dql-backend/config.d.ts", "b/plugins/dql-backend/index.ts"],
    );
  });

  it("keeps each section's hunks with it", () => {
    const [first] = splitDiffByFile(patch);
    assert.match(first.body, /\+new/);
    assert.ok(!first.body.includes("+b\n"));
  });

  it("returns nothing for a diff with no git header, rather than guessing", () => {
    // A headerless diff leaves the strip level unknowable, and applying a hunk
    // at a guessed level is worse than not applying it.
    assert.deepEqual(
      splitDiffByFile("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"),
      [],
    );
  });
});

describe("stripLevelFor", () => {
  it("strips down to the bare filename", () => {
    assert.equal(stripLevelFor("b/plugins/dql-backend/config.d.ts"), 3);
    assert.equal(stripLevelFor("b/config.d.ts"), 1);
  });
});

describe("applyConfigSchemaPatches", () => {
  /** A package directory holding one config.d.ts with `body`. */
  async function packageWith(
    body: string,
    // Null rather than undefined: passing `undefined` explicitly would trigger
    // the default and quietly test the opposite of what the caller asked for.
    configSchema: string | null = "config.d.ts",
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "patch-apply-"));
    await writeFile(join(dir, "config.d.ts"), body);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(configSchema === null ? {} : { configSchema }),
    );
    return dir;
  }

  /** A patch file rewriting config.d.ts from `from` to `to`. */
  async function patchFile(
    dir: string,
    target: string,
    from: string,
    to: string,
  ): Promise<string> {
    const path = join(dir, "1-rewrite.patch");
    await writeFile(
      path,
      [
        `diff --git a/${target} b/${target}`,
        `--- a/${target}`,
        `+++ b/${target}`,
        "@@ -1 +1 @@",
        `-${from}`,
        `+${to}`,
        "",
      ].join("\n"),
    );
    return path;
  }

  it("rewrites the package's config.d.ts the way the export does", async () => {
    const dir = await packageWith("export type Config = { a: string };\n");
    try {
      const patch = await patchFile(
        dir,
        "plugins/dql-backend/config.d.ts",
        "export type Config = { a: string };",
        "export type Config = { a: number };",
      );
      await applyConfigSchemaPatches(dir, [patch]);
      assert.equal(
        await readFile(join(dir, "config.d.ts"), "utf8"),
        "export type Config = { a: number };\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a package that declares no configSchema alone", async () => {
    // A workspace's patches cover its whole upstream monorepo, so most of them
    // name files a given package does not contain. Treating that as a failure
    // turned dynatrace-dql's frontend from "no configSchema" into "unavailable".
    const original = "export type Config = { a: string };\n";
    const dir = await packageWith(original, null);
    try {
      const patch = await patchFile(
        dir,
        "plugins/dql-backend/config.d.ts",
        "export type Config = { a: string };",
        "export type Config = { a: number };",
      );
      await applyConfigSchemaPatches(dir, [patch]);
      assert.equal(await readFile(join(dir, "config.d.ts"), "utf8"), original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the package alone for a patch that touches no config schema", async () => {
    const original = "export type Config = { a: string };\n";
    const dir = await packageWith(original);
    try {
      const patch = await patchFile(dir, "plugins/x/index.ts", "a", "b");
      await applyConfigSchemaPatches(dir, [patch]);
      assert.equal(await readFile(join(dir, "config.d.ts"), "utf8"), original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when a config schema patch does not apply", async () => {
    // The caller turns this into `unavailable`. Falling back to the unpatched
    // schema would resurrect exactly the mismatch the patch exists to fix.
    const dir = await packageWith("something else entirely\n");
    try {
      const patch = await patchFile(
        dir,
        "plugins/dql-backend/config.d.ts",
        "export type Config = { a: string };",
        "export type Config = { a: number };",
      );
      await assert.rejects(
        () => applyConfigSchemaPatches(dir, [patch]),
        /does not apply/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when the workspace has no patches", async () => {
    const original = "export type Config = { a: string };\n";
    const dir = await packageWith(original);
    try {
      await applyConfigSchemaPatches(dir, []);
      assert.equal(await readFile(join(dir, "config.d.ts"), "utf8"), original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("splitDiffByFile with added and removed files", () => {
  it("uses the pre-image path when the file is deleted", () => {
    // `+++ /dev/null` would otherwise read as a target named "null" and be
    // skipped, leaving the validator reading a file the export removes.
    const sections = splitDiffByFile(
      [
        "diff --git a/plugins/x/config.d.ts b/plugins/x/config.d.ts",
        "--- a/plugins/x/config.d.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
      ].join("\n"),
    );
    assert.deepEqual(
      sections.map((section) => section.target),
      ["a/plugins/x/config.d.ts"],
    );
  });

  it("uses the post-image path when the file is added", () => {
    const sections = splitDiffByFile(
      [
        "diff --git a/plugins/x/config.d.ts b/plugins/x/config.d.ts",
        "--- /dev/null",
        "+++ b/plugins/x/config.d.ts",
        "@@ -0,0 +1 @@",
        "+added",
      ].join("\n"),
    );
    assert.deepEqual(
      sections.map((section) => section.target),
      ["b/plugins/x/config.d.ts"],
    );
  });
});
