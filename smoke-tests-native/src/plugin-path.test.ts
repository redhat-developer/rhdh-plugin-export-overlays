/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  declaredPluginPaths,
  pluginPathProblem,
  pluginSelector,
  probeCandidates,
  registryRefFromOciRef,
  selectedPluginPathProblem,
} from "./plugin-path";

const REGISTRY = "quay.io/rhdh";
const DIGEST = `sha256:${"a".repeat(64)}`;

function ociRef(image: string, digest = DIGEST): string {
  return `oci://${REGISTRY}/${image}@${digest}`;
}

// ---------------------------------------------------------------------------
// registryRefFromOciRef / probeCandidates
// ---------------------------------------------------------------------------
test("registryRefFromOciRef hands skopeo the image reference and nothing else", () => {
  assert.equal(
    registryRefFromOciRef(`oci://${REGISTRY}/plugin-a:2.1.0--0.7.8`),
    `${REGISTRY}/plugin-a:2.1.0--0.7.8`,
  );
  assert.equal(
    registryRefFromOciRef(`${ociRef("plugin-a")}!some-plugin-path`),
    `${REGISTRY}/plugin-a@${DIGEST}`,
  );
  assert.throws(() => registryRefFromOciRef("./dynamic-plugins/dist/x"));
});

test("probeCandidates follows the install CLI's fallback to quay", () => {
  // An RC index names registry.access.redhat.com images before they are released;
  // the CLI pulls them from quay.io/rhdh, so the probe must not call them missing.
  assert.deepEqual(
    probeCandidates(
      "oci://registry.access.redhat.com/rhdh/plugin-a:1.10.0--0.7.8!plugin-a",
    ),
    [
      "registry.access.redhat.com/rhdh/plugin-a:1.10.0--0.7.8",
      "quay.io/rhdh/plugin-a:1.10.0--0.7.8",
    ],
  );
  assert.deepEqual(probeCandidates(ociRef("plugin-a")), [
    `${REGISTRY}/plugin-a@${DIGEST}`,
  ]);
  // Only the productized rhdh namespace falls back, as in the CLI.
  assert.deepEqual(
    probeCandidates("oci://registry.access.redhat.com/other/plugin-a:1"),
    ["registry.access.redhat.com/other/plugin-a:1"],
  );
});

// ---------------------------------------------------------------------------
// pluginPathProblem — mirrors the install CLI's plugin-path auto-detection
// ---------------------------------------------------------------------------
const annotated = (entries: unknown) =>
  JSON.stringify({
    annotations: {
      "io.backstage.dynamic-packages": Buffer.from(
        JSON.stringify(entries),
      ).toString("base64"),
    },
  });

test("pluginPathProblem accepts an image declaring exactly one plugin", () => {
  assert.equal(
    pluginPathProblem(ociRef("plugin-a"), annotated([{ "plugin-a": {} }])),
    undefined,
  );
});

test("pluginPathProblem rejects the empty annotation the next index shipped", () => {
  // The scorecard dependabot module: the image exists, its annotation is "".
  const manifest = JSON.stringify({
    annotations: { "io.backstage.dynamic-packages": "" },
  });
  assert.match(
    pluginPathProblem(ociRef("plugin-a"), manifest) ?? "",
    /no plugins declared/,
  );
  assert.match(
    pluginPathProblem(ociRef("plugin-a"), JSON.stringify({})) ?? "",
    /no plugins declared/,
  );
  assert.match(
    pluginPathProblem(ociRef("plugin-a"), annotated([])) ?? "",
    /lists none/,
  );
});

test("pluginPathProblem rejects several plugins with no selector", () => {
  const manifest = annotated([{ a: {} }, { b: {} }]);
  assert.match(
    pluginPathProblem(ociRef("plugin-a"), manifest) ?? "",
    /2 plugins/,
  );
  // With a selector the CLI never reads the annotation, so neither does this.
  assert.equal(
    pluginPathProblem(`${ociRef("plugin-a")}!a`, manifest),
    undefined,
  );
});

test("pluginPathProblem names a manifest or annotation it cannot decode", () => {
  assert.match(
    pluginPathProblem(ociRef("plugin-a"), "not json") ?? "",
    /not JSON/,
  );
  const garbled = JSON.stringify({
    annotations: { "io.backstage.dynamic-packages": "%%%" },
  });
  assert.match(
    pluginPathProblem(ociRef("plugin-a"), garbled) ?? "",
    /not base64-encoded JSON/,
  );
});

// ---------------------------------------------------------------------------
// selectedPluginPathProblem — also checks the selector, which the CLI does not
// ---------------------------------------------------------------------------
test("pluginSelector tells no selector from a bare '!'", () => {
  assert.equal(pluginSelector(ociRef("plugin-a")), undefined);
  assert.equal(pluginSelector(`${ociRef("plugin-a")}!plugin-a`), "plugin-a");
  assert.equal(pluginSelector(`${ociRef("plugin-a")}!`), "");
});

test("declaredPluginPaths lists every path the annotation declares", () => {
  assert.deepEqual(declaredPluginPaths(annotated([{ a: {} }, { b: {} }])), {
    paths: ["a", "b"],
  });
});

test("selectedPluginPathProblem accepts a selector the image declares", () => {
  // The cost-management bundle: one image, several plugins, each picked by path.
  const manifest = annotated([{ frontend: {} }, { backend: {} }]);
  assert.equal(
    selectedPluginPathProblem(`${ociRef("bundle")}!backend`, manifest),
    undefined,
  );
});

test("selectedPluginPathProblem rejects a selector the image does not declare", () => {
  // scaffolder-backend-module-azure: `!…-azure-dynamic` against a declared `…-azure`.
  const problem = selectedPluginPathProblem(
    `${ociRef("azure")}!azure-dynamic`,
    annotated([{ azure: {} }]),
  );
  assert.equal(problem, "selects !azure-dynamic, but the image declares azure");
});

test("selectedPluginPathProblem rejects a bare trailing '!'", () => {
  assert.match(
    selectedPluginPathProblem(`${ociRef("a")}!`, annotated([{ a: {} }])) ?? "",
    /bare '!'/,
  );
});

test("selectedPluginPathProblem rejects a selector on an image declaring nothing", () => {
  assert.match(
    selectedPluginPathProblem(`${ociRef("a")}!a`, JSON.stringify({})) ?? "",
    /^selects !a, but no plugins declared/,
  );
});

test("selectedPluginPathProblem applies the auto-detect rule without a selector", () => {
  assert.equal(
    selectedPluginPathProblem(ociRef("a"), annotated([{ a: {} }])),
    undefined,
  );
  assert.match(
    selectedPluginPathProblem(ociRef("a"), annotated([{ a: {} }, { b: {} }])) ??
      "",
    /2 plugins in the image \(a, b\)/,
  );
});
