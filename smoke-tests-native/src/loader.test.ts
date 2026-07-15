/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateFrontendBundle, type PluginEntry } from "./loader";

// Build a fake extracted-plugin dir with the given bundle artifacts.
function makePlugin(files: string[]): PluginEntry {
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  for (const rel of files) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "{}");
  }
  return { name: "test", version: "1.0.0", dirName: "test", path: dir, role: "frontend" };
}

const LEGACY = ["package.json", "dist-scalprum/plugin-manifest.json"];
const NEW_FE = ["package.json", "dist/remoteEntry.js", "dist/mf-manifest.json"];

test("legacy-only bundle validates as legacy", () => {
  const { systems, error } = validateFrontendBundle(makePlugin(LEGACY));
  assert.equal(error, null);
  assert.deepEqual(systems, ["legacy"]);
});

test("new-frontend-system-only bundle validates as new-frontend-system", () => {
  const { systems, error } = validateFrontendBundle(makePlugin(NEW_FE));
  assert.equal(error, null);
  assert.deepEqual(systems, ["new-frontend-system"]);
});

test("dual bundle reports both systems", () => {
  const { systems, error } = validateFrontendBundle(
    makePlugin([...new Set([...LEGACY, ...NEW_FE])]),
  );
  assert.equal(error, null);
  assert.deepEqual(systems, ["legacy", "new-frontend-system"]);
});

test("incomplete legacy layout fails even when the new-FE layout is valid", () => {
  const plugin = makePlugin([...NEW_FE, "dist-scalprum/some-chunk.js"]);
  const { error } = validateFrontendBundle(plugin);
  assert.match(error ?? "", /missing plugin-manifest\.json/);
});

test("incomplete new-FE layout fails even when the legacy layout is valid", () => {
  const plugin = makePlugin([...LEGACY, "dist/remoteEntry.js"]);
  const { error } = validateFrontendBundle(plugin);
  assert.match(error ?? "", /missing dist\/mf-manifest\.json/);
});

test("no bundle at all names both expected layouts in the error", () => {
  const { systems, error } = validateFrontendBundle(makePlugin(["package.json"]));
  assert.deepEqual(systems, []);
  assert.match(error ?? "", /dist-scalprum/);
  assert.match(error ?? "", /remoteEntry\.js/);
});

test("missing package.json is its own error", () => {
  const { error } = validateFrontendBundle(makePlugin([]));
  assert.equal(error, "missing package.json");
});
