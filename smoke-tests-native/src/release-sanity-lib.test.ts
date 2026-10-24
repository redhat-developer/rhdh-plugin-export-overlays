/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildDynamicPluginsConfig,
  chartStream,
  backendStartupFailed,
  failedPluginIds,
  failureLines,
  mergeAppConfig,
  imageBaseName,
  imagesFromChartValues,
  newestCiChart,
  notLoaded,
  parseLoadedPlugins,
  parseSanityCommand,
  passed,
  renderSummary,
  unsetEnvVars,
  type SanityReport,
} from "./release-sanity-lib";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("newestCiChart picks the highest build of the stream", () => {
  const tags = [
    "2.1-9-CI",
    "2.1-158-CI",
    "2.1-41-CI",
    "2.2-19-CI",
    "2.1",
    "latest",
  ];
  assert.equal(newestCiChart(tags, "2.1"), "2.1-158-CI");
});

test("newestCiChart defaults to the newest stream, comparing versions numerically", () => {
  // 2.10 is newer than 2.9; a string sort would pick 2.9.
  assert.equal(
    newestCiChart(["2.9-50-CI", "2.10-3-CI", "1.10-99-CI"]),
    "2.10-3-CI",
  );
});

test("newestCiChart fails when the stream has no CI chart", () => {
  assert.throws(() => newestCiChart(["2.1-1-CI"], "2.2"), /stream '2.2'/);
});

test("chartStream rejects anything but a CI chart version", () => {
  assert.equal(chartStream("2.1-158-CI"), "2.1");
  assert.throws(() => chartStream("2.1-158"));
});

test("imagesFromChartValues reads the digest-pinned hub image and catalog index", () => {
  const values = `
image:
  registry: quay.io
  repository: rhdh/rhdh-hub-rhel10
  tag: ''
  digest: ${DIGEST}
catalogIndex:
  image:
    registry: quay.io
    repository: rhdh/plugin-catalog-index
    tag: '2.1'
`;
  assert.deepEqual(imagesFromChartValues(values), {
    image: `quay.io/rhdh/rhdh-hub-rhel10@${DIGEST}`,
    catalogIndex: "quay.io/rhdh/plugin-catalog-index:2.1",
  });
});

test("imagesFromChartValues fails when an image has neither digest nor tag", () => {
  const values = `
image: { registry: quay.io, repository: rhdh/hub, tag: '', digest: '' }
catalogIndex: { image: { registry: quay.io, repository: rhdh/idx, tag: x } }
`;
  assert.throws(() => imagesFromChartValues(values), /image has neither/);
});

test("parseSanityCommand accepts only a CI chart version", () => {
  assert.equal(parseSanityCommand("/sanity 2.1-158-CI"), "2.1-158-CI");
  assert.equal(parseSanityCommand("  /sanity 2.1-158-CI \n"), "2.1-158-CI");
  assert.equal(parseSanityCommand("/sanity 2.1-158-CI; rm -rf /"), undefined);
  assert.equal(parseSanityCommand("/sanity $(whoami)"), undefined);
  assert.equal(parseSanityCommand("/sanity"), undefined);
  assert.equal(parseSanityCommand("please /sanity 2.1-158-CI"), undefined);
});

test("imageBaseName strips registry, digest, tag and plugin path", () => {
  assert.equal(
    imageBaseName(`oci://quay.io/rhdh/foo-bar@${DIGEST}`),
    "foo-bar",
  );
  assert.equal(
    imageBaseName("oci://ghcr.io/org/repo/foo:bs_1.54.9__1.0.0!foo"),
    "foo",
  );
  assert.equal(imageBaseName("oci://localhost:5000/ns/foo:1"), "foo");
});

test("buildDynamicPluginsConfig enables the index, adds community, and lets the index win", () => {
  const index = [
    `oci://quay.io/rhdh/shipped@${DIGEST}`,
    `oci://quay.io/rhdh/skipme@${DIGEST}`,
  ];
  const config = buildDynamicPluginsConfig(
    index,
    [
      {
        packageName: "a",
        artifact: "oci://ghcr.io/o/r/community-a:bs_1__1!community-a",
      },
      // Same image as an index package: the shipped build must win.
      {
        packageName: "s",
        artifact: "oci://ghcr.io/o/r/shipped:bs_1__2!shipped",
      },
    ],
    (pkg) => pkg.includes("skipme"),
  );
  assert.deepEqual(config.includes, ["dynamic-plugins.default.yaml"]);
  assert.deepEqual(config.plugins, [
    { package: index[0], enabled: true },
    { package: index[1], enabled: false },
    {
      package: "oci://ghcr.io/o/r/community-a:bs_1__1!community-a",
      enabled: true,
    },
  ]);
});

test("unsetEnvVars lists referenced variables nothing provides, skipping escapes", () => {
  const texts = [
    "target: ${JIRA_URL}",
    "token: ${JIRA_TOKEN} url: ${SET_ONE}",
    "$${ESCAPED} plain $NOT_BRACED",
  ];
  assert.deepEqual(unsetEnvVars(texts, new Set(["SET_ONE"])), [
    "JIRA_TOKEN",
    "JIRA_URL",
  ]);
});

test("parseLoadedPlugins fails on a malformed payload instead of reporting a false mismatch", () => {
  assert.deepEqual(
    parseLoadedPlugins([{ name: "a" }, { name: "b" }]),
    new Set(["a", "b"]),
  );
  assert.throws(() => parseLoadedPlugins({ items: [] }), /expected an array/);
  assert.throws(() => parseLoadedPlugins([{ version: "1" }]), /without a name/);
});

test("notLoaded returns installed plugins missing from the loaded set", () => {
  const installed = [
    { name: "b", dirName: "b-dir" },
    { name: "a", dirName: "a-dir" },
  ];
  assert.deepEqual(notLoaded(installed, new Set(["b"])), [
    { name: "a", dirName: "a-dir" },
  ]);
});

test("failureLines keeps only install and startup failures", () => {
  const log = [
    "info loaded dynamic backend plugin 'x'",
    "error Plugin 'proxy' threw an error during startup",
    "InstallException: Failed to inspect OCI image",
    "warn something harmless",
  ].join("\n");
  assert.equal(failureLines(log).length, 2);
});

function report(overrides: Partial<SanityReport> = {}): SanityReport {
  return {
    image: "img",
    catalogIndex: "idx",
    requested: 2,
    installed: 2,
    loaded: 2,
    notLoaded: [],
    excluded: [],
    unresolved: [],
    failures: [],
    failedPlugins: [],
    ...overrides,
  };
}

test("passed requires a started backend, every request installed and every install loaded", () => {
  assert.equal(passed(report()), true);
  assert.equal(passed(report({ startupError: "exited" })), false);
  assert.equal(
    passed(
      report({ unresolved: [{ ref: "oci://x", error: "manifest unknown" }] }),
    ),
    false,
  );
  assert.equal(passed(report({ installed: 1 })), false);
  assert.equal(passed(report({ installed: 0, requested: 0 })), false);
  assert.equal(
    passed(report({ notLoaded: [{ name: "a", dirName: "a" }] })),
    false,
  );
});

test("renderSummary names the culprits", () => {
  const md = renderSummary(
    report({
      chartVersion: "2.1-158-CI",
      notLoaded: [{ name: "@x/y", dirName: "x-y" }],
    }),
    "https://run",
  );
  assert.match(md, /failed/);
  assert.match(md, /`2.1-158-CI`/);
  assert.match(md, /`@x\/y` \(x-y\)/);
  assert.match(md, /Run: https:\/\/run/);
});

test("mergeAppConfig deep-merges objects and lets later layers win", () => {
  const first = { sonarqube: { baseUrl: "a", token: "t" }, list: [1, 2] };
  const merged = mergeAppConfig([
    first,
    { sonarqube: { baseUrl: "b" }, list: [3] },
  ]);
  assert.deepEqual(merged, {
    sonarqube: { baseUrl: "b", token: "t" },
    list: [3],
  });
  // The inputs are left alone.
  assert.equal(first.sonarqube.baseUrl, "a");
});

test("failureLines keeps install CLI config conflicts", () => {
  const log = [
    "======= 1 plugin(s) failed:",
    "  - oci://x: Config key 'sonarqube.baseUrl' defined differently for 2 dynamic plugins",
  ].join("\n");
  assert.equal(failureLines(log).length, 2);
});

const CRASH_LOG = [
  "\u001b[2m2026-10-23T23:51:27Z\u001b[22m \u001b[34mbackstage\u001b[39m \u001b[31merror\u001b[39m Plugin 'mta' threw an error during startup, waiting for 15 other plugins",
  "error Unhandled rejection Backend startup failed due to the following errors:",
  "  Plugin 'mta' startup failed; caused by Error: connect ECONNREFUSED",
].join("\n");

test("failedPluginIds names each plugin that failed startup once", () => {
  assert.deepEqual(failedPluginIds(CRASH_LOG), ["mta"]);
  assert.deepEqual(failedPluginIds("info all good"), []);
});

test("failureLines strips terminal colour codes", () => {
  const [first] = failureLines(CRASH_LOG);
  assert.ok(
    first.startsWith("2026-10-23T23:51:27Z backstage error Plugin 'mta'"),
  );
});

test("backendStartupFailed spots the backend giving up", () => {
  assert.equal(backendStartupFailed(CRASH_LOG), true);
  assert.equal(backendStartupFailed("Plugin initialization complete"), false);
});
