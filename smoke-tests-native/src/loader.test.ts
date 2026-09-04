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
import {
  validateBackendBundle,
  validateFrontendBundle,
  type PluginEntry,
} from "./loader";
import { describeNfsShortfall } from "./harness-logic";

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
  role: PluginEntry["role"] = "frontend",
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
    role,
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

// The Scalprum manifest as actually published, from
// backstage-community-plugin-dynatrace:bs_1.52.0__10.21.0. `extensions: []` with
// `registrationMethod: "callback"` is not this artifact's quirk — it is the shape of all
// 76 published frontend bundles, because @red-hat-developer-hub/cli constructs its
// DynamicRemotePlugin with a literal `extensions: []`.
const SCALPRUM_SCRIPT = "backstage-community.plugin-dynatrace.5f82d9b5.js";
const scalprumManifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "backstage-community.plugin-dynatrace",
    version: "10.21.0",
    extensions: [],
    registrationMethod: "callback",
    baseURL: "auto",
    loadScripts: [SCALPRUM_SCRIPT],
    ...overrides,
  });

const LEGACY = [
  "package.json",
  "dist-scalprum/plugin-manifest.json",
  `dist-scalprum/${SCALPRUM_SCRIPT}`,
];
const LEGACY_BODIES = {
  "dist-scalprum/plugin-manifest.json": scalprumManifest(),
};
// LEGACY minus its script asset. Named rather than written inline in each test, because
// the absence IS the variable those tests are about, and a reader should not have to diff
// two literals to see it.
const LEGACY_WITHOUT_ASSET = [
  "package.json",
  "dist-scalprum/plugin-manifest.json",
];
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
  const { systems, mf, error } = validateFrontendBundle(
    makePlugin(LEGACY, LEGACY_BODIES),
  );
  assert.equal(error, null);
  assert.deepEqual(systems, ["legacy"]);
  assert.equal(mf, null);
});

test("new-frontend-system-only bundle validates as new-frontend-system", () => {
  const { systems, mf, scalprum, error } = validateFrontendBundle(
    makePlugin(NEW_FE, NEW_FE_BODIES),
  );
  assert.equal(error, null);
  assert.deepEqual(systems, ["new-frontend-system"]);
  assert.equal(mf?.servable, true);
  assert.equal(mf?.name, "backstage_community__plugin_acr");
  assert.equal(mf?.remoteEntry, "remoteEntry.js");
  assert.deepEqual(mf?.exposes, [".", "alpha"]);
  assert.deepEqual(mf?.nfsFeatures, ["./alpha"]);
  // No dist-scalprum/ at all, so there is no Scalprum manifest to report on — distinct
  // from a manifest that was read and found blank.
  assert.equal(scalprum, null);
});

test("dual bundle reports both systems", () => {
  const { systems, error } = validateFrontendBundle(
    makePlugin([...new Set([...LEGACY, ...NEW_FE])], {
      ...NEW_FE_BODIES,
      ...LEGACY_BODIES,
    }),
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
        // Each of these fails a different conjunct of the router's guard. `null` and the
        // bare string are the ones that would throw rather than fail if the guard were
        // reduced — `"name" in null` is a TypeError, and nothing here catches it, so a
        // single bad manifest would abort the whole sweep instead of failing one package.
        exposes: [{ name: "." }, null, "alpha", { notName: "x" }],
      }),
    }),
  );
  assert.match(error ?? "", /`exposes` has an entry without a `name`/);
  assert.equal(mf?.servable, false);
});

test("a missing entry asset fails the bundle without claiming the router skips it", () => {
  // `servable` means "the router will serve this remote". The router probes
  // mf-manifest.json itself on the default path (getRemoteEntryType() === "manifest"), so
  // a missing remoteEntry asset does NOT stop it serving — it breaks the MF runtime in the
  // browser instead. Reporting servable: false here would put a false value in the one
  // field results.json documents as the router's verdict.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({
        metaData: { remoteEntry: { name: "otherEntry.js", path: "" } },
      }),
    }),
  );
  assert.match(error ?? "", /dist\/otherEntry\.js not present/);
  assert.doesNotMatch(error ?? "", /skipped by the remotes router/);
  assert.equal(mf?.servable, true);
});

test("a remoteEntry.path of '..' escapes the bundle without leaving the package", () => {
  // The containment root is dist/, not the plugin directory: `..` resolves to
  // <plugin>/remoteEntry.js, which is inside the package but outside the bundle. Naming
  // the boundary wrongly would send a reader looking for the wrong problem.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({
        metaData: { remoteEntry: { name: "remoteEntry.js", path: ".." } },
      }),
    }),
  );
  assert.match(error ?? "", /escapes the bundle's dist\/ directory/);
  // The router resolves its asset from `name` alone and never reads `path`, so it still
  // serves this remote — the fault is in the bundle, not in what the router will do.
  assert.equal(mf?.servable, true);
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

test("the root entry point '.' maps to the exposed module '.'", () => {
  // 12 of the 44 published frontend artifacts declare "." as their NFS entry point, so
  // this half of the mapping is on the hot path for a quarter of the catalog.
  const { mf } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      "dist/mf-manifest.json": mfManifest({ exposes: [{ name: "." }] }),
      "package.json": JSON.stringify({
        name: "test",
        backstage: {
          role: "frontend-plugin",
          features: { ".": "@backstage/FrontendPlugin" },
        },
      }),
    }),
  );
  assert.deepEqual(mf?.nfsFeatures, ["."]);
  assert.deepEqual(mf?.nfsFeaturesExposed, ["."]);
});

test("a manifest exposing the './'-prefixed form still matches", () => {
  // The two sides need not agree on the prefix; matching has to be prefix-insensitive or
  // a correctly-migrated package would be reported as exposing nothing.
  const { mf } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({ exposes: [{ name: "./alpha" }] }),
    }),
  );
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
  assert.deepEqual(mf?.nfsFeaturesExposed, []);
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
  const plugin = makePlugin([...LEGACY, "dist/remoteEntry.js"], LEGACY_BODIES);
  const { systems, error } = validateFrontendBundle(plugin);
  assert.match(error ?? "", /missing dist\/mf-manifest\.json/);
  assert.deepEqual(systems, ["legacy"]);
});

test("no bundle at all names both expected layouts in the error", () => {
  const { systems, configSchema, error } = validateFrontendBundle(
    makePlugin(["package.json"]),
  );
  assert.deepEqual(systems, []);
  assert.match(error ?? "", /dist-scalprum/);
  // Names the manifest, not remoteEntry.js: gating on that filename is exactly what this
  // PR stopped doing, so pointing a reader at it would be stale advice.
  assert.match(error ?? "", /dist\/mf-manifest\.json/);
  // RHDH's schema path is held against the bundle whatever layout it ships, because its
  // absence IS the fault. Recorded as missing here, but not failed: this package declares
  // no configuration.
  assert.deepEqual(configSchema.files, [
    {
      path: "dist-scalprum/configSchema.json",
      consumer: "rhdh",
      state: "missing",
      propertyCount: null,
    },
  ]);
});

test("missing package.json is its own error", () => {
  const { error } = validateFrontendBundle(makePlugin([]));
  assert.equal(error, "missing package.json");
});

test("a remoteEntry.path escaping the bundle is reported as a bundle fault", () => {
  // `path` comes from JSON inside a published OCI artifact, so it is untrusted input.
  // Joining it unchecked lets a manifest probe the filesystem outside its own package —
  // the containment rule src/paths.ts exists to enforce.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({
        metaData: { remoteEntry: { name: "passwd", path: "../../../../etc" } },
      }),
    }),
  );
  assert.match(error ?? "", /escapes the bundle's dist\/ directory/);
  assert.match(error ?? "", /has bundle problems/);
  assert.equal(mf?.servable, true);
});

test("a package.json that cannot be read warns instead of reading as 'declares nothing'", () => {
  // The catch in readNfsFeatures is unreachable for malformed JSON — discoverPlugins skips
  // those and warns first — so only a real I/O error gets here. Returning [] silently used
  // to be harmless; it is not any more, because an empty nfsFeatures now drives the
  // "declares no backstage.features" message. An EISDIR would print that as a fact.
  const dir = tempDir(join(tmpdir(), "bundle-"));
  // A directory where package.json should be: existsSync passes, readFileSync throws EISDIR.
  mkdirSync(join(dir, "package.json"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist/mf-manifest.json"), mfManifest());
  writeFileSync(join(dir, "dist/remoteEntry.js"), "");

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => warnings.push(String(msg));
  try {
    validateFrontendBundle({
      name: "test",
      version: "1.0.0",
      dirName: "test",
      path: dir,
      role: "frontend",
    });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not read package\.json/);
});

test("an unreadable package.json fails instead of yielding an NFS verdict", () => {
  // The warning alone was not enough: readNfsFeatures returned [] and describeNfsShortfall
  // then said "declares no backstage.features" — a verdict about the artifact derived from
  // an I/O failure. Since an unreadable package.json means the artifact cannot be judged at
  // all, the honest outcome is a failure naming the read error, not a verdict.
  const dir = tempDir(join(tmpdir(), "bundle-"));
  mkdirSync(join(dir, "package.json"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist/mf-manifest.json"), mfManifest());
  writeFileSync(join(dir, "dist/remoteEntry.js"), "");

  const original = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = validateFrontendBundle({
      name: "test",
      version: "1.0.0",
      dirName: "test",
      path: dir,
      role: "frontend",
    });
  } finally {
    console.warn = original;
  }
  assert.match(result.error ?? "", /could not read package\.json/);
  // `for configSchema` is the discriminator. Without it this assertion is satisfied by
  // readNfsFeatures alone — this fixture ships dist/mf-manifest.json, so the MF half emits
  // a matching string on its own and the configSchema half was never observed at all.
  assert.match(result.error ?? "", /for configSchema/);
  // A read failure must not be published as the artifact declaring no configuration.
  assert.equal(result.configSchema.declared, false);
  assert.match(
    result.configSchema.declaredError ?? "",
    /could not read package\.json/,
  );
  // And no shortfall verdict is reachable, because the run already failed.
  assert.equal(describeNfsShortfall(result.mf), null);
});

test("an exposes entry with an empty name is servable but not a usable module", () => {
  // Verified against the router's guard: `"name" in {name: ""}` is true, so it does NOT
  // skip the remote — it advertises `[""]` as an exposed module. So `servable` must stay
  // true to mirror it, while the empty name is dropped from the usable list, because NFS
  // has nothing to resolve for it. This pins both halves of that boundary.
  const { mf, error } = validateFrontendBundle(
    makePlugin(NEW_FE, {
      ...NEW_FE_BODIES,
      "dist/mf-manifest.json": mfManifest({
        exposes: [{ name: "." }, { name: "" }],
      }),
    }),
  );
  assert.equal(error, null);
  assert.equal(mf?.servable, true);
  assert.deepEqual(mf?.exposes, ["."]);
});

// --- Scalprum manifest integrity (RHIDP-16229) -----------------------------------
// The legacy half used to ask only whether plugin-manifest.json existed, which is what
// let RHDHBUGS-2180 through: a bundle that is present, loads in Scalprum, and serves 404
// on every configured route. These assert the faults that make a present bundle unusable.

test("a loadScripts asset missing from the bundle fails", () => {
  // The deliberately stripped bundle: the manifest names a script the artifact does not
  // contain. The host fetches a 404, the registration callback never runs, and every
  // configured frontend route answers 404 — with nothing logged as an error anywhere.
  const { systems, scalprum, error } = validateFrontendBundle(
    makePlugin(LEGACY_WITHOUT_ASSET, {
      ...LEGACY_BODIES,
    }),
  );
  assert.match(error ?? "", /loadScripts asset\(s\) not present/);
  assert.match(error ?? "", /every configured route answers 404/);
  assert.deepEqual(scalprum?.missingScripts, [SCALPRUM_SCRIPT]);
  // The layout it advertises is still recorded, so the migration panel does not
  // undercount it as shipping no system at all.
  assert.deepEqual(systems, ["legacy"]);
});

test("a published Scalprum manifest passes and reports its fields, empty `extensions` included", () => {
  // Named for the whole record, not just `extensions`: this is the only test that asserts
  // `name` and `registrationMethod` are read correctly at all, so a future reader trimming
  // "another extensions test" would silently drop them.
  //
  // 76 of 76 published frontend bundles report 0 extensions, because the export CLI
  // hardcodes `extensions: []` and the SDK's own manifest schema permits it (only
  // loadScripts is `.nonempty()`). Failing it would fail the entire catalogue.
  const { scalprum, error } = validateFrontendBundle(
    makePlugin(LEGACY, LEGACY_BODIES),
  );
  assert.equal(error, null);
  assert.equal(scalprum?.extensionCount, 0);
  assert.equal(scalprum?.registrationMethod, "callback");
  assert.equal(scalprum?.name, "backstage-community.plugin-dynatrace");
});

test("an extensions field that is not an array fails", () => {
  // Distinct from the empty array: the SDK's schema is `z.array(...)`, so a non-array is
  // malformed rather than merely empty, and `extensions: null` records that we cannot
  // even count them.
  const { scalprum, error } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        extensions: "none",
      }),
    }),
  );
  assert.match(error ?? "", /`extensions` is missing or not an array/);
  assert.equal(scalprum?.extensionCount, null);
});

test("an empty loadScripts fails — there is nothing for the host to fetch", () => {
  const { error } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: [],
      }),
    }),
  );
  assert.match(error ?? "", /`loadScripts` is empty/);
  // Not the missing-asset message: an empty list and a list naming an absent file are
  // different faults, and conflating them sends a reader looking for the wrong file.
  assert.doesNotMatch(error ?? "", /not present in dist-scalprum/);
});

test("a manifest without a name fails, naming what it breaks", () => {
  // RHDH matches app-config `dynamicPlugins.frontend.<key>` against this name, so a
  // nameless manifest makes every mount point unaddressable.
  const { error } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({ name: "" }),
    }),
  );
  assert.match(error ?? "", /`name` missing/);
  assert.match(error ?? "", /dynamicPlugins\.frontend/);
});

test("unparseable plugin-manifest.json says so rather than passing as present", () => {
  // The old presence-only check accepted this file whatever was in it.
  const { systems, scalprum, error } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": "{not json",
    }),
  );
  assert.match(error ?? "", /plugin-manifest\.json is not valid JSON/);
  assert.deepEqual(systems, ["legacy"]);
  assert.equal(scalprum?.name, null);
});

test("a loadScripts entry that names no asset fails", () => {
  // The hole this check was built with: `resolveContained("", dist-scalprum)` returns the
  // directory itself, and the directory exists — so a manifest listing `""` was reported
  // as having every asset it needs, in the exact case the check exists to catch. The host
  // would fetch the directory URL and get no script.
  const { scalprum, error } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: [""],
      }),
    }),
  );
  assert.match(error ?? "", /not a non-empty asset name/);
  assert.deepEqual(scalprum?.loadScripts, []);
});

test("a loadScripts entry naming a directory in the bundle fails", () => {
  // Same hole, reachable without an empty string: `static/` is a directory every published
  // bundle ships, so existsSync alone would call it a present asset.
  const { error } = validateFrontendBundle(
    makePlugin([...LEGACY, "dist-scalprum/static/asset.png"], {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: ["static"],
      }),
    }),
  );
  assert.match(error ?? "", /loadScripts asset\(s\) not present/);
});

test("a malformed loadScripts entry is not reported as an empty list", () => {
  // It was: every non-string was filtered out first, so `[123]` arrived as `[]` and the
  // error said the field was empty. It is present and malformed, which is a different
  // thing to go looking for — the same distinction findRouterGuardProblems draws between
  // "`exposes` is not an array" and "an entry without a `name`".
  const { error } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: [123],
      }),
    }),
  );
  assert.match(error ?? "", /not a non-empty asset name/);
  assert.doesNotMatch(error ?? "", /`loadScripts` is empty/);
});

test("loadScripts that is not an array is distinguished from an empty one", () => {
  // Same reason the malformed-entry case is kept apart from "empty": a field of the wrong
  // TYPE and a field that is present and empty send a reader to two different places, and
  // findRouterGuardProblems already draws that line for `exposes`.
  const { error } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: "one.js",
      }),
    }),
  );
  assert.match(error ?? "", /`loadScripts` is not an array/);
  assert.doesNotMatch(error ?? "", /`loadScripts` is empty/);
});

test("a bad entry and an absent asset are both reported", () => {
  // The bad-entry check and the missing-asset check run independently, so the second
  // fault is not hidden behind the first.
  const { scalprum, error } = validateFrontendBundle(
    makePlugin(LEGACY_WITHOUT_ASSET, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: ["real.js", ""],
      }),
    }),
  );
  assert.match(error ?? "", /not a non-empty asset name/);
  assert.match(error ?? "", /loadScripts asset\(s\) not present/);
  assert.deepEqual(scalprum?.missingScripts, ["real.js"]);
});

// --- configSchema (RHIDP-16229) --------------------------------------------------
// RHDHBUGS-1157: a frontend bundle shipped with no schema for the configuration it
// declares, so Backstage had nothing to match its app-config keys against and dropped
// them without a word. `declared` is what separates that from the 43 of 76 published
// packages that simply ship no configuration.

const CONFIG_PKG = JSON.stringify({
  name: "test",
  backstage: { role: "frontend-plugin" },
  configSchema: "config.d.ts",
});
// Shaped as every published schema is, because the check now mirrors the backend
// gatherer's own guard: `$schema` present and `type: "object"`.
const SCHEMA = JSON.stringify({
  $schema: "https://backstage.io/schema/config-v1",
  type: "object",
  properties: { dynatrace: { type: "object" } },
});

test("a bundle declaring configSchema without the schema file fails", () => {
  // The deliberately stripped bundle for check 1: package.json still declares
  // `configSchema`, the file the export writes beside the bundle is gone.
  const { configSchema, error } = validateFrontendBundle(
    makePlugin(LEGACY, { ...LEGACY_BODIES, "package.json": CONFIG_PKG }),
  );
  assert.match(error ?? "", /declares `configSchema`/);
  assert.match(
    error ?? "",
    /dist-scalprum\/configSchema\.json is not in the bundle/,
  );
  assert.match(error ?? "", /dropped silently/);
  assert.equal(configSchema.declared, true);
  assert.deepEqual(configSchema.files, [
    {
      path: "dist-scalprum/configSchema.json",
      consumer: "rhdh",
      state: "missing",
      propertyCount: null,
    },
  ]);
});

test("a declared configSchema with an empty schema fails, and says which", () => {
  // The live shape of RHDHBUGS-1157: the file is there, so a presence check passes, but
  // the export's schema collection resolves dependencies inside an empty `catch {}` and
  // produced nothing. Functionally identical to the file being absent — and the message
  // has to say so, not repeat "is not in the bundle".
  const { configSchema, error } = validateFrontendBundle(
    makePlugin([...LEGACY, "dist-scalprum/configSchema.json"], {
      ...LEGACY_BODIES,
      "package.json": CONFIG_PKG,
      "dist-scalprum/configSchema.json": "{}",
    }),
  );
  assert.match(error ?? "", /declares no properties/);
  assert.doesNotMatch(error ?? "", /is not in the bundle/);
  assert.equal(configSchema.files[0].state, "empty");
  assert.equal(configSchema.files[0].propertyCount, 0);
});

test("a bundle that declares no configuration is reported, not failed", () => {
  // The "cannot tell" side of the line: 31 of 76 published packages ship an empty schema
  // and declare nothing, which is a legitimate state. Failing on the empty schema alone
  // would accuse all 31 of a bug they do not have.
  const { configSchema, error } = validateFrontendBundle(
    makePlugin([...LEGACY, "dist-scalprum/configSchema.json"], {
      ...LEGACY_BODIES,
      "dist-scalprum/configSchema.json": "{}",
    }),
  );
  assert.equal(error, null);
  assert.equal(configSchema.declared, false);
  assert.equal(configSchema.files[0].state, "empty");
});

test("a declared configSchema with a real schema passes and reports its property count", () => {
  // The success path for the whole check: without it, a mutation that failed every
  // declaring package would be invisible, since the other configSchema tests all assert a
  // failure.
  const { configSchema, error } = validateFrontendBundle(
    makePlugin([...LEGACY, "dist-scalprum/configSchema.json"], {
      ...LEGACY_BODIES,
      "package.json": CONFIG_PKG,
      "dist-scalprum/configSchema.json": SCHEMA,
    }),
  );
  assert.equal(error, null);
  assert.equal(configSchema.files[0].state, "ok");
  assert.equal(configSchema.files[0].propertyCount, 1);
});

test("a missing upstream-default schema does not fail an RHDH artifact", () => {
  // RHDH overrides the gatherer's schemaLocator to
  // `platform === "node" ? "dist" : "dist-scalprum"` + "configSchema.json", and
  // PackageRoles.getRoleInfo("frontend-plugin").platform is "web" — so RHDH reads
  // dist-scalprum/configSchema.json and NEVER dist/.config-schema.json for these packages.
  // Failing the upstream copy would reject an artifact over a file this platform ignores.
  const { configSchema, error } = validateFrontendBundle(
    makePlugin([...LEGACY, ...NEW_FE, "dist-scalprum/configSchema.json"], {
      ...LEGACY_BODIES,
      ...NEW_FE_BODIES,
      "package.json": CONFIG_PKG,
      "dist-scalprum/configSchema.json": SCHEMA,
    }),
  );
  assert.equal(error, null);
  assert.deepEqual(
    configSchema.files.map((file) => [file.path, file.consumer, file.state]),
    [
      ["dist-scalprum/configSchema.json", "rhdh", "ok"],
      ["dist/.config-schema.json", "upstream-default", "missing"],
    ],
  );
});

test("an NFS-only bundle declaring configSchema fails for the file RHDH reads", () => {
  // The false negative the directory gate left open. This bundle ships no dist-scalprum/
  // at all, so gating the check on that directory skipped the very file RHDH looks for:
  // the package declared configSchema, shipped the upstream-default copy, and passed —
  // while RHDH found no dist-scalprum/configSchema.json and dropped its config in silence.
  // RHDHBUGS-1157 on the NFS lane, which is the lane the docs claim is covered.
  const { systems, configSchema, error } = validateFrontendBundle(
    makePlugin([...NEW_FE, "dist/.config-schema.json"], {
      ...NEW_FE_BODIES,
      "package.json": JSON.stringify({
        name: "test",
        backstage: {
          role: "frontend-plugin",
          features: { "./alpha": "@backstage/FrontendPlugin" },
        },
        configSchema: "config.d.ts",
      }),
      "dist/.config-schema.json": SCHEMA,
    }),
  );
  assert.deepEqual(systems, ["new-frontend-system"]);
  assert.match(
    error ?? "",
    /dist-scalprum\/configSchema\.json is not in the bundle/,
  );
  assert.equal(configSchema.files[0].consumer, "rhdh");
  assert.equal(configSchema.files[0].state, "missing");
  // The upstream copy is present and fine — which is exactly why the old gate passed it.
  assert.equal(configSchema.files[1].state, "ok");
});

test("an unreadable schema is distinguished from a missing one", () => {
  // `missing` and `unreadable` both mean "no usable schema", but only one of them is
  // fixed by rebuilding the artifact — the message has to say which the reader is looking
  // at, and `state` has to carry it into results.json.
  const { configSchema, error } = validateFrontendBundle(
    makePlugin([...LEGACY, "dist-scalprum/configSchema.json"], {
      ...LEGACY_BODIES,
      "package.json": CONFIG_PKG,
      "dist-scalprum/configSchema.json": "{not json",
    }),
  );
  assert.match(error ?? "", /configSchema\.json could not be read or parsed/);
  assert.equal(configSchema.files[0].state, "unreadable");
  assert.equal(configSchema.files[0].propertyCount, null);
});

test("a configSchema fault is reported alongside an unrelated bundle fault", () => {
  // Two independent defects: the schema is gone AND the manifest names an absent script.
  // Reporting only one hides the other from whoever reads the failure.
  const { error } = validateFrontendBundle(
    makePlugin(LEGACY_WITHOUT_ASSET, {
      "package.json": CONFIG_PKG,
      ...LEGACY_BODIES,
    }),
  );
  assert.match(error ?? "", /loadScripts asset\(s\) not present/);
  assert.match(error ?? "", /declares `configSchema`/);
});

test("a loadScripts entry Node refuses to stat is reported, not thrown", () => {
  // statSync is not existsSync: it THROWS on a path Node rejects outright (an embedded
  // NUL is ERR_INVALID_ARG_VALUE, an over-long name is ENAMETOOLONG), and
  // `throwIfNoEntry: false` suppresses only ENOENT. Unwrapped, one such entry — untrusted
  // JSON from a published artifact — escapes to native-smoke's outer catch and collapses
  // the whole workspace into `status: error`, losing every other plugin's result.
  const { scalprum, error } = validateFrontendBundle(
    makePlugin(LEGACY_WITHOUT_ASSET, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: [`bad${String.fromCharCode(0)}name.js`, "x".repeat(5000)],
      }),
    }),
  );
  assert.match(error ?? "", /loadScripts asset\(s\) not present/);
  assert.equal(scalprum?.missingScripts.length, 2);
});

test("a loadScripts entry escaping the bundle says so, not 'not present'", () => {
  // findBundleAssetProblems reports the same condition on the MF side as "escapes the
  // bundle's dist/ directory". Folding it into "not present in dist-scalprum/" sends the
  // reader looking inside the bundle for a name that was never bundle-relative.
  const { error } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: ["../../../../etc/passwd"],
      }),
    }),
  );
  assert.match(error ?? "", /escaping the bundle's dist-scalprum\/ directory/);
  assert.doesNotMatch(error ?? "", /not present in dist-scalprum/);
});

test("an escaping loadScripts entry is contained before any filesystem call", () => {
  // Untrusted JSON from inside a published OCI artifact: joined unchecked it would probe
  // the filesystem outside the bundle. Contained first, per src/paths.ts — and still
  // carried in missingScripts, because either way nothing loads.
  const { scalprum } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        loadScripts: ["../../../../etc/passwd"],
      }),
    }),
  );
  assert.deepEqual(scalprum?.missingScripts, ["../../../../etc/passwd"]);
});

test("a plugin-manifest.json of literal null is classified, not thrown", () => {
  // `null` is valid JSON, so it survives the parse and reaches the field reader. Without
  // the `?? {}` guard every property access throws out of the sweep instead of failing one
  // package — the blow-up the MF half's own "exposes: [null]" test exists to prevent.
  const { systems, scalprum, error } = validateFrontendBundle(
    makePlugin(LEGACY, { "dist-scalprum/plugin-manifest.json": "null" }),
  );
  assert.match(error ?? "", /`name` missing/);
  assert.match(error ?? "", /`extensions` is missing or not an array/);
  assert.match(error ?? "", /`loadScripts` is not an array/);
  assert.deepEqual(systems, ["legacy"]);
  assert.equal(scalprum?.name, null);
});

test("a positive extensions array is counted, not just detected", () => {
  // The 0 case exercises the Array.isArray branch but not the length itself, so a
  // mutation returning a constant 0 would go unnoticed.
  const { scalprum } = validateFrontendBundle(
    makePlugin(LEGACY, {
      "dist-scalprum/plugin-manifest.json": scalprumManifest({
        extensions: [{ type: "a" }, { type: "b" }],
      }),
    }),
  );
  assert.equal(scalprum?.extensionCount, 2);
});

test("a schema whose properties is an array is not counted as declaring anything", () => {
  // `typeof [] === "object"`, so without the Array.isArray guard `{"properties": ["a"]}`
  // counts 1. A JSON Schema's `properties` must be an object; an array declares nothing,
  // and the count has to say so rather than inflating.
  const { configSchema, error } = validateFrontendBundle(
    makePlugin([...LEGACY, "dist-scalprum/configSchema.json"], {
      ...LEGACY_BODIES,
      "package.json": CONFIG_PKG,
      "dist-scalprum/configSchema.json": JSON.stringify({
        properties: ["dynatrace"],
      }),
    }),
  );
  // The document is not `{}`, so it is not `empty`; it reaches the gatherer's own guard
  // and fails there, because nothing gave it a `$schema`.
  assert.match(error ?? "", /is missing `\$schema`/);
  assert.equal(configSchema.files[0].state, "invalid");
  assert.equal(configSchema.files[0].propertyCount, 0);
});

test("the module-federation side's schema is read, not only checked for presence", () => {
  // dist/.config-schema.json was only ever asserted `missing`, so a regression that
  // stopped reading it altogether — failing every dual bundle that correctly ships both —
  // had no test. This pins the `ok` state on that side.
  const { configSchema, error } = validateFrontendBundle(
    makePlugin(
      [
        ...LEGACY,
        ...NEW_FE,
        "dist-scalprum/configSchema.json",
        "dist/.config-schema.json",
      ],
      {
        ...LEGACY_BODIES,
        ...NEW_FE_BODIES,
        "package.json": JSON.stringify({
          name: "test",
          backstage: {
            role: "frontend-plugin",
            features: { "./alpha": "@backstage/FrontendPlugin" },
          },
          configSchema: "config.d.ts",
        }),
        "dist-scalprum/configSchema.json": SCHEMA,
        "dist/.config-schema.json": SCHEMA,
      },
    ),
  );
  assert.equal(error, null);
  assert.deepEqual(
    configSchema.files.map((file) => [
      file.path,
      file.state,
      file.propertyCount,
    ]),
    [
      ["dist-scalprum/configSchema.json", "ok", 1],
      ["dist/.config-schema.json", "ok", 1],
    ],
  );
});

test("a schema the backend gatherer would reject is not reported as ok", () => {
  // gatherDynamicPluginsSchemas' last guard: `if (!serialized?.$schema || serialized?.type
  // !== "object")` it logs and skips, so the config is dropped exactly as it is for a
  // missing file. Counting properties alone called this `ok` and published that in
  // results.json — a check that says the artifact is fine about one the runtime discards.
  const { configSchema, error } = validateFrontendBundle(
    makePlugin([...LEGACY, "dist-scalprum/configSchema.json"], {
      ...LEGACY_BODIES,
      "package.json": CONFIG_PKG,
      "dist-scalprum/configSchema.json": JSON.stringify({
        type: "object",
        properties: { dynatrace: { type: "object" } },
      }),
    }),
  );
  assert.match(error ?? "", /missing `\$schema`/);
  assert.equal(configSchema.files[0].state, "invalid");
  // The count is still reported: the schema does declare something, it just cannot load.
  assert.equal(configSchema.files[0].propertyCount, 1);
});

test("a schema whose type is not object is rejected for that reason", () => {
  const { configSchema } = validateFrontendBundle(
    makePlugin([...LEGACY, "dist-scalprum/configSchema.json"], {
      ...LEGACY_BODIES,
      "package.json": CONFIG_PKG,
      "dist-scalprum/configSchema.json": JSON.stringify({
        $schema: "https://backstage.io/schema/config-v1",
        type: "array",
        properties: { dynatrace: { type: "object" } },
      }),
    }),
  );
  assert.equal(configSchema.files[0].state, "invalid");
});

test("a bundle with no recognised layout says so even when the schema also fails", () => {
  // The layout error used to be returned only when `problems` was empty, so a
  // configSchema fault — which is layout-independent, and therefore exactly the fault
  // that co-occurs with this one — swallowed it. results.json then carried `systems: []`
  // with nothing in the error explaining why.
  const { systems, error } = validateFrontendBundle(
    makePlugin(["package.json", "dist/some-chunk.js"], {
      "package.json": CONFIG_PKG,
    }),
  );
  assert.deepEqual(systems, []);
  assert.match(error ?? "", /no frontend bundle found/);
  assert.match(error ?? "", /declares `configSchema`/);
});

// --- configSchema, backend half (RHIDP-16689) -------------------------------------
// Same defect as above, same mechanism, different file: RHDH's schemaLocator is keyed on
// the package's role, and both backend roles are platform "node" — verified by executing
// PackageRoles.getRoleInfo, not inferred — so it reads dist/configSchema.json. Nothing
// about RHDHBUGS-1157 is frontend-specific: such a plugin loads, boots and serves traffic
// on its defaults, which is why steps 2 and 3 of the harness cannot see it.

/** The role a backend artifact actually declares; only the platform behind it matters. */
const BACKEND_CONFIG_PKG = JSON.stringify({
  name: "test",
  backstage: { role: "backend-plugin" },
  configSchema: "config.d.ts",
});

/**
 * Both files a real published backend artifact ships, observed on
 * red-hat-developer-hub-backstage-plugin-adoption-insights-backend:bs_1.52.0__0.9.1 —
 * RHDH's `dist/configSchema.json` and the upstream default beside it, same directory,
 * different name.
 */
const BACKEND_RHDH_SCHEMA = "dist/configSchema.json";
const BACKEND_UPSTREAM_SCHEMA = "dist/.config-schema.json";

test("a backend bundle declaring configSchema without dist/configSchema.json fails", () => {
  // The deliberately stripped bundle: package.json still declares `configSchema` and the
  // file RHDH reads is gone. It would load and boot perfectly.
  const { configSchema, error } = validateBackendBundle(
    makePlugin(
      ["package.json"],
      { "package.json": BACKEND_CONFIG_PKG },
      "backend",
    ),
  );
  assert.match(error ?? "", /declares `configSchema`/);
  assert.match(error ?? "", /dist\/configSchema\.json is not in the bundle/);
  assert.match(error ?? "", /dropped silently/);
  assert.equal(configSchema.declared, true);
  assert.equal(configSchema.files[0].path, BACKEND_RHDH_SCHEMA);
  assert.equal(configSchema.files[0].consumer, "rhdh");
  assert.equal(configSchema.files[0].state, "missing");
});

test("the upstream-default copy alone does not satisfy the backend check", () => {
  // The backend equivalent of the directory-gate trap the frontend half shipped with, and
  // a sharper one: there, the two files were in different directories. Here they are
  // siblings in dist/ and differ only by filename, so a check written against
  // `.config-schema.json` — the name the gatherer's default locator uses — passes an
  // artifact whose config RHDH drops in silence. Only the `rhdh` entry can fail.
  const { configSchema, error } = validateBackendBundle(
    makePlugin(
      ["package.json", BACKEND_UPSTREAM_SCHEMA],
      {
        "package.json": BACKEND_CONFIG_PKG,
        [BACKEND_UPSTREAM_SCHEMA]: SCHEMA,
      },
      "backend",
    ),
  );
  assert.match(error ?? "", /dist\/configSchema\.json is not in the bundle/);
  assert.deepEqual(
    configSchema.files.map((file) => [file.path, file.consumer, file.state]),
    [
      [BACKEND_RHDH_SCHEMA, "rhdh", "missing"],
      [BACKEND_UPSTREAM_SCHEMA, "upstream-default", "ok"],
    ],
  );
});

test("a pristine backend bundle passes and reports its property count", () => {
  // The success path, shaped as the real artifact is. Without it a mutation failing every
  // declaring backend package would be invisible — every other test here asserts a failure.
  const { configSchema, error } = validateBackendBundle(
    makePlugin(
      ["package.json", BACKEND_RHDH_SCHEMA, BACKEND_UPSTREAM_SCHEMA],
      {
        "package.json": BACKEND_CONFIG_PKG,
        [BACKEND_RHDH_SCHEMA]: SCHEMA,
        [BACKEND_UPSTREAM_SCHEMA]: SCHEMA,
      },
      "backend",
    ),
  );
  assert.equal(error, null);
  assert.equal(configSchema.declared, true);
  assert.equal(configSchema.files[0].state, "ok");
  assert.equal(configSchema.files[0].propertyCount, 1);
});

test("a backend bundle declaring no configuration is reported, not failed", () => {
  // Same line as the frontend half draws: an empty schema is only a finding for a package
  // that declares one. Failing on the schema alone would accuse every non-declaring
  // backend package of a bug it does not have.
  const { configSchema, error } = validateBackendBundle(
    makePlugin(
      ["package.json", BACKEND_RHDH_SCHEMA],
      { [BACKEND_RHDH_SCHEMA]: "{}" },
      "backend",
    ),
  );
  assert.equal(error, null);
  assert.equal(configSchema.declared, false);
  assert.equal(configSchema.files[0].state, "empty");
});

test("a declared backend configSchema with an empty schema fails, and says which", () => {
  // The live shape of RHDHBUGS-1157 on the backend side: the file is present, so a
  // presence check passes, but the export collected nothing into it.
  const { configSchema, error } = validateBackendBundle(
    makePlugin(
      ["package.json", BACKEND_RHDH_SCHEMA],
      {
        "package.json": BACKEND_CONFIG_PKG,
        [BACKEND_RHDH_SCHEMA]: "{}",
      },
      "backend",
    ),
  );
  assert.match(error ?? "", /declares no properties/);
  assert.doesNotMatch(error ?? "", /is not in the bundle/);
  assert.equal(configSchema.files[0].state, "empty");
});
