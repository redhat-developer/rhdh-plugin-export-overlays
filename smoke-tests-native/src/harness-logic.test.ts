/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  createBackendFeatureLoader,
  createBackendModule,
  createBackendPlugin,
  createExtensionPoint,
  createServiceFactory,
  createServiceRef,
  coreServices,
} from "@backstage/backend-plugin-api";
import { startTestBackend } from "@backstage/backend-test-utils";
import {
  bootFeatureList,
  bundleNamesAreComplete,
  computeStatus,
  configKeysNotApplicable,
  describeConfigKeyMismatch,
  describeInstallShortfall,
  describeNfsShortfall,
  expandFeatureLoaders,
  featureTargets,
  findConfigKeyMismatches,
  missingHostPluginIds,
  partitionBootable,
} from "./harness-logic";
import type { MfRemoteInfo, PluginEntry, PluginError } from "./loader";
import { oneLine } from "./aggregate-report";

function entry(name: string, dirName = name): PluginEntry {
  return {
    name,
    version: "1",
    dirName,
    path: `/p/${dirName}`,
    role: "backend",
  };
}
const anError: PluginError = { plugin: entry("@s/p"), error: "boom" };

test("computeStatus reports the most specific failure and passes only on a clean run", () => {
  assert.equal(computeStatus([], true, 3, [], 0), "pass");
  assert.equal(computeStatus([anError], true, 3, [], 0), "fail-load");
  // A load error outranks everything: the rest failed because of it.
  assert.equal(computeStatus([anError], false, 3, [anError], 0), "fail-load");
  assert.equal(computeStatus([], false, 3, [], 0), "fail-start");
  assert.equal(computeStatus([], false, 3, [anError], 0), "fail-start");
  assert.equal(computeStatus([], true, 0, [anError], 0), "fail-bundle");
});

test("a backend bundle fault fails the run, without outranking a load failure", () => {
  // The backend configSchema check (RHIDP-16689) reaches computeStatus through the same
  // `bundleErrors` list as the frontend one, so a plugin that booted fine but lost its
  // config still turns the run red. It stays below fail-load and fail-start: a plugin that
  // would not load at all is the more specific answer, and this one loaded.
  assert.equal(computeStatus([], true, 3, [anError], 0), "fail-bundle");
  assert.equal(computeStatus([anError], true, 3, [anError], 0), "fail-load");
  assert.equal(computeStatus([], false, 3, [anError], 0), "fail-start");
});

test("a frontend-only workspace passes even though no backend started", () => {
  // startBackend short-circuits to {ok:true, skipped:true} when nothing loaded, so
  // startOk=false with loadedCount=0 is not reachable as a real boot failure.
  assert.equal(computeStatus([], false, 0, [], 0), "pass");
});

test("describeInstallShortfall compares what installed against what was declared", () => {
  assert.equal(describeInstallShortfall(3, 3), null);
  assert.match(describeInstallShortfall(2, 3) ?? "", /installed 2 plugin\(s\)/);
  assert.match(describeInstallShortfall(2, 3) ?? "", /declared 3/);
  assert.match(
    describeInstallShortfall(2, 3) ?? "",
    /part of the source was never validated/,
  );
  // More than declared is just as wrong as fewer — it means something unexpected
  // landed in the install root. Still true by default; a source whose ref list is
  // deduplicated opts out explicitly (see the allowExtra test below).
  assert.notEqual(describeInstallShortfall(4, 3), null);
});

test("describeInstallShortfall names the source it was given", () => {
  // Catalog-index mode has no workspace; a message sending its reader to workspaces/
  // is a wrong turn at exactly the moment they are debugging a failure.
  assert.match(
    describeInstallShortfall(2, 3, { subject: "catalog index" }) ?? "",
    /part of the catalog index was never validated/,
  );
  assert.match(
    describeInstallShortfall(2, 3, { subject: "workspace" }) ?? "",
    /part of the workspace was never validated/,
  );
});

test("allowExtra accepts more plugins than refs, but never fewer", () => {
  // One OCI image can carry several plugins, so a DEDUPLICATED ref list is a lower
  // bound on the plugin count. Two packages in this repo already share a single ref
  // (workspaces/cost-management/metadata/*), so without this a catalog index carrying
  // both would report fail-install on a healthy run.
  assert.equal(describeInstallShortfall(4, 3, { allowExtra: true }), null);
  assert.equal(describeInstallShortfall(3, 3, { allowExtra: true }), null);
  // A genuine shortfall still fails — allowExtra must not turn the check off.
  assert.notEqual(describeInstallShortfall(2, 3, { allowExtra: true }), null);
});

test("describeInstallShortfall has nothing to compare in single-ref mode", () => {
  // --dynamic-plugins file mode knows no ref count; only "nothing at all" is a fault.
  assert.equal(describeInstallShortfall(3, undefined), null);
  assert.match(
    describeInstallShortfall(0, undefined) ?? "",
    /produced no plugins at all/,
  );
});

test("partitionBootable keeps the skipped and bootable lists complementary", () => {
  const entries = [entry("@s/a"), entry("@s/b"), entry("@s/c")];
  const { skipped, excluded, bootable } = partitionBootable(
    entries,
    (name) => (name === "@s/a" ? { ticket: "RHIDP-1" } : undefined),
    (dirName) => dirName === "@s/b",
  );
  assert.deepEqual(
    bootable.map((e) => e.name),
    ["@s/c"],
  );
  assert.deepEqual(skipped, ["@s/a", "@s/b"]);
  assert.deepEqual(excluded, [{ ticket: "RHIDP-1" }]);
  assert.equal(skipped.length + bootable.length, entries.length);
});

// isServableWithoutNfsEntryPoint — the "served but mounts nothing" signal. Extracted from
// native-smoke.ts because that file ends in process.exit() and cannot be imported.
const mfRemote = (over: Partial<MfRemoteInfo> = {}): MfRemoteInfo => ({
  name: "x",
  remoteEntry: "remoteEntry.js",
  exposes: ["."],
  nfsFeatures: [],
  nfsFeaturesError: null,
  nfsFeaturesExposed: [],
  servable: true,
  ...over,
});

test("a bundle with no mf remote has nothing to report", () => {
  assert.equal(describeNfsShortfall(null), null);
});

test("an unservable remote is not reported — it already failed the run", () => {
  assert.equal(describeNfsShortfall(mfRemote({ servable: false })), null);
});

test("a servable remote declaring no features says the runtime decides", () => {
  // Assert the inputs this case is about, rather than relying on the factory defaults:
  // if those changed, the regex below would still match a message about a different state.
  // nfsModuleFilter.for() returns undefined when backstage.features is absent or empty,
  // so no override is installed and the router advertises EVERY exposed module — the
  // frontend loader then mounts whatever's default export carries an NFS $$type. So this
  // case is "cannot tell from metadata", not "mounts nothing".
  const subject = mfRemote();
  assert.equal(subject.servable, true);
  assert.deepEqual(subject.nfsFeatures, []);
  assert.equal(subject.nfsFeaturesError, null);
  const msg = describeNfsShortfall(subject);
  assert.match(msg ?? "", /declares no backstage\.features/);
  assert.match(msg ?? "", /cannot be determined without executing/);
});

test("a servable remote whose declared features are not exposed mounts nothing", () => {
  // Here backstage.features IS non-empty, so the filter installs and keeps only exposed
  // modules with an NFS type — none of them. This one is definitive.
  const msg = describeNfsShortfall(
    mfRemote({ nfsFeatures: ["./alpha"], nfsFeaturesExposed: [] }),
  );
  assert.match(msg ?? "", /will mount nothing/);
  assert.match(msg ?? "", /does not expose/);
});

test("a servable remote exposing an NFS entry point has nothing to report", () => {
  assert.equal(
    describeNfsShortfall(
      mfRemote({ nfsFeatures: ["./alpha"], nfsFeaturesExposed: ["./alpha"] }),
    ),
    null,
  );
});

test("a failure to read backstage.features yields no verdict at all", () => {
  // "We could not look" must never be recorded as "it declares nothing" — the record in
  // results.json is indistinguishable otherwise, since both give nfsFeatures: [].
  assert.equal(
    describeNfsShortfall(
      mfRemote({
        nfsFeaturesError: "could not read package.json (EISDIR: ...)",
      }),
    ),
    null,
  );
});

// --- config key / bundle name cross-check (RHIDP-16690) ---------------------------

test("findConfigKeyMismatches reports a key no bundle name answers to", () => {
  // The whole point: RHDH matches dynamicPlugins.frontend.<key> against the manifest's
  // name, and when they disagree the plugin loads while every mount point under the key
  // is ignored with nothing logged.
  const found = findConfigKeyMismatches(
    [{ key: "scope.typo", source: "a.yaml" }],
    ["scope.real"],
  );
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    key: "scope.typo",
    source: "a.yaml",
    bundleNames: ["scope.real"],
  });
  // "Naming both sides" is an acceptance criterion, not a nicety: the key alone does not
  // tell a reader what to write instead.
  const message = describeConfigKeyMismatch(found[0]);
  assert.match(message, /scope\.typo/);
  assert.match(message, /bundles report: scope\.real/);
  assert.match(message, /a\.yaml/);
});

test("a key some bundle reports is not a mismatch", () => {
  assert.deepEqual(
    findConfigKeyMismatches(
      [{ key: "scope.real", source: "a.yaml" }],
      ["other.plugin", "scope.real"],
    ),
    [],
  );
});

test("RHDH's own built-in frontend key is never a mismatch", () => {
  // default.main-menu-items is not a plugin name. RHDH filters it out by scope in
  // `ignoreStaticPlugins` before asking Scalprum for anything, so no bundle can or
  // should report it. It is the ONE mismatch across the whole published catalogue, and
  // without this the check would fail global-header on a false positive.
  assert.deepEqual(
    findConfigKeyMismatches(
      [{ key: "default.main-menu-items", source: "global-header.yaml" }],
      ["red-hat-developer-hub.backstage-plugin-global-header"],
    ),
    [],
  );
});

test("the built-in key does not blind the rest of its own workspace", () => {
  // global-header declares both the built-in and its real plugin key. Allowlisting the
  // first must not excuse the second — an allowlist that swallowed the workspace would
  // be worse than no check.
  const found = findConfigKeyMismatches(
    [
      { key: "default.main-menu-items", source: "global-header.yaml" },
      {
        key: "red-hat-developer-hub.backstage-plugin-global-header",
        source: "global-header.yaml",
      },
    ],
    ["something.else"],
  );
  assert.deepEqual(
    found.map((m) => m.key),
    ["red-hat-developer-hub.backstage-plugin-global-header"],
  );
});

test("a key repeated across metadata files is reported once", () => {
  // One key, one fix. Reporting it per file would make a workspace that configures the
  // same plugin from two examples look twice as broken as it is.
  const found = findConfigKeyMismatches(
    [
      { key: "scope.typo", source: "a.yaml" },
      { key: "scope.typo", source: "b.yaml" },
    ],
    [],
  );
  assert.equal(found.length, 1);
});

test("with no bundle names at all the message still reads", () => {
  // A frontend-less workspace, or one whose bundles ship no Scalprum manifest. "bundles
  // report: " with nothing after it is a broken sentence, not a finding.
  const found = findConfigKeyMismatches(
    [{ key: "scope.x", source: "a.yaml" }],
    [],
  );
  assert.match(describeConfigKeyMismatch(found[0]), /bundles report: nothing/);
});

test("a config key mismatch fails the run, below load and start failures", () => {
  assert.equal(computeStatus([], true, 3, [], 1), "fail-bundle");
  assert.equal(computeStatus([], true, 3, [], 0), "pass");
  assert.equal(computeStatus([anError], true, 3, [], 1), "fail-load");
  assert.equal(computeStatus([], false, 3, [], 1), "fail-start");
});

test("both sides of the message survive the sweep panel's truncation", () => {
  // `oneLine` cuts at DETAIL_LIMIT (220) in the failure table, and "naming both sides" is
  // this check's acceptance criterion — a row cut inside the bundle list drops exactly
  // the half that says what to write instead. Realistic lengths: a real key and four
  // real bundle names.
  const found = findConfigKeyMismatches(
    [
      {
        key: "red-hat-developer-hub.plugin-cost-management",
        source: "red-hat-developer-hub-plugin-cost-management.yaml",
      },
    ],
    [
      "backstage-community.plugin-topology",
      "backstage-community.plugin-tekton",
      "backstage-community.plugin-quay",
      "backstage-community.plugin-acr",
    ],
  );
  const message = describeConfigKeyMismatch(found[0]);
  const panelRow = oneLine(message);
  assert.match(panelRow, /red-hat-developer-hub\.plugin-cost-management/);
  assert.match(panelRow, /bundles report: backstage-community\.plugin-acr/);
  // The list is summarised rather than spelled out, which is what keeps it inside 220.
  assert.match(message, /\+1 more/);
});

test("the config-key check is skipped when the bundle names are incomplete", () => {
  // Both cases produce a bundle that contributes no name, so a key belonging to it would
  // read as a metadata defect — blaming a YAML file for a failed pull, or reporting one
  // broken manifest twice under two different causes.
  assert.equal(bundleNamesAreComplete(null, []), true);
  assert.equal(
    bundleNamesAreComplete(
      "installed 2 plugin(s) but the workspace declared 3",
      [],
    ),
    false,
  );
  assert.equal(bundleNamesAreComplete(null, [anError]), false);
});

// ---------------------------------------------------------------------------
// Host plugins for loaded modules (RHIDP-17310)
// ---------------------------------------------------------------------------
const providersPoint = createExtensionPoint<object>({ id: "auth.providers" });

const authModule = createBackendModule({
  pluginId: "auth",
  moduleId: "test-provider",
  register(reg) {
    reg.registerInit({
      deps: { providers: providersPoint },
      async init() {},
    });
  },
});

const catalogLike = createBackendPlugin({
  pluginId: "catalog",
  register(reg) {
    reg.registerInit({ deps: {}, async init() {} });
  },
});

test("featureTargets reads what a plugin and a module register", () => {
  assert.deepEqual(featureTargets(authModule), [
    { kind: "module", pluginId: "auth" },
  ]);
  assert.deepEqual(featureTargets(catalogLike), [
    { kind: "plugin", pluginId: "catalog" },
  ]);
});

test("featureTargets ignores anything that is not a registrations feature", () => {
  assert.deepEqual(featureTargets(undefined), []);
  assert.deepEqual(featureTargets({}), []);
  assert.deepEqual(
    featureTargets({
      $$type: "@backstage/BackendFeature",
      featureType: "registrations",
      getRegistrations: () => {
        throw new Error("boom");
      },
    }),
    [],
  );
});

test("missingHostPluginIds names the hosts nothing in the run provides", () => {
  const targets = [
    { kind: "module" as const, pluginId: "auth" },
    { kind: "module" as const, pluginId: "catalog" },
    { kind: "module" as const, pluginId: "notifications" },
    { kind: "plugin" as const, pluginId: "notifications" },
  ];
  // catalog is a core feature; notifications is loaded as a plugin in the same run.
  assert.deepEqual(missingHostPluginIds(targets, ["catalog"]), ["auth"]);
});

// ---------------------------------------------------------------------------
// Config keys for MF-only bundles (RHIDP-17311)
// ---------------------------------------------------------------------------
test("a key naming an MF-only bundle is set aside, not reported", () => {
  // tekton exported with rhdh-cli 2.1: no dist-scalprum/, package.json still declares
  // scalprum.name = backstage-community.plugin-tekton.
  const configured = [
    { key: "backstage-community.plugin-tekton", source: "tekton.yaml" },
    { key: "backstage-community.plugin-typo", source: "tekton.yaml" },
  ];
  const mfOnly = {
    npmNames: [],
    scalprumNames: ["backstage-community.plugin-tekton"],
  };
  const notApplicable = configKeysNotApplicable(configured, mfOnly);
  assert.deepEqual(notApplicable, ["backstage-community.plugin-tekton"]);
  const mismatches = findConfigKeyMismatches(configured, [], notApplicable);
  assert.deepEqual(
    mismatches.map((m) => m.key),
    ["backstage-community.plugin-typo"],
  );
});

test("without MF-only names the check behaves as before", () => {
  const configured = [{ key: "a.b", source: "x.yaml" }];
  assert.deepEqual(
    findConfigKeyMismatches(configured, []).map((m) => m.key),
    ["a.b"],
  );
  assert.deepEqual(
    configKeysNotApplicable(configured, { npmNames: [], scalprumNames: [] }),
    [],
  );
});

test("a key is set aside when its own package installed MF-only", () => {
  // Newer exports drop `scalprum` from package.json entirely (adoption-insights,
  // github-*, tech-radar); the metadata's package is the only link left.
  const configured = [
    {
      key: "red-hat-developer-hub.backstage-plugin-adoption-insights",
      source: "rhdh-bsp-adoption-insights.yaml",
      packageName: "@red-hat-developer-hub/backstage-plugin-adoption-insights",
    },
    { key: "someone.else", source: "other.yaml", packageName: "@x/other" },
  ];
  const notApplicable = configKeysNotApplicable(configured, {
    npmNames: [
      "@red-hat-developer-hub/backstage-plugin-adoption-insights-dynamic",
    ],
    scalprumNames: [],
  });
  assert.deepEqual(notApplicable, [
    "red-hat-developer-hub.backstage-plugin-adoption-insights",
  ]);
  assert.deepEqual(
    findConfigKeyMismatches(configured, [], notApplicable).map((m) => m.key),
    ["someone.else"],
  );
});

test("expandFeatureLoaders shows startTestBackend the plugin a loader yields", async () => {
  // scorecard-backend's default export is a loader; left as is, startTestBackend adds a
  // placeholder 'scorecard' plugin for each scorecard module and the real one collides.
  const loader = createBackendFeatureLoader({
    *loader() {
      yield catalogLike;
    },
  });
  const { features: expanded } = await expandFeatureLoaders([
    loader,
    authModule,
  ]);
  assert.deepEqual(expanded, [catalogLike, authModule]);
  assert.deepEqual(
    expanded.flatMap((f) => featureTargets(f)),
    [
      { kind: "plugin", pluginId: "catalog" },
      { kind: "module", pluginId: "auth" },
    ],
  );
});

test("expandFeatureLoaders keeps a loader that needs services", async () => {
  const loader = createBackendFeatureLoader({
    deps: { config: coreServices.rootConfig },
    *loader() {
      yield catalogLike;
    },
  });
  assert.deepEqual((await expandFeatureLoaders([loader])).features, [loader]);
});

test("expandFeatureLoaders unwraps the module.exports an import() of CJS yields", async () => {
  // events-backend-module-gitlab's loader returns import('./x.cjs.js') promises.
  const loader = createBackendFeatureLoader({
    // The type forbids the extra level; the runtime shape is exactly this.
    loader: (() => [
      Promise.resolve({ default: { default: authModule } }),
    ]) as unknown as () => [],
  });
  assert.deepEqual((await expandFeatureLoaders([loader])).features, [
    authModule,
  ]);
});

test("expandFeatureLoaders expands a loader that yields another loader", async () => {
  const inner = createBackendFeatureLoader({
    *loader() {
      yield catalogLike;
    },
  });
  const outer = createBackendFeatureLoader({
    *loader() {
      yield inner;
    },
  });
  assert.deepEqual((await expandFeatureLoaders([outer])).features, [
    catalogLike,
  ]);
});

test("expandFeatureLoaders keeps a loader's service factories apart", async () => {
  // The backend skips a loader's factory for a service already provided; flattened in,
  // the same factory becomes an explicit duplicate and fails startup.
  const ref = createServiceRef<object>({ id: "test.loaded", scope: "root" });
  const factory = createServiceFactory({
    service: ref,
    deps: {},
    factory: () => ({}),
  });
  const loader = createBackendFeatureLoader({
    *loader() {
      yield catalogLike;
      yield factory;
    },
  });
  assert.deepEqual(await expandFeatureLoaders([loader, factory]), {
    features: [catalogLike, factory],
    loaderServiceFactories: [factory],
  });
});

test("expandFeatureLoaders unwraps one level, as the backend does", async () => {
  // Two levels are the CJS shape the backend takes off; a third is not, and leaving it
  // in place makes the boot fail here as it does in RHDH.
  const loader = createBackendFeatureLoader({
    loader: (() => [
      Promise.resolve({ default: { default: { default: authModule } } }),
    ]) as unknown as () => [],
  });
  assert.deepEqual((await expandFeatureLoaders([loader])).features, [
    { default: authModule },
  ]);
});

test("bootFeatureList registers loader services before a loader that depends on them", async () => {
  // The dependency-free loader is taken apart by expandFeatureLoaders; its service must
  // still be there when the backend runs the loader that needs it, as it is in RHDH.
  const ref = createServiceRef<{ id: string }>({
    id: "test.fromLoader",
    scope: "root",
  });
  const provider = createBackendFeatureLoader({
    *loader() {
      yield createServiceFactory({
        service: ref,
        deps: {},
        factory: () => ({ id: "x" }),
      });
    },
  });
  let received: { id: string } | undefined;
  const dependent = createBackendFeatureLoader({
    deps: { svc: ref },
    *loader({ svc }) {
      received = svc;
      yield catalogLike;
    },
  });
  const expanded = await expandFeatureLoaders([provider, dependent]);
  const backend = await startTestBackend({
    features: bootFeatureList(expanded, { head: [], tail: [] }),
  });
  await backend.stop();
  // The boot succeeding is not enough on its own: the dependent loader has to have been
  // handed the service the other loader provided.
  assert.deepEqual(received, { id: "x" });
});

test("a failing loader is reported with its description", async () => {
  const loader = createBackendFeatureLoader({
    loader() {
      throw new Error("boom");
    },
  });
  await assert.rejects(
    expandFeatureLoaders([loader]),
    /^Error: Feature loader created at '.*' failed: boom$/,
  );
});
