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
  collectPackages,
  groupByWorkspace,
  isSupportLevel,
  listWorkspaces,
  planShards,
  selectBySupport,
  type WorkspaceGroup,
} from "./support";
import type { PackageEntry } from "./workspace";

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

const repoRoot = tempDir(join(tmpdir(), "support-test-"));

function metadata(name: string, support: string, role: string): string {
  return [
    "spec:",
    `  packageName: "@scope/${name}"`,
    `  dynamicArtifact: oci://ghcr.io/example/${name}:tag!${name}`,
    `  support: ${support}`,
    "  backstage:",
    `    role: ${role}`,
    "",
  ].join("\n");
}

function makeWorkspace(
  name: string,
  packages: Array<[file: string, support: string, role: string]>,
): void {
  const dir = join(repoRoot, "workspaces", name, "metadata");
  mkdirSync(dir, { recursive: true });
  for (const [file, support, role] of packages) {
    writeFileSync(join(dir, `${file}.yaml`), metadata(file, support, role));
  }
}

// Deliberately created out of alphabetical order, so a test that passes only because
// the filesystem happened to hand them back sorted would fail.
makeWorkspace("zebra", [
  ["zebra-frontend", "community", "frontend-plugin"],
  ["zebra-backend", "community", "backend-plugin"],
]);
makeWorkspace("alpha", [["alpha-backend", "community", "backend-plugin"]]);
makeWorkspace("mixed", [
  ["mixed-ga", "generally-available", "frontend-plugin"],
  ["mixed-community", "community", "backend-plugin-module"],
]);
makeWorkspace("ga-only", [
  ["ga-only-plugin", "generally-available", "frontend-plugin"],
]);
// A stray non-workspace directory with no metadata/ must not appear as a workspace.
mkdirSync(join(repoRoot, "workspaces", "not-a-workspace"), { recursive: true });

test("isSupportLevel accepts the levels used in metadata", () => {
  assert.equal(isSupportLevel("community"), true);
  assert.equal(isSupportLevel("generally-available"), true);
  assert.equal(isSupportLevel("Community"), false);
  assert.equal(isSupportLevel(""), false);
});

test("listWorkspaces returns sorted names and skips dirs without metadata/", () => {
  assert.deepEqual(listWorkspaces(repoRoot), [
    "alpha",
    "ga-only",
    "mixed",
    "zebra",
  ]);
});

test("selectBySupport filters on spec.support, not on the npm scope", () => {
  // Every fixture package shares the @scope/ org; only spec.support separates them.
  // Asserted as (name, role) pairs in the order collectPackages returns them: sorting
  // the result first would discard the ordering guarantee, and comparing a bare
  // multiset of roles would still pass with every role shuffled among the packages.
  const community = selectBySupport(collectPackages(repoRoot), "community");
  assert.deepEqual(
    community.map((p) => [p.packageName, p.role]),
    [
      ["@scope/alpha-backend", "backend-plugin"],
      ["@scope/mixed-community", "backend-plugin-module"],
      ["@scope/zebra-backend", "backend-plugin"],
      ["@scope/zebra-frontend", "frontend-plugin"],
    ],
  );
});

test("groupByWorkspace sorts regardless of the order it is handed", () => {
  // The filesystem returns readdir entries already sorted on some platforms, so a
  // fixture built from disk cannot prove this. Hand-built, deliberately unsorted input
  // can — remove either sort in groupByWorkspace and this fails.
  const entry = (workspace: string, file: string): PackageEntry => ({
    workspace,
    file,
    packageName: `@scope/${workspace}-${file}`,
    support: "community",
    role: "backend-plugin",
    artifact: "oci://ghcr.io/example/x:tag",
  });
  const groups = groupByWorkspace([
    entry("zebra", "z-frontend.yaml"),
    entry("alpha", "a.yaml"),
    entry("zebra", "z-backend.yaml"),
    entry("mixed", "m.yaml"),
  ]);
  assert.deepEqual(
    groups.map((g) => g.workspace),
    ["alpha", "mixed", "zebra"],
  );
  assert.deepEqual(
    groups[2].packages.map((p) => p.file),
    ["z-backend.yaml", "z-frontend.yaml"],
  );
});

test("groupByWorkspace groups the repo's own metadata deterministically", () => {
  // Ordering is a correctness property here: coverage gets counted by comparing
  // these lists, and comm/join miscount unsorted input without erroring.
  const groups = groupByWorkspace(
    selectBySupport(collectPackages(repoRoot), "community"),
  );
  assert.deepEqual(
    groups.map((g) => g.workspace),
    ["alpha", "mixed", "zebra"],
  );
  assert.deepEqual(
    groups[2].packages.map((p) => p.file),
    ["zebra-backend.yaml", "zebra-frontend.yaml"],
  );
});

function group(workspace: string, count: number): WorkspaceGroup {
  const packages: PackageEntry[] = Array.from({ length: count }, (_, i) => ({
    workspace,
    file: `${i}.yaml`,
    packageName: `@scope/${workspace}-${i}`,
    support: "community",
    role: "backend-plugin",
    artifact: `oci://ghcr.io/example/${workspace}-${i}:tag`,
  }));
  return { workspace, packages };
}

test("planShards balances on package count and keeps every workspace exactly once", () => {
  const groups = [
    group("a", 8),
    group("b", 1),
    group("c", 5),
    group("d", 4),
    group("e", 2),
  ];
  const shards = planShards(groups, 3);
  assert.equal(shards.length, 3);
  const placed = shards
    .flat()
    .map((g) => g.workspace)
    .sort();
  assert.deepEqual(placed, ["a", "b", "c", "d", "e"]);

  // Pin the actual placement, not a tolerance band: a subtly worse heuristic would
  // still land inside a band, and planShards' whole contract is that it is deterministic.
  assert.deepEqual(
    shards.map((s) => s.map((g) => g.workspace)),
    [["a"], ["b", "c"], ["d", "e"]],
  );
  const loads = shards.map((s) =>
    s.reduce((sum, g) => sum + g.packages.length, 0),
  );
  // 8 / 6 / 6 — round-robin over the same input would give 10 / 6 / 4.
  assert.deepEqual(loads, [8, 6, 6]);
});

test("planShards handles the degenerate inputs the CLI can produce", () => {
  assert.deepEqual(planShards([], 3), [[], [], []]);
  assert.deepEqual(
    planShards([group("a", 2), group("b", 1)], 1).map((s) =>
      s.map((g) => g.workspace),
    ),
    [["a", "b"]],
  );
});

test("planShards is deterministic and returns exactly shardCount shards", () => {
  // The planning job and each sharded job compute the plan independently; if they
  // disagreed, workspaces would silently go unvalidated.
  const groups = [group("a", 3), group("b", 3), group("c", 1)];
  const first = planShards(groups, 5);
  const second = planShards([...groups].reverse(), 5);
  assert.equal(first.length, 5);
  assert.deepEqual(
    first.map((s) => s.map((g) => g.workspace)),
    second.map((s) => s.map((g) => g.workspace)),
  );
  assert.deepEqual(first[3], []);
});

test("planShards rejects a nonsensical shard count", () => {
  assert.throws(() => planShards([], 0), /positive integer/);
  assert.throws(() => planShards([], 1.5), /positive integer/);
});

test("listWorkspaces sorts whatever order the filesystem returns", () => {
  // readdir returns sorted entries on APFS and hash order on ext4, so a fixture built
  // on disk cannot prove this sort happens — it would pass locally and flake in CI.
  assert.deepEqual(
    listWorkspaces(repoRoot, () => ["zebra", "alpha", "mixed", "ga-only"]),
    ["alpha", "ga-only", "mixed", "zebra"],
  );
});
