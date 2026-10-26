/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExclusions } from "./exclusions";
import { parseEnvText } from "./test-config";
import {
  DUMMY_ENV_VALUE,
  applyProbeResult,
  backendStartupFailed,
  buildEnv,
  buildDynamicPluginsConfig,
  chartStream,
  failedPluginIds,
  failureLines,
  imageBaseName,
  imagesFromChartValues,
  installDirName,
  isImageRef,
  mergeAppConfig,
  newestCiChart,
  normalizeChartVersion,
  findNotInstalled,
  findNotLoaded,
  parseLoadedPlugins,
  passed,
  renderError,
  renderSummary,
  shortError,
  skippedImages,
  unsetEnvVars,
  type SanityReport,
} from "./release-sanity-logic";

// src/ → smoke-tests-native/
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
  assert.deepEqual(findNotLoaded(installed, new Set(["b"])), [
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
    chartVersion: "2.2-79-CI",
    image: "img",
    catalogIndex: "idx",
    requested: 2,
    installed: 2,
    loaded: 2,
    notLoaded: [],
    skipped: [],
    unresolved: [],
    notInstalled: [],
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
  assert.equal(passed(report({ notInstalled: ["oci://x"] })), false);
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

test("notInstalled reads the install log, ignoring the plugin-path selector", () => {
  const log = [
    "\t==> Installed oci://q/a@sha256:1!a",
    "\t==> Installed oci://q/b:tag!b-plugin",
    "======= Skipping disabled plugin oci://q/c:tag",
  ].join("\n");
  assert.deepEqual(
    findNotInstalled(
      ["oci://q/b:tag", "oci://q/a@sha256:1", "oci://q/c:tag"],
      log,
    ),
    ["oci://q/c:tag"],
  );
});

test("shortError keeps the cause of a skopeo failure", () => {
  const error =
    'time="x" level=fatal msg="Error parsing image name \\"docker://ghcr.io/o/r/p:t\\": reading manifest t in ghcr.io/o/r/p: manifest unknown"';
  assert.equal(shortError(error), "manifest unknown");
  assert.equal(shortError("no answer within 30s"), "no answer within 30s");
});

test("normalizeChartVersion rebuilds a CI chart version and rejects anything else", () => {
  assert.equal(normalizeChartVersion("2.2-79-CI"), "2.2-79-CI");
  assert.equal(normalizeChartVersion("2.02-079-CI"), "2.2-79-CI");
  assert.throws(() => normalizeChartVersion("2.2-79"), /must look like/);
  assert.throws(
    () => normalizeChartVersion("2.2-79-CI; echo"),
    /must look like/,
  );
});

test("release-sanity-excludes.txt parses, and every entry is install-scoped", () => {
  const exclusions = loadExclusions(
    join(HARNESS_ROOT, "release-sanity-excludes.txt"),
  );
  assert.ok(exclusions.length > 0);
  assert.ok(exclusions.every((e) => e.scope === "install"));
});

test("buildDynamicPluginsConfig lists a ref the index declares twice once", () => {
  const ref = `oci://quay.io/rhdh/twice@${DIGEST}`;
  const config = buildDynamicPluginsConfig([ref, ref], [], () => false);
  assert.deepEqual(config.plugins, [{ package: ref, enabled: true }]);
});

test("parseEnvText reads KEY=VALUE, strips quotes, reports malformed lines", () => {
  const text = "# comment\nA=1\nB=\"two words\"\n\nC='x=y'\nmalformed\n";
  assert.deepEqual(parseEnvText(text), {
    entries: [
      ["A", "1"],
      ["B", "two words"],
      ["C", "x=y"],
    ],
    malformed: ["malformed"],
  });
});

test("installDirName prefers the plugin-path selector", () => {
  assert.equal(
    installDirName(
      "oci://ghcr.io/o/r/x2a-dcr:bs_1__1!red-hat-developer-hub-backstage-plugin-x2a",
    ),
    "red-hat-developer-hub-backstage-plugin-x2a",
  );
  assert.equal(installDirName(`oci://quay.io/rhdh/foo@${DIGEST}`), "foo");
});

test("notInstalled accepts the CLI's already-installed line", () => {
  const log = "\t==> oci://q/a:tag!a: already installed, skipping";
  assert.deepEqual(findNotInstalled(["oci://q/a:tag"], log), []);
});

test("failureLines reports a message repeated every few seconds once", () => {
  const log = [
    "2026-10-26T12:44:44.895Z catalog error Missing required config value at 'mta.url'",
    "2026-10-26T12:44:50.011Z catalog error Missing required config value at 'mta.url'",
  ].join("\n");
  assert.equal(failureLines(log).length, 1);
});

test("renderSummary bounds lists and keeps log lines inside their fence", () => {
  const md = renderSummary(
    report({
      notInstalled: Array.from({ length: 40 }, (_, i) => `oci://q/p${i}`),
      failures: ["error ``` @someone " + "x".repeat(400)],
    }),
  );
  assert.match(md, /`oci:\/\/q\/p29`/);
  assert.doesNotMatch(md, /`oci:\/\/q\/p30`/);
  assert.match(md, /and 10 more/);
  assert.equal(md.match(/```/g)?.length, 2);
  assert.doesNotMatch(md, /@someone/);
});

test("renderError explains a run that produced no report", () => {
  const md = renderError(
    "only the 2.2 stream is supported for now",
    "https://run",
  );
  assert.match(md, /error/);
  assert.match(md, /only the 2\.2 stream/);
  assert.match(md, /Run: https:\/\/run/);
});

test("isImageRef accepts registry refs and rejects anything that could be an option", () => {
  assert.equal(isImageRef(`quay.io/rhdh/rhdh-hub-rhel10@${DIGEST}`), true);
  assert.equal(isImageRef("quay.io/rhdh/plugin-catalog-index:2.1"), true);
  assert.equal(isImageRef("localhost:5000/ns/img:tag"), true);
  assert.equal(isImageRef("--privileged"), false);
  assert.equal(isImageRef("--rm/x"), false);
  assert.equal(isImageRef("-v/etc:x"), false);
  assert.equal(isImageRef("quay.io/rhdh/x:1 --rm"), false);
  assert.equal(isImageRef("img"), false);
  assert.equal(isImageRef("quay.io/rhdh/x@sha256:short"), false);
});

test("applyProbeResult switches off unresolved refs and leaves the input alone", () => {
  const config = buildDynamicPluginsConfig(
    ["oci://q/a:1", "oci://q/b:1"],
    [],
    () => false,
  );
  const probed = applyProbeResult(config, new Set(["oci://q/b:1"]));
  assert.deepEqual(probed.plugins, [
    { package: "oci://q/a:1", enabled: true },
    { package: "oci://q/b:1", enabled: false },
  ]);
  assert.equal(config.plugins[1].enabled, true);
});

test("skippedImages lists exclusions, not unresolved refs, once and sorted", () => {
  const config = {
    includes: [],
    plugins: [
      { package: "oci://q/excluded:1", enabled: false },
      { package: "oci://q/unresolved:1", enabled: false },
      { package: "oci://q/kept:1", enabled: true },
    ],
  };
  assert.deepEqual(
    skippedImages(
      config,
      new Set(["oci://q/unresolved:1"]),
      ["oci://g/community-b:1", "oci://g/community-a:1", "oci://g/kept-c:1"],
      ["oci://g/kept-c:1"],
    ),
    ["community-a", "community-b", "excluded"],
  );
});

test("buildEnv lets the environment win, then fills referenced variables", () => {
  const env = buildEnv(
    { TOKEN: "placeholder", URL: "http://example" },
    { TOKEN: "real-secret", UNRELATED: "x" },
    ["token: ${TOKEN} url: ${URL} other: ${MISSING}"],
  );
  assert.deepEqual(env, {
    TOKEN: "real-secret",
    URL: "http://example",
    MISSING: DUMMY_ENV_VALUE,
  });
});

test("a check error is not reported as a backend that did not start", () => {
  const failed = report({ checkError: "guest sign-in responded 401" });
  assert.equal(passed(failed), false);
  const md = renderSummary(failed);
  assert.match(
    md,
    /The check could not finish:\*\* guest sign-in responded 401/,
  );
  assert.doesNotMatch(md, /did not start/);
});
