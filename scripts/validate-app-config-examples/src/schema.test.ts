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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfigSchema } from "@backstage/config-loader";
import {
  describeError,
  findPackageRoot,
  hasConstraints,
  isSafePackageSpec,
  splitSchemaErrors,
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

describe("hasConstraints", () => {
  it("is false for a schema document that constrains nothing", async () => {
    const empty = await loadConfigSchema({
      serialized: { backstageConfigSchemaVersion: 1, schemas: [] },
    });
    assert.equal(hasConstraints(empty.serialize()), false);
  });

  it("is true once a schema is present", async () => {
    const schema = await sourceWithSchema();
    const resolved = await schema.resolve(PKG.name, PKG.version);
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
