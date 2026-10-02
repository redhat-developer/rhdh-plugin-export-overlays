/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { excluderFor, loadExclusions, parseExclusions } from "./exclusions";
import {
  imageNameFromRef,
  partitionResolvable,
  pluginPathProblem,
  probeCandidates,
  readCatalogIndexRefs,
  registryRefFromOciRef,
  writeCatalogIndexConfig,
  type ProbeResult,
} from "./catalog-index";
import { tempDir as sharedTempDir } from "./test-support";

// src/ → smoke-tests-native/
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXCLUDES_FILE = join(HARNESS_ROOT, "catalog-index-sanity-excludes.txt");

const REGISTRY = "quay.io/rhdh";
const DIGEST = `sha256:${"a".repeat(64)}`;

const tempDir = () => sharedTempDir(join(tmpdir(), "catalog-index-test-"));

/** Write a dynamic-plugins.default.yaml with the given plugins[] list verbatim. */
function writeIndex(plugins: unknown[]): string {
  const path = join(tempDir(), "dynamic-plugins.default.yaml");
  writeFileSync(path, stringify({ plugins }));
  return path;
}

function ociRef(image: string, digest = DIGEST): string {
  return `oci://${REGISTRY}/${image}@${digest}`;
}

// ---------------------------------------------------------------------------
// imageNameFromRef
// ---------------------------------------------------------------------------
test("imageNameFromRef pulls the image out of every ref shape the index uses", () => {
  assert.equal(imageNameFromRef(ociRef("plugin-a")), "plugin-a");
  assert.equal(
    imageNameFromRef(`oci://${REGISTRY}/plugin-a:2.0.0--1.2.3`),
    "plugin-a",
  );
  assert.equal(
    imageNameFromRef(
      "oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/plugin-a:bs_1.49.4__0.8.2",
    ),
    "plugin-a",
  );
});

test("imageNameFromRef strips the !plugin-path selector", () => {
  // Otherwise the same image with and without a selector reads as two packages, and an
  // anchored exclusion pattern matches only one of them.
  assert.equal(
    imageNameFromRef(`${ociRef("plugin-a")}!plugin-a-dynamic`),
    "plugin-a",
  );
});

test("imageNameFromRef strips a digest that follows a tag", () => {
  // Splitting on ":" first would leave "@sha256" glued to the name.
  assert.equal(
    imageNameFromRef(`oci://${REGISTRY}/plugin-a:2.0.0--1.2.3@${DIGEST}`),
    "plugin-a",
  );
});

test("imageNameFromRef handles a registry with a port", () => {
  // Pinned because the obvious "split on the first colon" returns "localhost".
  assert.equal(
    imageNameFromRef("oci://localhost:5000/foo/plugin-a:tag"),
    "plugin-a",
  );
  assert.equal(
    imageNameFromRef("oci://localhost:5000/plugin-a:tag"),
    "plugin-a",
  );
});

test("imageNameFromRef rejects anything that is not an oci:// ref", () => {
  for (const ref of [
    "./dynamic-plugins/dist/plugin-a",
    "plugin-a",
    "docker://quay.io/rhdh/plugin-a",
    "",
  ]) {
    assert.equal(imageNameFromRef(ref), undefined, ref);
  }
});

test("imageNameFromRef rejects a malformed digest, like the Python validator", () => {
  // scripts/validateCatalogIndex.py reports a truncated digest as `ref-form`. A ref the
  // validator refuses must not be one this mode installs.
  for (const ref of [
    `oci://${REGISTRY}/plugin-a@sha256:abc`,
    `oci://${REGISTRY}/plugin-a:2.0.0--1.2.3@sha256:abc`,
    `oci://${REGISTRY}/plugin-a@notadigest`,
  ]) {
    assert.equal(imageNameFromRef(ref), undefined, ref);
  }
  // A well-formed one still resolves.
  assert.equal(imageNameFromRef(ociRef("plugin-a")), "plugin-a");
});

test("imageNameFromRef rejects a ref that names no image", () => {
  // Without the separator check these pass with the host read as the image name.
  for (const ref of [
    "oci://plugin-a",
    "oci://localhost:5000",
    "oci://quay.io/rhdh/plugin-a/",
    "oci://",
  ]) {
    assert.equal(imageNameFromRef(ref), undefined, ref);
  }
});

// ---------------------------------------------------------------------------
// readCatalogIndexRefs
// ---------------------------------------------------------------------------
test("readCatalogIndexRefs installs every declared package, not just the enabled ones", () => {
  // The index ships most packages disabled as an RHDH product default; honouring that
  // would validate almost nothing.
  const path = writeIndex([
    { package: ociRef("plugin-a"), enabled: true },
    { package: ociRef("plugin-b"), enabled: false },
    { package: ociRef("plugin-c") },
  ]);
  const result = readCatalogIndexRefs(path);
  assert.equal(result.refs.length, 3);
  assert.equal(result.declared, 3);
  assert.equal(result.enabledInIndex, 1);
});

test("readCatalogIndexRefs counts the install CLI's disabled: spelling as enabled", () => {
  const path = writeIndex([
    { package: ociRef("plugin-a"), disabled: false },
    { package: ociRef("plugin-b"), disabled: true },
  ]);
  assert.equal(readCatalogIndexRefs(path).enabledInIndex, 1);
});

test("readCatalogIndexRefs skips packages bundled in the RHDH image", () => {
  // Bundled in the product image — the install CLI skips it, nothing to pull.
  const path = writeIndex([
    { package: ociRef("plugin-a") },
    { package: "./dynamic-plugins/dist/plugin-b-dynamic" },
  ]);
  const result = readCatalogIndexRefs(path);
  assert.deepEqual(result.refs, [ociRef("plugin-a")]);
  assert.deepEqual(result.inImage, ["./dynamic-plugins/dist/plugin-b-dynamic"]);
});

test("readCatalogIndexRefs sorts refs so a run is byte-identical", () => {
  const path = writeIndex([
    { package: ociRef("plugin-c") },
    { package: ociRef("plugin-a") },
    { package: ociRef("plugin-b") },
  ]);
  assert.deepEqual(readCatalogIndexRefs(path).refs, [
    ociRef("plugin-a"),
    ociRef("plugin-b"),
    ociRef("plugin-c"),
  ]);
});

test("readCatalogIndexRefs installs a repeated ref once", () => {
  // Wasted pulls, not a defect — reporting the duplicate is the validator's job.
  const path = writeIndex([
    { package: ociRef("plugin-a"), enabled: true },
    { package: ociRef("plugin-a"), enabled: false },
  ]);
  const result = readCatalogIndexRefs(path);
  assert.deepEqual(result.refs, [ociRef("plugin-a")]);
  assert.equal(result.declared, 2);
});

test("readCatalogIndexRefs drops install-excluded packages and records the ticket", () => {
  const exclusions = parseExclusions(
    "# TODO(RHIDP-1): unpublished\ninstall ^plugin-b$\n",
    "excludes.txt",
  );
  const path = writeIndex([
    { package: ociRef("plugin-a") },
    { package: ociRef("plugin-b") },
  ]);
  const result = readCatalogIndexRefs(path, {
    installExcluded: excluderFor(exclusions, "install"),
  });
  assert.deepEqual(result.refs, [ociRef("plugin-a")]);
  assert.deepEqual(result.excluded, [
    {
      packageName: "plugin-b",
      scope: "install",
      ticket: "RHIDP-1",
      patternSource: "^plugin-b$",
    },
  ]);
});

test("an exclusion is recorded once for a ref the index declares twice", () => {
  // Dedup must precede the exclusion check: a second sighting of one ref is not a
  // second exclusion event.
  const exclusions = parseExclusions(
    "# TODO(RHIDP-1): unpublished\ninstall ^plugin-b$\n",
    "excludes.txt",
  );
  const path = writeIndex([
    { package: ociRef("plugin-a") },
    { package: ociRef("plugin-b") },
    { package: ociRef("plugin-b") },
  ]);
  const result = readCatalogIndexRefs(path, {
    installExcluded: excluderFor(exclusions, "install"),
  });
  assert.deepEqual(result.refs, [ociRef("plugin-a")]);
  assert.equal(result.excluded.length, 1);
});

test("readCatalogIndexRefs says which filter emptied the set", () => {
  // The two cases have different fixes, so the message has to say which fired.
  const onlyInImage = writeIndex([
    { package: "./dynamic-plugins/dist/plugin-a" },
  ]);
  assert.throws(
    () => readCatalogIndexRefs(onlyInImage),
    /1 bundled in the RHDH image/,
  );

  const exclusions = parseExclusions(
    "# TODO(RHIDP-1): x\ninstall ^plugin-a$\n",
    "excludes.txt",
  );
  const allExcluded = writeIndex([{ package: ociRef("plugin-a") }]);
  assert.throws(
    () =>
      readCatalogIndexRefs(allExcluded, {
        installExcluded: excluderFor(exclusions, "install"),
      }),
    /1 excluded/,
  );
});

test("readCatalogIndexRefs reports a missing file as such", () => {
  assert.throws(
    () => readCatalogIndexRefs(join(tempDir(), "absent.yaml")),
    /catalog index file not found/,
  );
});

test("a malformed index fails the run rather than validating nothing", () => {
  const cases: Array<[string, RegExp]> = [
    ["plugins: {}\n", /no 'plugins' list/],
    ["- a\n- b\n", /expected a mapping at the top level/],
    ["plugins:\n  - just-a-string\n", /plugins\[0\] is not a mapping/],
    [
      "plugins:\n  - enabled: true\n",
      /plugins\[0\] has no string 'package' key/,
    ],
    [
      "plugins:\n  - package: docker://quay.io/rhdh/plugin-a\n",
      /is neither an oci:\/\/ ref/,
    ],
  ];
  for (const [content, expected] of cases) {
    const path = join(tempDir(), "dynamic-plugins.default.yaml");
    writeFileSync(path, content);
    assert.throws(() => readCatalogIndexRefs(path), expected, content);
  }
});

// ---------------------------------------------------------------------------
// writeCatalogIndexConfig
// ---------------------------------------------------------------------------
test("writeCatalogIndexConfig produces a config that enables every ref", async () => {
  const dest = tempDir();
  const refs = [ociRef("plugin-a"), ociRef("plugin-b")];
  {
    const path = await writeCatalogIndexConfig(refs, dest);
    const doc = parse(readFileSync(path, "utf8")) as {
      plugins: Array<{ package: string; enabled: boolean }>;
      includes?: unknown;
    };
    assert.deepEqual(
      doc.plugins,
      refs.map((pkg) => ({ package: pkg, enabled: true })),
    );
    // No `includes:` — it would re-import the defaults this mode overrides.
    assert.equal(doc.includes, undefined);
  }
});

test("writeCatalogIndexConfig carries no pluginConfig from the index", async () => {
  // Those blocks hold ${ENV_VAR}s that exist only in a deployed RHDH.
  const path = writeIndex([
    {
      package: ociRef("plugin-a"),
      enabled: true,
      pluginConfig: { app: { analytics: { segment: { writeKey: "${KEY}" } } } },
    },
  ]);
  const { refs } = readCatalogIndexRefs(path);
  const dest = tempDir();
  const out = await writeCatalogIndexConfig(refs, dest);
  assert.equal(readFileSync(out, "utf8").includes("pluginConfig"), false);
});

// ---------------------------------------------------------------------------
// The committed excludes file
// ---------------------------------------------------------------------------
test("the shipped catalog-index excludes file parses", () => {
  // Loaded on every run, and parse errors are fatal.
  assert.doesNotThrow(() => loadExclusions(EXCLUDES_FILE));
});

// ---------------------------------------------------------------------------
// registryRefFromOciRef / partitionResolvable
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

const MISSING = `oci://${REGISTRY}/backstage-plugin-org:2.1.0--0.7.8`;

test("partitionResolvable keeps installing everything but the missing image", async () => {
  // The failure it exists for: one tag-only ref to an unpublished build made the
  // install CLI abort, and the run validated none of the other packages.
  const refs = [ociRef("plugin-a"), MISSING, ociRef("plugin-b")];
  const probe = async (ref: string): Promise<ProbeResult> =>
    ref === MISSING
      ? { ok: false, error: "reading manifest 2.1.0--0.7.8: manifest unknown" }
      : { ok: true };

  const result = await partitionResolvable(refs, probe, { retryDelayMs: 0 });

  assert.deepEqual(result.resolvable, [ociRef("plugin-a"), ociRef("plugin-b")]);
  assert.deepEqual(result.unresolved, [
    {
      ref: MISSING,
      error: "reading manifest 2.1.0--0.7.8: manifest unknown",
    },
  ]);
});

test("partitionResolvable retries a probe before giving up on a ref", async () => {
  // A registry blip must not drop a package that is actually there.
  let calls = 0;
  const flaky = async (): Promise<ProbeResult> => {
    calls += 1;
    return calls < 3 ? { ok: false, error: "503" } : { ok: true };
  };
  const result = await partitionResolvable([ociRef("plugin-a")], flaky, {
    attempts: 3,
    retryDelayMs: 0,
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.resolvable, [ociRef("plugin-a")]);
  assert.deepEqual(result.unresolved, []);
});

test("partitionResolvable reports the last error once the retries run out", async () => {
  let calls = 0;
  const failing = async (): Promise<ProbeResult> => {
    calls += 1;
    return { ok: false, error: `attempt ${calls}` };
  };
  const result = await partitionResolvable([MISSING], failing, {
    attempts: 2,
    retryDelayMs: 0,
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.unresolved, [{ ref: MISSING, error: "attempt 2" }]);
});

test("partitionResolvable keeps the input order under concurrency", async () => {
  // Refs arrive sorted so a run is byte-identical; finishing out of order must not
  // undo that.
  const refs = ["a", "b", "c", "d", "e"].map((name) =>
    ociRef(`plugin-${name}`),
  );
  const delays = [40, 0, 20, 10, 30];
  const probe = async (ref: string): Promise<ProbeResult> => {
    await new Promise((resolve) =>
      setTimeout(resolve, delays[refs.indexOf(ref)]),
    );
    return { ok: true };
  };
  const result = await partitionResolvable(refs, probe, { concurrency: 3 });
  assert.deepEqual(result.resolvable, refs);
});

test("partitionResolvable never runs more probes at once than asked", async () => {
  let running = 0;
  let peak = 0;
  const probe = async (): Promise<ProbeResult> => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return { ok: true };
  };
  const refs = Array.from({ length: 10 }, (_, i) => ociRef(`plugin-${i}`));
  await partitionResolvable(refs, probe, { concurrency: 4 });
  assert.equal(peak, 4);
});

test("partitionResolvable on an empty list probes nothing", async () => {
  const result = await partitionResolvable([], async () => {
    throw new Error("must not be called");
  });
  assert.deepEqual(result, { resolvable: [], unresolved: [] });
});

test("partitionResolvable does not retry an answer that cannot change", async () => {
  let calls = 0;
  const wrong = async (): Promise<ProbeResult> => {
    calls += 1;
    return { ok: false, error: "no plugins declared", retry: false };
  };
  const result = await partitionResolvable([ociRef("plugin-a")], wrong, {
    attempts: 3,
    retryDelayMs: 0,
  });
  assert.equal(calls, 1);
  assert.equal(result.unresolved.length, 1);
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
