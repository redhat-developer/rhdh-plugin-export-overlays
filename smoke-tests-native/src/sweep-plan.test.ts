/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SWEEP_SCHEMA_VERSION, type SweepWorkspaceResult } from "./report";
import {
  buildPlan,
  countByRole,
  isAcceptable,
  statusGlyph,
  summarize,
} from "./sweep-plan";

const repoRoot = mkdtempSync(join(tmpdir(), "sweep-plan-test-"));

function metadata(name: string, support: string, role: string): string {
  return [
    "spec:",
    `  packageName: "@scope/${name}"`,
    `  dynamicArtifact: oci://ghcr.io/example/${name}:tag`,
    `  support: ${support}`,
    "  backstage:",
    `    role: ${role}`,
    "",
  ].join("\n");
}

function makeWorkspace(
  name: string,
  packages: Array<[string, string, string]>,
): void {
  const dir = join(repoRoot, "workspaces", name, "metadata");
  mkdirSync(dir, { recursive: true });
  for (const [file, support, role] of packages) {
    writeFileSync(join(dir, `${file}.yaml`), metadata(file, support, role));
  }
}

makeWorkspace("beta", [
  ["beta-a", "community", "backend-plugin"],
  ["beta-b", "community", "frontend-plugin"],
]);
makeWorkspace("alpha", [["alpha-a", "community", "backend-plugin"]]);
makeWorkspace("ga", [["ga-a", "generally-available", "frontend-plugin"]]);

function res(overrides: Partial<SweepWorkspaceResult>): SweepWorkspaceResult {
  return {
    workspace: "ws",
    packageCount: 1,
    status: "pass",
    exitCode: 0,
    durationMs: 0,
    report: null,
    exclusions: [],
    ...overrides,
  };
}

test("summarize refuses to call a shard with no workspaces a pass", () => {
  // [].every() is true, so the obvious formulation reports a clean verdict for a job
  // that validated nothing — the silent green this sweep exists to prevent.
  const empty = summarize([], "community", 0, 1, SWEEP_SCHEMA_VERSION);
  assert.equal(empty.status, "fail");
  assert.deepEqual(empty.workspaces, []);
});

test("summarize passes only when every workspace passed or was skipped", () => {
  const ok = summarize(
    [res({ status: "pass" }), res({ status: "skipped" })],
    "community",
    2,
    6,
    SWEEP_SCHEMA_VERSION,
  );
  assert.equal(ok.status, "pass");
  assert.deepEqual(ok.shard, { index: 2, total: 6 });
  assert.equal(ok.support, "community");

  for (const bad of [
    "fail-load",
    "fail-start",
    "fail-bundle",
    "error",
  ] as const) {
    assert.equal(
      summarize(
        [res({ status: "pass" }), res({ status: bad })],
        "community",
        0,
        1,
        SWEEP_SCHEMA_VERSION,
      ).status,
      "fail",
      `status '${bad}' must fail the shard`,
    );
  }
});

test("isAcceptable and statusGlyph agree on which statuses are not failures", () => {
  assert.equal(isAcceptable(res({ status: "pass" })), true);
  assert.equal(isAcceptable(res({ status: "skipped" })), true);
  assert.equal(isAcceptable(res({ status: "error" })), false);
  assert.equal(statusGlyph("pass"), "✓");
  assert.equal(statusGlyph("skipped"), "–");
  assert.equal(statusGlyph("fail-load"), "✗");
});

test("countByRole labels a package with no role rather than dropping it", () => {
  assert.deepEqual(
    countByRole([
      { role: "backend-plugin" },
      { role: "backend-plugin" },
      { role: "" },
    ] as Parameters<typeof countByRole>[0]),
    { "backend-plugin": 2, "(unset)": 1 },
  );
});

test("buildPlan selects by support level and reports totals by role", () => {
  const plan = buildPlan(repoRoot, "community", 2);
  assert.equal(plan.support, "community");
  assert.equal(plan.totals.workspaces, 2);
  assert.equal(plan.totals.packages, 3);
  assert.deepEqual(plan.totals.byRole, {
    "backend-plugin": 2,
    "frontend-plugin": 1,
  });
});

test("buildPlan drops empty shards but keeps each shard's own index", () => {
  // The CI matrix is built from these indices while each sweep job indexes into the
  // unfiltered plan, so the two must refer to the same bucket.
  const plan = buildPlan(repoRoot, "community", 5);
  assert.deepEqual(
    plan.shards.map((s) => s.index),
    [0, 1],
  );
  assert.deepEqual(
    plan.shards.map((s) => s.workspaces),
    [["beta"], ["alpha"]],
  );
  assert.deepEqual(
    plan.shards.map((s) => s.packageCount),
    [2, 1],
  );
});

test("the non-empty shard indices are a contiguous prefix", () => {
  // --expect-shards reconstructs the launched shards as 0..N-1, which is only correct
  // because LPT fills from index 0 and never leaves a gap.
  for (const shardCount of [1, 2, 3, 7]) {
    const indices = buildPlan(repoRoot, "community", shardCount).shards.map(
      (s) => s.index,
    );
    assert.deepEqual(
      indices,
      indices.map((_, i) => i),
      `shard indices not contiguous at shardCount=${shardCount}`,
    );
  }
});
