/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { excluderFor, loadExclusions, parseExclusions } from "./exclusions";
import {
  imageNameFromRef,
  readCatalogIndexRefs,
  writeCatalogIndexConfig,
} from "./catalog-index";

// src/ → smoke-tests-native/
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXCLUDES_FILE = join(HARNESS_ROOT, "catalog-index-sanity-excludes.txt");

const REGISTRY = "quay.io/rhdh";
const DIGEST = `sha256:${"a".repeat(64)}`;

// Same leak guard as workspace.test.ts: an unbounded pile of temp dirs per run.
const TEMP_DIRS: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "catalog-index-test-"));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

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
      plugins: Array<{ package: string; disabled: boolean }>;
      includes?: unknown;
    };
    assert.deepEqual(
      doc.plugins,
      refs.map((pkg) => ({ package: pkg, disabled: false })),
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
