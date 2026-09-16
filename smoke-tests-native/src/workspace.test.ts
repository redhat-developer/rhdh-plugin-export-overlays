/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { excluderFor, parseExclusions } from "./exclusions";
import {
  collectWorkspaceRefs,
  discoverSmokeTestConfig,
  isValidWorkspaceName,
  readWorkspacePackages,
  writeDynamicPluginsConfig,
} from "./workspace";

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

/**
 * One repo root per test. A shared root plus fixtures created inside tests made these
 * order-dependent: a test could read a workspace another test had written, so one
 * passed only in file order and another passed with no fixture at all.
 */
function freshRepo(): string {
  return tempDir(join(tmpdir(), "workspace-test-"));
}

function makeWorkspace(
  root: string,
  name: string,
  metadata: Record<string, string>,
  smokeTests?: Record<string, string>,
): string {
  const metadataDir = join(root, "workspaces", name, "metadata");
  mkdirSync(metadataDir, { recursive: true });
  for (const [file, content] of Object.entries(metadata)) {
    writeFileSync(join(metadataDir, file), content);
  }
  if (smokeTests) {
    const smokeDir = join(root, "workspaces", name, "smoke-tests");
    mkdirSync(smokeDir, { recursive: true });
    for (const [file, content] of Object.entries(smokeTests)) {
      writeFileSync(join(smokeDir, file), content);
    }
  }
  return root;
}

const OCI_REF = "oci://ghcr.io/example/plugin-a:tag!plugin-a";

test("isValidWorkspaceName rejects separators and dot-only names", () => {
  assert.equal(isValidWorkspaceName("mcp-integrations"), true);
  assert.equal(isValidWorkspaceName("tech-radar.v2"), true);
  assert.equal(isValidWorkspaceName(".."), false);
  assert.equal(isValidWorkspaceName("."), false);
  assert.equal(isValidWorkspaceName("a/b"), false);
  assert.equal(isValidWorkspaceName("../workspaces/acs"), false);
  assert.equal(isValidWorkspaceName(""), false);
});

test("collectWorkspaceRefs collects oci refs and skips local-path artifacts", () => {
  const root = makeWorkspace(freshRepo(), "mixed", {
    "plugin-a.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n`,
    "plugin-b.yaml":
      "spec:\n  dynamicArtifact: ./dynamic-plugins/dist/plugin-b-dynamic\n",
  });
  const { refs, skipped } = collectWorkspaceRefs(root, "mixed");
  assert.deepEqual(refs, [OCI_REF]);
  assert.deepEqual(skipped, ["plugin-b.yaml"]);
});

test("collectWorkspaceRefs throws when no oci refs remain", () => {
  const root = makeWorkspace(freshRepo(), "local-only", {
    "plugin.yaml":
      "spec:\n  dynamicArtifact: ./dynamic-plugins/dist/plugin-dynamic\n",
  });
  assert.throws(
    () => collectWorkspaceRefs(root, "local-only"),
    /nothing to validate/,
  );
});

test("collectWorkspaceRefs throws on unknown workspace and invalid names", () => {
  const root = freshRepo();
  assert.throws(
    () => collectWorkspaceRefs(root, "does-not-exist"),
    /metadata not found/,
  );
  assert.throws(
    () => collectWorkspaceRefs(root, ".."),
    /invalid workspace name/,
  );
});

test("discoverSmokeTestConfig finds both Docker-smoke config files", () => {
  // The positive case for app-config.test.yaml: if that filename regressed, every
  // swept workspace would boot without its config and the failures would read as
  // plugin regressions across the whole catalog.
  const root = makeWorkspace(
    freshRepo(),
    "full",
    { "p.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n` },
    {
      "app-config.test.yaml": "app: {}\n",
      "test.env": "SOME_URL=https://example.com\n",
    },
  );
  const smokeDir = join(root, "workspaces", "full", "smoke-tests");
  assert.deepEqual(discoverSmokeTestConfig(root, "full"), {
    appConfig: join(smokeDir, "app-config.test.yaml"),
    testEnv: join(smokeDir, "test.env"),
  });
});

test("discoverSmokeTestConfig reports each file independently", () => {
  const root = makeWorkspace(
    freshRepo(),
    "env-only",
    { "p.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n` },
    { "test.env": "SOME_URL=https://example.com\n" },
  );
  const found = discoverSmokeTestConfig(root, "env-only");
  assert.equal(found.appConfig, undefined);
  assert.equal(
    found.testEnv,
    join(root, "workspaces", "env-only", "smoke-tests", "test.env"),
  );
});

test("discoverSmokeTestConfig returns nothing for a smoke-tests dir with no config", () => {
  // The negative that actually distinguishes "no config files" from "no workspace":
  // the previous version asserted against a workspace that need not exist at all.
  const root = makeWorkspace(
    freshRepo(),
    "bare",
    { "p.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n` },
    {},
  );
  assert.deepEqual(discoverSmokeTestConfig(root, "bare"), {
    appConfig: undefined,
    testEnv: undefined,
  });
});

test("readWorkspacePackages flattens the fields the sweep filters on", () => {
  const root = makeWorkspace(freshRepo(), "tiers", {
    "community.yaml": [
      "spec:",
      '  packageName: "@scope/plugin-community"',
      `  dynamicArtifact: ${OCI_REF}`,
      "  support: community",
      "  backstage:",
      "    role: backend-plugin",
      "",
    ].join("\n"),
  });
  assert.deepEqual(readWorkspacePackages(root, "tiers"), [
    {
      workspace: "tiers",
      file: "community.yaml",
      packageName: "@scope/plugin-community",
      support: "community",
      role: "backend-plugin",
      artifact: OCI_REF,
      frontendConfigKeys: [],
    },
  ]);
});

test("readWorkspacePackages falls back rather than yielding an empty package name", () => {
  // A package that reaches the support filter with support: "" matches no level and
  // vanishes from every sweep with no warning — the miscount class this whole module
  // is written to avoid. Pin the fallbacks so that stays visible.
  const root = makeWorkspace(freshRepo(), "odd", {
    "no-spec.yaml": "metadata:\n  name: entity-name\n",
    "no-name.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n`,
  });
  assert.deepEqual(readWorkspacePackages(root, "odd"), [
    {
      workspace: "odd",
      file: "no-name.yaml",
      packageName: "no-name.yaml",
      support: "",
      role: "",
      artifact: OCI_REF,
      frontendConfigKeys: [],
    },
    {
      workspace: "odd",
      file: "no-spec.yaml",
      packageName: "entity-name",
      support: "",
      role: "",
      artifact: "",
      frontendConfigKeys: [],
    },
  ]);
});

test("readWorkspacePackages reads .yml and ignores non-metadata files", () => {
  const root = makeWorkspace(freshRepo(), "noise", {
    "b.yml": `spec:\n  packageName: "@scope/b"\n  dynamicArtifact: ${OCI_REF}\n`,
    "a.yaml": `spec:\n  packageName: "@scope/a"\n  dynamicArtifact: ${OCI_REF}\n`,
    "README.md": "# notes\n",
  });
  assert.deepEqual(
    readWorkspacePackages(root, "noise").map((p) => p.file),
    ["a.yaml", "b.yml"],
  );
});

test("a malformed metadata file fails the run rather than dropping the package", () => {
  const root = makeWorkspace(freshRepo(), "broken", {
    "bad.yaml": "spec:\n  - unbalanced: [\n",
  });
  assert.throws(() => readWorkspacePackages(root, "broken"));
});

test("collectWorkspaceRefs narrows to one support level", () => {
  const root = makeWorkspace(freshRepo(), "two-tiers", {
    "a-community.yaml": `spec:\n  packageName: "@scope/a"\n  support: community\n  dynamicArtifact: ${OCI_REF}\n`,
    "b-ga.yaml": `spec:\n  packageName: "@scope/b"\n  support: generally-available\n  dynamicArtifact: ${OCI_REF}-ga\n`,
  });
  const all = collectWorkspaceRefs(root, "two-tiers");
  assert.equal(all.refs.length, 2);
  assert.equal(all.outOfScope, 0);

  const community = collectWorkspaceRefs(root, "two-tiers", {
    support: "community",
  });
  assert.deepEqual(community.refs, [OCI_REF]);
  assert.equal(community.outOfScope, 1);
});

test("collectWorkspaceRefs drops install-excluded packages and records the ticket", () => {
  const root = makeWorkspace(freshRepo(), "excluded", {
    "a.yaml": `spec:\n  packageName: "@scope/keep"\n  dynamicArtifact: ${OCI_REF}\n`,
    "b.yaml": `spec:\n  packageName: "@scope/drop"\n  dynamicArtifact: ${OCI_REF}-drop\n`,
  });
  const exclusions = parseExclusions(
    "# TODO(RHIDP-1): unpublished.\ninstall ^@scope/drop$\n",
    "test",
  );
  const { refs, excluded } = collectWorkspaceRefs(root, "excluded", {
    installExcluded: excluderFor(exclusions, "install"),
  });
  assert.deepEqual(refs, [OCI_REF]);
  assert.deepEqual(excluded, [
    {
      packageName: "@scope/drop",
      scope: "install",
      ticket: "RHIDP-1",
      patternSource: "^@scope/drop$",
    },
  ]);
});

test("collectWorkspaceRefs says which filter emptied the set", () => {
  // A support filter that matches nothing must not read like a workspace with no
  // published artifacts — the two have different fixes.
  const root = makeWorkspace(freshRepo(), "two-tiers", {
    "a-community.yaml": `spec:\n  support: community\n  dynamicArtifact: ${OCI_REF}\n`,
    "b-ga.yaml": `spec:\n  support: generally-available\n  dynamicArtifact: ${OCI_REF}\n`,
  });
  assert.throws(
    () => collectWorkspaceRefs(root, "two-tiers", { support: "dev-preview" }),
    /2 at another support level.*nothing to validate/,
  );
});

test("writeDynamicPluginsConfig produces the yaml the install CLI consumes", async () => {
  const dest = tempDir(join(tmpdir(), "dp-out-"));
  const path = await writeDynamicPluginsConfig([OCI_REF], dest);
  const doc = parse(readFileSync(path, "utf8")) as {
    plugins: Array<{ package: string }>;
  };
  assert.deepEqual(doc.plugins, [{ package: OCI_REF }]);
});

test("readWorkspacePackages sorts metadata files whatever order readdir returns", () => {
  // Same reason as listWorkspaces: the filesystem's own ordering hides this.
  const root = makeWorkspace(freshRepo(), "ordered", {
    "a.yaml": `spec:\n  packageName: "@scope/a"\n  dynamicArtifact: ${OCI_REF}\n`,
    "m.yml": `spec:\n  packageName: "@scope/m"\n  dynamicArtifact: ${OCI_REF}\n`,
    "z.yaml": `spec:\n  packageName: "@scope/z"\n  dynamicArtifact: ${OCI_REF}\n`,
  });
  assert.deepEqual(
    readWorkspacePackages(root, "ordered", () => [
      "z.yaml",
      "a.yaml",
      "m.yml",
    ]).map((p) => p.file),
    ["a.yaml", "m.yml", "z.yaml"],
  );
});

// --- dynamicPlugins.frontend keys (RHIDP-16690) -----------------------------------

test("readWorkspacePackages collects dynamicPlugins.frontend keys across examples", () => {
  // global-header's real shape: two keys, one of them RHDH's built-in namespace. Both
  // are collected here — deciding which of them may go unmatched is the checker's job
  // (findConfigKeyMismatches), not the reader's.
  const root = makeWorkspace(freshRepo(), "hdr", {
    "a.yaml": [
      "spec:",
      '  packageName: "@scope/hdr"',
      `  dynamicArtifact: ${OCI_REF}`,
      "  appConfigExamples:",
      "    - content:",
      "        dynamicPlugins:",
      "          frontend:",
      "            default.main-menu-items:",
      "              menuItems: {}",
      "    - content:",
      "        dynamicPlugins:",
      "          frontend:",
      "            scope.hdr:",
      "              mountPoints: []",
      "",
    ].join("\n"),
  });
  assert.deepEqual(readWorkspacePackages(root, "hdr")[0].frontendConfigKeys, [
    "default.main-menu-items",
    "scope.hdr",
  ]);
});

test("a malformed appConfigExamples yields no keys rather than throwing", () => {
  // Repo YAML that no schema validates at rest. Every one of these shapes reached the
  // reader during development; a cast instead of the checks would have published
  // "0"/"1" (a list's indices) as plugin names, or thrown and failed the whole run for
  // a package that simply configures nothing.
  const root = makeWorkspace(freshRepo(), "odd", {
    "a.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n  appConfigExamples: "not-a-list"\n`,
    "b.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n  appConfigExamples:\n    - content: "a string"\n`,
    "c.yaml": [
      "spec:",
      `  dynamicArtifact: ${OCI_REF}`,
      "  appConfigExamples:",
      "    - content:",
      "        dynamicPlugins:",
      "          frontend:",
      "            - listed",
      "",
    ].join("\n"),
  });
  for (const pkg of readWorkspacePackages(root, "odd")) {
    assert.deepEqual(
      pkg.frontendConfigKeys,
      [],
      `${pkg.file} should yield no keys`,
    );
  }
});

test("collectWorkspaceRefs returns keys only for the packages it included", () => {
  // The bug this shape exists to prevent: a --support sweep installs a subset, so a key
  // belonging to a filtered-out package would match no installed bundle and be reported
  // as a defect. The check would go red on exactly the runs that validate less.
  const meta = (name: string, support: string, key: string) =>
    [
      "spec:",
      `  packageName: "@scope/${name}"`,
      `  dynamicArtifact: ${OCI_REF}`,
      `  support: ${support}`,
      "  appConfigExamples:",
      "    - content:",
      "        dynamicPlugins:",
      "          frontend:",
      `            ${key}: {}`,
      "",
    ].join("\n");
  const root = makeWorkspace(freshRepo(), "mixed", {
    "ga.yaml": meta("ga", "generally-available", "scope.ga"),
    "comm.yaml": meta("comm", "community", "scope.comm"),
  });
  assert.deepEqual(
    collectWorkspaceRefs(root, "mixed", { support: "community" })
      .frontendConfigKeys,
    [{ key: "scope.comm", source: "comm.yaml" }],
  );
  assert.deepEqual(
    collectWorkspaceRefs(root, "mixed").frontendConfigKeys.map((k) => k.key),
    ["scope.comm", "scope.ga"],
  );
});

test("a package bundled in the RHDH image contributes no keys", () => {
  // Its artifact is a local ./dynamic-plugins/dist path, so nothing is installed for it
  // and its key has no bundle to match — the same false positive from the other end.
  const root = makeWorkspace(freshRepo(), "local", {
    "a.yaml": [
      "spec:",
      '  packageName: "@scope/bundled"',
      "  dynamicArtifact: ./dynamic-plugins/dist/scope-bundled",
      "  appConfigExamples:",
      "    - content:",
      "        dynamicPlugins:",
      "          frontend:",
      "            scope.bundled: {}",
      "",
    ].join("\n"),
    "b.yaml": `spec:\n  packageName: "@scope/real"\n  dynamicArtifact: ${OCI_REF}\n`,
  });
  assert.deepEqual(collectWorkspaceRefs(root, "local").frontendConfigKeys, []);
});
