/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

// Fake repo root: workspaces/<name>/{metadata,smoke-tests}
const repoRoot = mkdtempSync(join(tmpdir(), "workspace-test-"));

function makeWorkspace(
  name: string,
  metadata: Record<string, string>,
  smokeTests?: Record<string, string>,
): void {
  const metadataDir = join(repoRoot, "workspaces", name, "metadata");
  mkdirSync(metadataDir, { recursive: true });
  for (const [file, content] of Object.entries(metadata)) {
    writeFileSync(join(metadataDir, file), content);
  }
  if (smokeTests) {
    const smokeDir = join(repoRoot, "workspaces", name, "smoke-tests");
    mkdirSync(smokeDir, { recursive: true });
    for (const [file, content] of Object.entries(smokeTests)) {
      writeFileSync(join(smokeDir, file), content);
    }
  }
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
  makeWorkspace("mixed", {
    "plugin-a.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n`,
    "plugin-b.yaml":
      "spec:\n  dynamicArtifact: ./dynamic-plugins/dist/plugin-b-dynamic\n",
  });
  const { refs, skipped } = collectWorkspaceRefs(repoRoot, "mixed");
  assert.deepEqual(refs, [OCI_REF]);
  assert.deepEqual(skipped, ["plugin-b.yaml"]);
});

test("collectWorkspaceRefs throws when no oci refs remain", () => {
  makeWorkspace("local-only", {
    "plugin.yaml":
      "spec:\n  dynamicArtifact: ./dynamic-plugins/dist/plugin-dynamic\n",
  });
  assert.throws(
    () => collectWorkspaceRefs(repoRoot, "local-only"),
    /nothing to validate/,
  );
});

test("collectWorkspaceRefs throws on unknown workspace and invalid names", () => {
  assert.throws(
    () => collectWorkspaceRefs(repoRoot, "does-not-exist"),
    /metadata not found/,
  );
  assert.throws(
    () => collectWorkspaceRefs(repoRoot, ".."),
    /invalid workspace name/,
  );
});

test("discoverSmokeTestConfig finds only the files that exist", () => {
  makeWorkspace(
    "with-env",
    { "plugin.yaml": `spec:\n  dynamicArtifact: ${OCI_REF}\n` },
    { "test.env": "SOME_URL=https://example.com\n" },
  );
  const withEnv = discoverSmokeTestConfig(repoRoot, "with-env");
  assert.equal(withEnv.appConfig, undefined);
  assert.match(withEnv.testEnv ?? "", /with-env\/smoke-tests\/test\.env$/);

  const none = discoverSmokeTestConfig(repoRoot, "mixed");
  assert.deepEqual(none, { appConfig: undefined, testEnv: undefined });
});

test("readWorkspacePackages flattens the fields the sweep filters on", () => {
  makeWorkspace("tiers", {
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
  assert.deepEqual(readWorkspacePackages(repoRoot, "tiers"), [
    {
      workspace: "tiers",
      file: "community.yaml",
      packageName: "@scope/plugin-community",
      support: "community",
      role: "backend-plugin",
      artifact: OCI_REF,
    },
  ]);
});

test("collectWorkspaceRefs narrows to one support level", () => {
  makeWorkspace("two-tiers", {
    "a-community.yaml": `spec:\n  packageName: "@scope/a"\n  support: community\n  dynamicArtifact: ${OCI_REF}\n`,
    "b-ga.yaml": `spec:\n  packageName: "@scope/b"\n  support: generally-available\n  dynamicArtifact: ${OCI_REF}-ga\n`,
  });
  const all = collectWorkspaceRefs(repoRoot, "two-tiers");
  assert.equal(all.refs.length, 2);
  assert.equal(all.outOfScope, 0);

  const community = collectWorkspaceRefs(repoRoot, "two-tiers", {
    support: "community",
  });
  assert.deepEqual(community.refs, [OCI_REF]);
  assert.equal(community.outOfScope, 1);
});

test("collectWorkspaceRefs drops install-excluded packages and records the ticket", () => {
  makeWorkspace("excluded", {
    "a.yaml": `spec:\n  packageName: "@scope/keep"\n  dynamicArtifact: ${OCI_REF}\n`,
    "b.yaml": `spec:\n  packageName: "@scope/drop"\n  dynamicArtifact: ${OCI_REF}-drop\n`,
  });
  const exclusions = parseExclusions(
    "# TODO(RHIDP-1): unpublished.\ninstall ^@scope/drop$\n",
    "test",
  );
  const { refs, excluded } = collectWorkspaceRefs(repoRoot, "excluded", {
    installExcluded: excluderFor(exclusions, "install"),
  });
  assert.deepEqual(refs, [OCI_REF]);
  assert.deepEqual(excluded, [
    {
      packageName: "@scope/drop",
      scope: "install",
      ticket: "RHIDP-1",
      pattern: "^@scope/drop$",
    },
  ]);
});

test("collectWorkspaceRefs says which filter emptied the set", () => {
  // A support filter that matches nothing must not read like a workspace with no
  // published artifacts — the two have different fixes.
  assert.throws(
    () =>
      collectWorkspaceRefs(repoRoot, "two-tiers", { support: "dev-preview" }),
    /2 at another support level.*nothing to validate/,
  );
});

test("writeDynamicPluginsConfig produces the yaml the install CLI consumes", async () => {
  const dest = mkdtempSync(join(tmpdir(), "dp-out-"));
  const path = await writeDynamicPluginsConfig([OCI_REF], dest);
  const doc = parse(readFileSync(path, "utf8")) as {
    plugins: Array<{ package: string }>;
  };
  assert.deepEqual(doc.plugins, [{ package: OCI_REF }]);
});
