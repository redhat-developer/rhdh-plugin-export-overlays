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

// Build a fake extracted-plugin dir with the given bundle artifacts. `contents`
// overrides the default empty-object body for specific files, so a test can supply a
// realistic mf-manifest.json or a deliberately broken one.
function makePlugin(
  files: string[],
  contents: Record<string, string> = {},
): PluginEntry {
  const dir = tempDir(join(tmpdir(), "bundle-"));
  for (const rel of files) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents[rel] ?? "{}");
  }
  return {
    name: "test",
    version: "1.0.0",
    dirName: "test",
    path: dir,
    role: "frontend",
  };
}

// The shape the remotes router requires, as observed on a real published artifact
// (backstage-community-plugin-acr:bs_1.52.0__1.27.0).
const MF_MANIFEST = JSON.stringify({
  name: "backstage_community__plugin_acr",
  metaData: { remoteEntry: { name: "remoteEntry.js", type: "global" } },
  exposes: [{ name: "." }, { name: "alpha" }],
});
const PKG_WITH_NFS = JSON.stringify({
  name: "test",
  backstage: {
    role: "frontend-plugin",
    features: { "./alpha": "@backstage/FrontendPlugin" },
  },
});

const LEGACY = ["package.json", "dist-scalprum/plugin-manifest.json"];
const NEW_FE = ["package.json", "dist/remoteEntry.js", "dist/mf-manifest.json"];
const NEW_FE_BODIES = {
  "dist/mf-manifest.json": MF_MANIFEST,
  "package.json": PKG_WITH_NFS,
};

test("legacy-only bundle validates as legacy", () => {
  const { systems, error } = validateFrontendBundle(makePlugin(LEGACY));
  assert.equal(error, null);
  assert.deepEqual(systems, ["legacy"]);
});

test("new-frontend-system-only bundle validates as new-frontend-system", () => {
  const { systems, mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, NEW_FE_BODIES),
  );
  assert.equal(error, null);
  assert.deepEqual(systems, ["new-frontend-system"]);
  assert.equal(mf?.servable, true);
  assert.equal(mf?.name, "backstage_community__plugin_acr");
  assert.equal(mf?.remoteEntry, "remoteEntry.js");
  assert.deepEqual(mf?.exposes, [".", "alpha"]);
  assert.deepEqual(mf?.nfsFeatures, ["./alpha"]);
});

test("dual bundle reports both systems", () => {
  const { systems, error } = validateFrontendBundle(
    makePlugin([...new Set([...LEGACY, ...NEW_FE])], NEW_FE_BODIES),
  );
  assert.equal(error, null);
  assert.deepEqual(systems, ["legacy", "new-frontend-system"]);
});

// --- module-federation manifest shape ------------------------------------------
// Presence is not enough: the remotes router in @backstage/backend-dynamic-feature-service
// logs and `continue`s past a manifest missing any of these fields, so the endpoint
// answers `200 []` and the app boots clean with no plugins. These assert the fields it
// requires, so a bundle that cannot be served fails here instead of at runtime.

test("an mf-manifest.json without the router's required fields fails", () => {
  // The old presence-only check wrote "{}" here and passed.
  const { systems, mf, error } = validateFrontendBundle(makePlugin(NEW_FE));
  assert.match(error ?? "", /would be skipped by the remotes router/);
  assert.match(error ?? "", /`name` missing/);
  assert.match(error ?? "", /`metaData\.remoteEntry\.name` missing/);
  assert.match(error ?? "", /`exposes` is not an array/);
  // The layout it advertises is still recorded, so the migration panel does not
  // undercount it as shipping no system at all.
  assert.deepEqual(systems, ["new-frontend-system"]);
  assert.equal(mf?.servable, false);
});

test("an empty exposes array is reported distinctly from a missing one", () => {
  const { error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": JSON.stringify({
        name: "x",
        metaData: { remoteEntry: { name: "remoteEntry.js" } },
        exposes: [],
      }),
    }),
  );
  assert.match(error ?? "", /`exposes` is empty/);
});

test("a manifest naming a remote entry asset that is absent fails", () => {
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": JSON.stringify({
        name: "x",
        metaData: { remoteEntry: { name: "otherEntry.js" } },
        exposes: [{ name: "." }],
      }),
    }),
  );
  assert.match(error ?? "", /dist\/otherEntry\.js not present/);
  assert.equal(mf?.servable, false);
});

test("unparseable mf-manifest.json says so rather than throwing", () => {
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, { "dist/mf-manifest.json": "{not json" }),
  );
  assert.match(error ?? "", /not valid JSON/);
  assert.equal(mf?.servable, false);
});

test("a servable remote with no NFS feature type is reported, not failed", () => {
  // The real state of argocd, qe-theme and the roadie packages: a served remote the
  // new frontend system mounts nothing from. That is upstream migration state, not a
  // broken artifact, so it must not turn a workspace red.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      "dist/mf-manifest.json": MF_MANIFEST,
      "package.json": JSON.stringify({
        name: "test",
        backstage: { role: "frontend-plugin" },
      }),
    }),
  );
  assert.equal(error, null);
  assert.equal(mf?.servable, true);
  assert.deepEqual(mf?.nfsFeatures, []);
});

test("legacy-only bundle has no mf detail to report", () => {
  const { mf, error } = validateFrontendBundle(makePlugin(LEGACY));
  assert.equal(error, null);
  assert.equal(mf, null);
});

test("incomplete legacy layout fails even when the new-FE layout is valid", () => {
  const plugin = makePlugin(
    [...NEW_FE, "dist-scalprum/some-chunk.js"],
    NEW_FE_BODIES,
  );
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
