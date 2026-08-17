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
// A second, non-NFS entry point so the NFS_FEATURE_TYPES filter has something to
// discriminate — with a single NFS-typed feature the filter can never be observed.
const PKG_WITH_NFS = JSON.stringify({
  name: "test",
  backstage: {
    role: "frontend-plugin",
    features: {
      "./alpha": "@backstage/FrontendPlugin",
      "./legacy": "@backstage/BackendFeature",
    },
  },
});
const PKG_WITHOUT_NFS = JSON.stringify({
  name: "test",
  backstage: { role: "frontend-plugin" },
});

const LEGACY = ["package.json", "dist-scalprum/plugin-manifest.json"];
const NEW_FE = ["package.json", "dist/remoteEntry.js", "dist/mf-manifest.json"];
const NEW_FE_BODIES = {
  "dist/mf-manifest.json": MF_MANIFEST,
  "package.json": PKG_WITH_NFS,
};

/** A valid manifest with the given fields overridden — keeps each test to its variable. */
const mfManifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "x",
    metaData: { remoteEntry: { name: "remoteEntry.js", path: "" } },
    exposes: [{ name: "." }],
    ...overrides,
  });

test("legacy-only bundle validates as legacy, with no mf detail to report", () => {
  const { systems, mf, error } = validateFrontendBundle(makePlugin(LEGACY));
  assert.equal(error, null);
  assert.deepEqual(systems, ["legacy"]);
  assert.equal(mf, null);
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

test("an empty exposes array is servable — the router accepts it", () => {
  // The router's guard is `!exposes || !Array.isArray(exposes) || !exposes.every(...)`.
  // `[]` is truthy, is an array, and `[].every()` is vacuously true, so an empty
  // exposes list is served. Failing it here would fail an artifact that works.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({ exposes: [] }),
    }),
  );
  assert.equal(error, null);
  assert.equal(mf?.servable, true);
  assert.deepEqual(mf?.exposes, []);
});

test("an exposes entry without a name is not servable", () => {
  // This is the case the router does reject: every entry must be a non-null object
  // with a `name` key.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({
        exposes: [{ name: "." }, { notName: "alpha" }],
      }),
    }),
  );
  assert.match(error ?? "", /`exposes` has an entry without a `name`/);
  assert.equal(mf?.servable, false);
});

test("a manifest naming a remote entry asset that is absent fails", () => {
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({
        metaData: { remoteEntry: { name: "otherEntry.js", path: "" } },
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

test("a remote entry under metaData.remoteEntry.path is found there", () => {
  // Real manifests carry `path` alongside `name` (empty for a root-level entry). Joining
  // only `dist` + `name` reports "not present" for an artifact the MF runtime loads fine.
  const plugin = makePlugin(
    ["package.json", "dist/mf-manifest.json", "dist/static/remoteEntry.js"],
    {
      "package.json": PKG_WITH_NFS,
      "dist/mf-manifest.json": mfManifest({
        metaData: { remoteEntry: { name: "remoteEntry.js", path: "static" } },
      }),
    },
  );
  const { mf, error } = validateFrontendBundle(plugin);
  assert.equal(error, null);
  assert.equal(mf?.servable, true);
});

test("a manifest without remoteEntry.js is still inspected", () => {
  // The router's default getRemoteEntryType() is "manifest", so it serves mf-manifest.json
  // as the entry and never requires a file literally named remoteEntry.js. Gating the
  // whole MF branch on that filename hid such remotes entirely — the same undercount the
  // readiness report's role filter was making.
  const plugin = makePlugin(
    ["package.json", "dist/mf-manifest.json", "dist/main.js"],
    {
      "package.json": PKG_WITH_NFS,
      "dist/mf-manifest.json": mfManifest({
        metaData: { remoteEntry: { name: "main.js", path: "" } },
      }),
    },
  );
  const { systems, mf, error } = validateFrontendBundle(plugin);
  assert.equal(error, null);
  assert.deepEqual(systems, ["new-frontend-system"]);
  assert.equal(mf?.servable, true);
});

test("two independent problems are both reported", () => {
  // A broken Scalprum layout and an unservable MF remote are separate faults; reporting
  // only the first hides the other from whoever reads the failure.
  const plugin = makePlugin([...NEW_FE, "dist-scalprum/some-chunk.js"], {
    ...NEW_FE_BODIES,
    "dist/mf-manifest.json": "{}",
  });
  const { error } = validateFrontendBundle(plugin);
  assert.match(error ?? "", /missing plugin-manifest\.json/);
  assert.match(error ?? "", /skipped by the remotes router/);
});

test("NFS features that the manifest does not expose are reported separately", () => {
  // backstage.features says "./alpha" is a FrontendPlugin, but the remote exposes only
  // ".". NFS resolves entry points through the exposed modules, so it mounts nothing —
  // and both `servable` and `nfsFeatures` look healthy on their own.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({ exposes: [{ name: "." }] }),
    }),
  );
  assert.equal(error, null);
  assert.equal(mf?.servable, true);
  assert.deepEqual(mf?.nfsFeatures, ["./alpha"]);
  assert.deepEqual(mf?.nfsFeaturesExposed, []);
});

test("an NFS feature the manifest does expose is counted as exposed", () => {
  const { mf } = validateFrontendBundle(makePlugin(NEW_FE, NEW_FE_BODIES));
  // "./alpha" in backstage.features maps to the exposed module named "alpha".
  assert.deepEqual(mf?.nfsFeaturesExposed, ["./alpha"]);
});

test("a servable remote with no NFS feature type is reported, not failed", () => {
  // The real state of argocd, qe-theme and the roadie packages: a served remote the
  // new frontend system mounts nothing from. That is upstream migration state, not a
  // broken artifact, so it must not turn a workspace red.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      "dist/mf-manifest.json": MF_MANIFEST,
      "package.json": PKG_WITHOUT_NFS,
    }),
  );
  assert.equal(error, null);
  assert.equal(mf?.servable, true);
  assert.deepEqual(mf?.nfsFeatures, []);
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
