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
import type { JsonObject } from "@backstage/types";
import {
  applyConfigSchemaPatches,
  containsPlaceholder,
  declaredConfigSchemaPath,
  declaredTopLevelKeys,
  describeError,
  findPackageRoot,
  findUndeclaredKeys,
  hasConstraints,
  hasPlaceholder,
  isInside,
  isSafePackageSpec,
  projectOntoKeys,
  rejectUndeclaredKeys,
  splitDiffByFile,
  splitSchemaErrors,
  stripLevelFor,
  substitutePlaceholders,
  validateExample,
  type SchemaSource,
} from "./schema.js";

const PKG = { name: "@scope/plugin", version: "1.0.0" };

/** A source backed by a real in-memory schema built from `properties`. */
async function sourceFor(properties: JsonObject) {
  const schema = await loadConfigSchema({
    serialized: {
      backstageConfigSchemaVersion: 1,
      schemas: [
        {
          path: "plugin/config.d.ts",
          value: { type: "object", properties },
        },
      ],
    },
  });
  return { resolve: async () => ({ kind: "schema" as const, schema }) };
}

/** The errors of an invalid outcome, or [] — keeps the narrowing out of assertions. */
function errorsOf(outcome: { kind: string; errors?: string[] }): string[] {
  return outcome.kind === "invalid" ? (outcome.errors ?? []) : [];
}

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
      patchFailure: undefined,
    });
  });

  it("carries the patch-failure flag through, so the caller can fail on it", async () => {
    // A registry miss is nobody's bug; a workspace patch that stopped applying
    // is this repo's, and is the one unavailable reason worth failing over.
    const source: SchemaSource = {
      resolve: async () => ({
        kind: "unavailable",
        reason: "patch does not apply",
        patchFailure: true,
      }),
    };
    assert.deepEqual(await validateExample(source, PKG, "label", {}), {
      kind: "unavailable",
      reason: "patch does not apply",
      patchFailure: true,
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

  it("reports the as-is errors, not a retry's", async () => {
    // Three defects, each cleared by a different subset of the candidates:
    // baseUrl's pattern rejects "0", retries accepts only "0", hosts is wrong
    // whatever the variables hold. Every retry therefore yields two errors and
    // only the as-is run yields three, so the count is what discriminates —
    // no assertion on error *text* can, since config-loader never echoes the
    // offending value.
    const outcome = await validateExample(
      await sourceFor({
        acme: {
          type: "object",
          properties: {
            baseUrl: { type: "string", pattern: "^[a-z]+$" },
            retries: { type: "number" },
            hosts: { type: "array", items: { type: "string" } },
          },
        },
      }),
      PKG,
      "label",
      {
        acme: { baseUrl: "${BASE_URL}", retries: "${RETRIES}", hosts: "nope" },
      },
    );
    const errors = errorsOf(outcome);
    assert.equal(errors.length, 3, `got: ${errors.join(" | ")}`);
    for (const path of ["/acme/baseUrl", "/acme/retries", "/acme/hosts"]) {
      assert.ok(
        errors.some((error) => error.includes(`at ${path}`)),
        `expected an error at ${path}, got: ${errors.join(" | ")}`,
      );
    }
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

describe("declaredTopLevelKeys", () => {
  it("collects the properties a schema declares", async () => {
    const source = await sourceWithSchema();
    const resolved = await source.resolve(PKG);
    assert.equal(resolved.kind, "schema");
    assert.deepEqual(
      resolved.kind === "schema"
        ? declaredTopLevelKeys(resolved.schema.serialize())
        : [],
      ["acme"],
    );
  });

  it("is empty for anything that is not a serialized schema", () => {
    assert.deepEqual(declaredTopLevelKeys(undefined), []);
    assert.deepEqual(declaredTopLevelKeys({ schemas: "nope" }), []);
    assert.deepEqual(declaredTopLevelKeys({ schemas: [] }), []);
  });
});

describe("projectOntoKeys", () => {
  it("keeps only the declared keys", () => {
    assert.deepEqual(
      projectOntoKeys({ acme: { a: 1 }, dynamicPlugins: {}, proxy: {} }, [
        "acme",
      ]),
      { acme: { a: 1 } },
    );
  });

  it("is empty when the example touches nothing the plugin declares", () => {
    assert.deepEqual(projectOntoKeys({ dynamicPlugins: {} }, ["acme"]), {});
  });
});

describe("findUndeclaredKeys", () => {
  it("reports a typo inside a subtree the plugin owns", async () => {
    const outcome = await findUndeclaredKeys(
      await sourceWithSchema(),
      PKG,
      "label",
      { acme: { baseUrl: "x", retires: 3 } },
    );
    assert.equal(outcome.ownsSubtree, true);
    assert.equal(outcome.findings.length, 1);
    assert.match(outcome.findings[0], /retires/);
  });

  it("ignores keys outside the subtrees the plugin owns", async () => {
    // The whole reason noUndeclaredProperties cannot be switched on wholesale:
    // examples carry the dynamicPlugins wrapper and core Backstage blocks that
    // belong to no plugin schema.
    const outcome = await findUndeclaredKeys(
      await sourceWithSchema(),
      PKG,
      "label",
      { acme: { baseUrl: "x" }, dynamicPlugins: { frontend: {} }, proxy: {} },
    );
    assert.deepEqual(outcome, { ownsSubtree: true, findings: [] });
  });

  it("reports nothing to inspect when the plugin owns none of the example", async () => {
    const outcome = await findUndeclaredKeys(
      await sourceWithSchema(),
      PKG,
      "label",
      { dynamicPlugins: { frontend: {} } },
    );
    assert.deepEqual(outcome, { ownsSubtree: false, findings: [] });
  });

  it("does not repeat a type error validateExample already reports", async () => {
    // Findings are the difference between the strict and lenient runs, so an
    // error both produce belongs to the schema layer and not to this one.
    const outcome = await findUndeclaredKeys(
      await sourceWithSchema(),
      PKG,
      "label",
      { acme: { baseUrl: "x", hosts: "not-a-list" } },
    );
    // Full shape, not just an empty list: asserting only `findings` would also
    // pass if the projection broke and nothing was ever inspected.
    assert.deepEqual(outcome, { ownsSubtree: true, findings: [] });
  });

  it("reports nothing to inspect when the content is not a mapping", async () => {
    assert.deepEqual(
      await findUndeclaredKeys(await sourceWithSchema(), PKG, "label", ["a"]),
      { ownsSubtree: false, findings: [] },
    );
  });

  it("reports nothing when the schema could not be resolved", async () => {
    const source: SchemaSource = {
      resolve: async () => ({ kind: "unavailable", reason: "HTTP 404" }),
    };
    assert.deepEqual(await findUndeclaredKeys(source, PKG, "label", {}), {
      ownsSubtree: false,
      findings: [],
    });
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

describe("declaredConfigSchemaPath", () => {
  async function packageJson(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "declared-schema-"));
    await writeFile(join(dir, "package.json"), contents);
    return dir;
  }

  it("returns a nested path as declared", async () => {
    const dir = await packageJson('{"configSchema":"dist/config.schema.json"}');
    try {
      assert.equal(
        await declaredConfigSchemaPath(dir),
        "dist/config.schema.json",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is undefined for an inline schema object", async () => {
    // config-loader accepts one, but there is no file for a patch to rewrite.
    const dir = await packageJson('{"configSchema":{"type":"object"}}');
    try {
      assert.equal(await declaredConfigSchemaPath(dir), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is undefined when the field is missing or the manifest unreadable", async () => {
    const dir = await packageJson("{}");
    try {
      assert.equal(await declaredConfigSchemaPath(dir), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const broken = await packageJson("{not json");
    try {
      assert.equal(await declaredConfigSchemaPath(broken), undefined);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it("refuses a path escaping the package", async () => {
    // The value comes from a third-party tarball, and `join` resolves `../`
    // rather than rejecting it — so an unchecked path would steer the scratch
    // file write and delete in applySection anywhere on the runner.
    const dir = await packageJson(
      '{"configSchema":"../../../../etc/config.d.ts"}',
    );
    try {
      assert.equal(await declaredConfigSchemaPath(dir), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isInside", () => {
  it("accepts a path under the root", () => {
    assert.equal(isInside("/a/b", "config.d.ts"), true);
    assert.equal(isInside("/a/b", "dist/config.schema.json"), true);
  });

  it("rejects traversal, absolute paths and the root itself", () => {
    assert.equal(isInside("/a/b", "../c"), false);
    assert.equal(isInside("/a/b", "/etc/passwd"), false);
    assert.equal(isInside("/a/b", "."), false);
  });
});

describe("applyConfigSchemaPatches with an ambiguous patch", () => {
  it("refuses when one patch rewrites the same-named schema for two plugins", async () => {
    // Only the filename ties a hunk to this package — the directory that would
    // say which plugin it belongs to is what the strip level discards. Applying
    // a sibling's hunk would validate against a schema that is not what ships.
    const dir = await mkdtemp(join(tmpdir(), "ambiguous-patch-"));
    try {
      await writeFile(join(dir, "config.d.ts"), "export type Config = {};\n");
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ configSchema: "config.d.ts" }),
      );
      const patch = join(dir, "1-two-plugins.patch");
      await writeFile(
        patch,
        [
          "diff --git a/plugins/foo/config.d.ts b/plugins/foo/config.d.ts",
          "--- a/plugins/foo/config.d.ts",
          "+++ b/plugins/foo/config.d.ts",
          "@@ -1 +1 @@",
          "-export type Config = {};",
          "+export type Config = { a: string };",
          "diff --git a/plugins/bar/config.d.ts b/plugins/bar/config.d.ts",
          "--- a/plugins/bar/config.d.ts",
          "+++ b/plugins/bar/config.d.ts",
          "@@ -1 +1 @@",
          "-export type Config = {};",
          "+export type Config = { b: string };",
          "",
        ].join("\n"),
      );
      await assert.rejects(
        () => applyConfigSchemaPatches(dir, [patch]),
        /cannot tell which belongs to this package/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("splitDiffByFile and sections with no hunks", () => {
  it("drops a rename-only section rather than guessing a target", () => {
    // Deliberate: a rename carries no `---`/`+++` lines, so there is nothing to
    // derive a strip level from. No workspace patch renames a config schema; if
    // one ever does, it will be skipped rather than misapplied.
    assert.deepEqual(
      splitDiffByFile(
        [
          "diff --git a/plugins/x/config.d.ts b/plugins/y/config.d.ts",
          "similarity index 100%",
          "rename from plugins/x/config.d.ts",
          "rename to plugins/y/config.d.ts",
        ].join("\n"),
      ),
      [],
    );
  });
});

describe("each placeholder candidate earns its place", () => {
  // Mutation showed three of the four could be deleted with the suite still
  // green: "true" and "false" covered for each other through an anyOf fixture
  // carrying both literals, and nothing reached for "placeholder" at all.
  // Anyone trimming the list would have got a pass and silently reintroduced
  // the RHIDP-15903 false positives.

  it('pins "placeholder": long enough for a minLength no other candidate meets', async () => {
    const outcome = await validateExample(
      await sourceFor({
        acme: {
          type: "object",
          properties: { token: { type: "string", minLength: 9 } },
        },
      }),
      PKG,
      "label",
      { acme: { token: "${TOKEN}" } },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it('pins "true": a field declaring the literal true, which "false" cannot rescue', async () => {
    const outcome = await validateExample(
      await sourceFor({
        acme: {
          type: "object",
          properties: {
            segment: {
              type: "object",
              required: ["testMode"],
              properties: { testMode: { type: "boolean", enum: [true] } },
            },
          },
        },
      }),
      PKG,
      "label",
      { acme: { segment: { testMode: "${TEST_MODE}" } } },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it('pins "false": a field declaring the literal false', async () => {
    const outcome = await validateExample(
      await sourceFor({
        acme: {
          type: "object",
          properties: {
            segment: {
              type: "object",
              properties: { testMode: { type: "boolean", enum: [false] } },
            },
          },
        },
      }),
      PKG,
      "label",
      { acme: { segment: { testMode: "${TEST_MODE}" } } },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });

  it('pins "0": a declared number, which no word-shaped candidate coerces to', async () => {
    const outcome = await validateExample(
      await sourceFor({
        acme: { type: "object", properties: { retries: { type: "number" } } },
      }),
      PKG,
      "label",
      { acme: { retries: "${RETRIES}" } },
    );
    assert.deepEqual(outcome, { kind: "ok" });
  });
});

describe("the placeholder pattern tracks config-loader's own", () => {
  it("excludes a nested brace, as upstream's [^{}] does", () => {
    // Upstream leaves `${A{B}` untouched. A looser class here would excuse a
    // schema violation on a value that is never substituted.
    assert.equal(hasPlaceholder("${A{B}"), false);
    assert.equal(hasPlaceholder("${AB}"), true);
  });
});

/**
 * A schema whose `oneOf` branches are object-typed, like several real Backstage
 * schemas. config-loader injects `additionalProperties: false` into every such
 * branch, which changes which branch a document satisfies.
 */
async function sourceWithObjectUnion(): Promise<SchemaSource> {
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
                properties: { a: { type: "string" }, b: { type: "string" } },
                oneOf: [
                  { type: "object", required: ["a"] },
                  { type: "object", required: ["b"] },
                ],
              },
            },
          },
        },
      ],
    },
  });
  return { resolve: async () => ({ kind: "schema", schema }) };
}

describe("findUndeclaredKeys and union branches", () => {
  it("reports nothing for a valid document whose schema uses oneOf", async () => {
    // Strictness rewrites the branches, so the strict run emits `required` and
    // `oneOf` errors about a document that is fine. Reporting those as
    // undeclared keys would be a flatly false statement.
    const outcome = await findUndeclaredKeys(
      await sourceWithObjectUnion(),
      PKG,
      "label",
      { acme: { a: "x" } },
    );
    assert.deepEqual(outcome, { ownsSubtree: true, findings: [] });
  });

  it("reports a real undeclared key once, not once per union branch", async () => {
    const outcome = await findUndeclaredKeys(
      await sourceWithObjectUnion(),
      PKG,
      "label",
      { acme: { a: "x", tpyo: 1 } },
    );
    assert.equal(outcome.ownsSubtree, true);
    // Exactly one: the raw strict run repeats the key once per branch it was
    // reached through, and only the dedup keeps that out of the report.
    assert.equal(outcome.findings.length, 1);
    assert.match(outcome.findings[0], /additionalProperty=tpyo/);
  });
});

describe("config-loader's undeclared-property message format", () => {
  it("still names the offending key as additionalProperty=", async () => {
    // findUndeclaredKeys filters on this wording. If config-loader changes it
    // the layer silently reports nothing, so pin it here rather than discover
    // it from an empty report.
    const strict = await loadConfigSchema({
      serialized: {
        backstageConfigSchemaVersion: 1,
        schemas: [
          {
            path: "plugin/config.d.ts",
            value: {
              type: "object",
              properties: {
                acme: { type: "object", properties: { a: { type: "string" } } },
              },
            },
          },
        ],
      },
      noUndeclaredProperties: true,
    });
    assert.throws(
      () =>
        strict.process([{ data: { acme: { tpyo: 1 } }, context: "label" }], {
          ignoreSchemaErrors: false,
        }),
      /additionalProperty=tpyo/,
    );
  });
});

describe("declaredTopLevelKeys across several schema entries", () => {
  it("merges, deduplicates and sorts", () => {
    assert.deepEqual(
      declaredTopLevelKeys({
        backstageConfigSchemaVersion: 1,
        schemas: [
          {
            path: "a",
            value: { type: "object", properties: { b: {}, a: {} } },
          },
          {
            path: "b",
            value: { type: "object", properties: { a: {}, c: {} } },
          },
        ],
      }),
      ["a", "b", "c"],
    );
  });

  it("skips entries with no usable properties rather than throwing", () => {
    assert.deepEqual(
      declaredTopLevelKeys({
        schemas: [{}, { value: {} }, { value: { properties: "nope" } }],
      }),
      [],
    );
  });
});

describe("rejectUndeclaredKeys", () => {
  it("closes a node that enumerates its properties", () => {
    assert.deepEqual(
      rejectUndeclaredKeys({ type: "object", properties: { a: {} } }),
      { type: "object", properties: { a: {} }, additionalProperties: false },
    );
  });

  it("leaves union branches that enumerate nothing open", () => {
    // Closing them is what made config-loader's own option report valid
    // documents: each branch would reject the other branch's key.
    assert.deepEqual(
      rejectUndeclaredKeys({
        type: "object",
        properties: { a: {}, b: {} },
        oneOf: [
          { type: "object", required: ["a"] },
          { type: "object", required: ["b"] },
        ],
      }),
      {
        type: "object",
        properties: { a: {}, b: {} },
        additionalProperties: false,
        oneOf: [
          { type: "object", required: ["a"] },
          { type: "object", required: ["b"] },
        ],
      },
    );
  });

  it("keeps whatever the plugin already chose", () => {
    assert.deepEqual(
      rejectUndeclaredKeys({
        type: "object",
        properties: { a: {} },
        additionalProperties: { type: "string" },
      }),
      {
        type: "object",
        properties: { a: {} },
        additionalProperties: { type: "string" },
      },
    );
  });

  it("closes nested schemas reached through properties and items", () => {
    const closed = rejectUndeclaredKeys({
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: { type: "array", items: { properties: { x: {} } } },
          },
        },
      },
    });
    assert.equal(
      // @ts-expect-error — walking a literal for the assertion
      closed.properties.outer.properties.inner.items.additionalProperties,
      false,
    );
  });

  it("does not mistake a config key named `properties` for a schema node", () => {
    // The walk follows JSON Schema keywords rather than descending into every
    // object, so a plugin with a `properties` config key keeps its shape.
    const closed = rejectUndeclaredKeys({
      type: "object",
      properties: { properties: { type: "string" } },
    });
    assert.deepEqual(closed, {
      type: "object",
      properties: { properties: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("walks the serialized wrapper config-loader hands back", () => {
    const closed = rejectUndeclaredKeys({
      backstageConfigSchemaVersion: 1,
      schemas: [
        { path: "a", value: { type: "object", properties: { a: {} } } },
      ],
    });
    assert.equal(
      // @ts-expect-error — walking a literal for the assertion
      closed.schemas[0].value.additionalProperties,
      false,
    );
  });
});

describe("findUndeclaredKeys and alternative-shape unions", () => {
  /** The dynatrace shape: array items are a union of *complete* alternatives. */
  async function sourceWithAlternatives(): Promise<SchemaSource> {
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
                    envs: {
                      type: "array",
                      items: {
                        anyOf: [
                          {
                            type: "object",
                            required: ["url", "clientId"],
                            properties: {
                              url: { type: "string" },
                              clientId: { type: "string" },
                            },
                          },
                          {
                            type: "object",
                            required: ["url", "token"],
                            properties: {
                              url: { type: "string" },
                              token: { type: "string" },
                            },
                          },
                        ],
                      },
                    },
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

  it("accepts a document matching one alternative", async () => {
    // Each branch enumerates its own complete key set, so closing them is safe —
    // unlike branches that enumerate nothing and lean on a shared parent.
    const outcome = await findUndeclaredKeys(
      await sourceWithAlternatives(),
      PKG,
      "label",
      { acme: { envs: [{ url: "u", clientId: "c" }] } },
    );
    assert.deepEqual(outcome, { ownsSubtree: true, findings: [] });
  });

  it("reports a typo inside the chosen alternative", async () => {
    const outcome = await findUndeclaredKeys(
      await sourceWithAlternatives(),
      PKG,
      "label",
      { acme: { envs: [{ url: "u", clientId: "c", tpyo: 1 }] } },
    );
    assert.match(outcome.findings.join(" "), /tpyo/);
  });
});

describe("rejectUndeclaredKeys and keywords it deliberately skips", () => {
  it("leaves a node under `not` open", () => {
    // Tightening inside a negation loosens the negation, so closing here could
    // manufacture a finding rather than catch one.
    assert.deepEqual(
      rejectUndeclaredKeys({ not: { type: "object", properties: { a: {} } } }),
      { not: { type: "object", properties: { a: {} } } },
    );
  });

  it("leaves nodes under unhandled keywords open, under-reporting rather than over-", () => {
    const closed = rejectUndeclaredKeys({
      if: { type: "object", properties: { a: {} } },
      contains: { type: "object", properties: { b: {} } },
    });
    assert.deepEqual(closed, {
      if: { type: "object", properties: { a: {} } },
      contains: { type: "object", properties: { b: {} } },
    });
  });
});
