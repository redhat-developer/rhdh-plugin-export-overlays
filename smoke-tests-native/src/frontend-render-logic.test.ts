/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  evaluateFrontendRender,
  frontendRenderFailed,
  isFrontendRole,
  packageForAssetUrl,
  parseRemotes,
  type BrowserMessage,
  type FrontendRemote,
} from "./frontend-render-logic";

const BASE = "http://localhost:7007/.backstage/dynamic-features/remotes";

const QUAY: FrontendRemote = {
  packageName: "@backstage-community/plugin-quay",
  remoteName: "backstage_community__plugin_quay",
  exposedModules: ["."],
};
const QUAY_ALPHA: FrontendRemote = {
  packageName: "@backstage-community/plugin-quay-alpha",
  remoteName: "backstage_community__plugin_quay_alpha",
  exposedModules: ["."],
};

/** The lines @backstage/frontend-dynamic-feature-loader logs, verbatim. */
const loaded = (r: FrontendRemote, module = r.remoteName): BrowserMessage => ({
  type: "info",
  text: `Remote module '${module}' of dynamic plugin '${r.packageName}' loaded from ${BASE}/${r.packageName}/remoteEntry.js`,
});
const failed = (r: FrontendRemote, error: string): BrowserMessage => ({
  type: "error",
  text: `Failed loading remote module '${r.remoteName}' of dynamic plugin '${r.packageName}': ${error}`,
});
const notAFeature = (r: FrontendRemote): BrowserMessage => ({
  type: "debug",
  text: `Skipping dynamic plugin remote module '${r.remoteName}' since it doesn't export a new 'FrontendFeature' or 'FrontendFeatureLoader' as default export.`,
});
const empty = (r: FrontendRemote): BrowserMessage => ({
  type: "warning",
  text: `Skipping empty dynamic plugin remote module '${r.remoteName}'.`,
});

function evaluate(
  overrides: Partial<Parameters<typeof evaluateFrontendRender>[0]>,
) {
  return evaluateFrontendRender({
    expected: [QUAY.packageName],
    excluded: [],
    remotes: [QUAY],
    messages: [],
    failedRequests: [],
    ...overrides,
  });
}

const outcomes = (report: ReturnType<typeof evaluate>) =>
  report.results.map((r) => [r.packageName, r.outcome]);

test("parseRemotes reads the remotes endpoint shape", () => {
  assert.deepEqual(
    parseRemotes([
      {
        packageName: QUAY.packageName,
        remoteInfo: { name: QUAY.remoteName, entry: `${BASE}/x` },
        exposedModules: ["."],
      },
    ]),
    [QUAY],
  );
});

test("parseRemotes rejects a body that is not the remotes list", () => {
  assert.throws(() => parseRemotes({}), /expected an array/);
  assert.throws(
    () => parseRemotes([{ packageName: "x", exposedModules: [] }]),
    /malformed entry/,
  );
});

test("a package whose module loaded and exports a feature rendered", () => {
  const report = evaluate({ messages: [loaded(QUAY)] });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "rendered"]]);
  assert.equal(frontendRenderFailed(report), false);
});

test("a module that throws while loading fails the run with its error", () => {
  const report = evaluate({
    messages: [failed(QUAY, "TypeError: Cannot read properties of undefined")],
  });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "failed"]]);
  assert.deepEqual(report.results[0].errors, [
    `${QUAY.remoteName}: TypeError: Cannot read properties of undefined`,
  ]);
  assert.equal(frontendRenderFailed(report), true);
});

test("a failed asset request is attributed to its package and fails it", () => {
  const report = evaluate({
    messages: [loaded(QUAY)],
    failedRequests: [
      {
        url: `${BASE}/${QUAY.packageName}/static/chunk.js`,
        failure: "HTTP 404",
      },
    ],
  });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "failed"]]);
  assert.match(report.results[0].errors[0], /chunk\.js: HTTP 404$/);
});

test("an asset URL is attributed to its own package, not a prefix of it", () => {
  const remotes = [QUAY, QUAY_ALPHA];
  assert.equal(
    packageForAssetUrl(`${BASE}/${QUAY_ALPHA.packageName}/a.js`, remotes),
    QUAY_ALPHA.packageName,
  );
  assert.equal(
    packageForAssetUrl(`${BASE}/%40backstage-community/plugin-quay/a.js`, [
      QUAY,
    ]),
    QUAY.packageName,
  );
  assert.equal(
    packageForAssetUrl("http://localhost:7007/api/catalog", remotes),
    undefined,
  );
});

test("an expected package the backend does not serve is reported, not failed", () => {
  const report = evaluate({ remotes: [] });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "not-served"]]);
  assert.equal(frontendRenderFailed(report), false);
});

test("a served remote the loader never reported on fails the run", () => {
  const report = evaluate({ messages: [] });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "not-reported"]]);
  assert.equal(frontendRenderFailed(report), true);
});

test("modules that load but export no feature are reported, not failed", () => {
  const report = evaluate({ messages: [loaded(QUAY), notAFeature(QUAY)] });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "no-feature"]]);
  assert.equal(frontendRenderFailed(report), false);
});

test("an empty module has no loaded line and still counts as reported", () => {
  const report = evaluate({ messages: [empty(QUAY)] });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "no-feature"]]);
  assert.equal(frontendRenderFailed(report), false);
});

test("one feature among several modules is enough to render", () => {
  const remote = { ...QUAY, exposedModules: [".", "alpha"] };
  const report = evaluate({
    remotes: [remote],
    messages: [
      loaded(remote),
      notAFeature(remote),
      loaded(remote, `${remote.remoteName}/alpha`),
    ],
  });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "rendered"]]);
});

test("a remote exposing no modules contributes nothing and is not a failure", () => {
  const report = evaluate({ remotes: [{ ...QUAY, exposedModules: [] }] });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "no-feature"]]);
});

test("metadata and installed names match with and without -dynamic", () => {
  const installed = { ...QUAY, packageName: `${QUAY.packageName}-dynamic` };
  const report = evaluate({
    remotes: [installed],
    messages: [loaded(installed)],
  });
  assert.deepEqual(outcomes(report), [[QUAY.packageName, "rendered"]]);
});

test("a loader error that is not tied to one package fails the run", () => {
  const report = evaluate({
    messages: [
      loaded(QUAY),
      {
        type: "error",
        text: "Failed fetching module federation configuration of dynamic frontend plugins: 500 - Internal Server Error",
      },
    ],
  });
  assert.equal(report.globalErrors.length, 1);
  assert.equal(frontendRenderFailed(report), true);
});

test("a shell that never rendered fails the run even when every package loaded", () => {
  const report = evaluate({
    messages: [loaded(QUAY)],
    shellError: "the sidebar never appeared",
  });
  assert.equal(frontendRenderFailed(report), true);
});

test("unrelated console errors do not fail a package", () => {
  const report = evaluate({
    messages: [
      loaded(QUAY),
      { type: "error", text: "Failed to load resource: 401 /api/catalog" },
    ],
  });
  assert.equal(frontendRenderFailed(report), false);
});

test("isFrontendRole covers the two frontend roles only", () => {
  assert.equal(isFrontendRole("frontend-plugin"), true);
  assert.equal(isFrontendRole("frontend-plugin-module"), true);
  assert.equal(isFrontendRole("backend-plugin"), false);
});
