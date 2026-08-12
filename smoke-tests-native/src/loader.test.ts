/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateFrontendBundle, type PluginEntry } from "./loader";

// Every mkdtempSync here would otherwise leak: the suite left 26 directories in
// $TMPDIR per run, unbounded on a developer machine and on any long-lived runner.
const TEMP_DIRS: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

// Build a fake extracted-plugin dir with the given bundle artifacts.
function makePlugin(files: string[]): PluginEntry {
  const dir = tempDir(join(tmpdir(), "bundle-"));
  for (const rel of files) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "{}");
  }
  return {
    name: "test",
    version: "1.0.0",
    dirName: "test",
    path: dir,
    role: "frontend",
  };
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
  const { systems, error } = validateFrontendBundle(plugin);
  assert.match(error ?? "", /missing plugin-manifest\.json/);
  // Both layouts are probed before returning: erroring must not erase the system the
  // bundle DOES ship, or the migration panel undercounts it as shipping neither.
  assert.deepEqual(systems, ["new-frontend-system"]);
});

test("incomplete new-FE layout fails even when the legacy layout is valid", () => {
  const plugin = makePlugin([...LEGACY, "dist/remoteEntry.js"]);
  const { systems, error } = validateFrontendBundle(plugin);
  assert.match(error ?? "", /missing dist\/mf-manifest\.json/);
  assert.deepEqual(systems, ["legacy"]);
});

test("no bundle at all names both expected layouts in the error", () => {
  const { systems, error } = validateFrontendBundle(
    makePlugin(["package.json"]),
  );
  assert.deepEqual(systems, []);
  assert.match(error ?? "", /dist-scalprum/);
  assert.match(error ?? "", /remoteEntry\.js/);
});

test("missing package.json is its own error", () => {
  const { error } = validateFrontendBundle(makePlugin([]));
  assert.equal(error, "missing package.json");
});
