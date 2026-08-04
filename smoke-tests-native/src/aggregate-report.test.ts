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
import {
  buildAggregate,
  failureDetail,
  findSummaries,
  oneLine,
  packagingOf,
  renderMarkdown,
} from "./aggregate-report";
import { REPORT_SCHEMA_VERSION, SWEEP_SCHEMA_VERSION } from "./report";
import type { Report, SweepSummary, SweepWorkspaceResult } from "./report";

function report(overrides: Partial<Report> = {}): Report {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    cliVersion: "0.3.0",
    backend: { total: 0, loaded: 0, skipped: [], errors: [] },
    backendStart: { ok: true },
    frontend: { total: 0, valid: 0, errors: [], bundles: [] },
    exclusions: [],
    status: "pass",
    ...overrides,
  };
}

function result(
  overrides: Partial<SweepWorkspaceResult> = {},
): SweepWorkspaceResult {
  return {
    workspace: "ws",
    packageCount: 1,
    status: "pass",
    exitCode: 0,
    durationMs: 1,
    report: report(),
    exclusions: [],
    ...overrides,
  };
}

function summary(workspaces: SweepWorkspaceResult[], index = 0): SweepSummary {
  return {
    schemaVersion: SWEEP_SCHEMA_VERSION,
    support: "community",
    shard: { index, total: 1 },
    workspaces,
    status: "pass",
  };
}

test("packagingOf classifies every system combination", () => {
  assert.equal(packagingOf(["legacy"]), "legacy-only");
  assert.equal(
    packagingOf(["new-frontend-system"]),
    "new-frontend-system-only",
  );
  assert.equal(packagingOf(["legacy", "new-frontend-system"]), "dual");
  assert.equal(packagingOf([]), "none");
});

test("oneLine flattens whitespace and truncates at the limit", () => {
  assert.equal(oneLine("a\n  b\tc"), "a b c");
  assert.equal(oneLine("  trimmed  "), "trimmed");
  // Boundary: exactly at the limit is untouched, one over is truncated to the limit.
  assert.equal(oneLine("x".repeat(10), 10), "x".repeat(10));
  assert.equal(oneLine("x".repeat(11), 10), `${"x".repeat(9)}…`);
});

test("oneLine leaves pipe escaping to the markdown layer", () => {
  // Escaping here leaked backslashes into aggregate.json, which no one renders as
  // markdown. renderMarkdown escapes at the row it builds instead.
  assert.equal(oneLine("a|b"), "a|b");
});

test("failureDetail prefers the most specific error the report holds", () => {
  assert.equal(
    failureDetail(result({ report: null, exitCode: 137 })),
    "harness exited 137 with no report",
  );
  // A load error outranks a start error: the start failed *because* of the load.
  assert.equal(
    failureDetail(
      result({
        report: report({
          backend: {
            total: 1,
            loaded: 0,
            skipped: [],
            errors: [
              {
                plugin: {
                  name: "@s/p",
                  version: "1",
                  dirName: "d",
                  path: "/p",
                  role: "backend",
                },
                error: "boom",
              },
            ],
          },
          backendStart: { ok: false, error: "ignored" },
          status: "fail-load",
        }),
      }),
    ),
    "@s/p: boom",
  );
  assert.equal(
    failureDetail(
      result({
        report: report({
          backendStart: { ok: false, error: "cfg invalid" },
          status: "fail-start",
        }),
      }),
    ),
    "backend start: cfg invalid",
  );
});

test("buildAggregate totals each counter from its own field", () => {
  // Deliberately distinct numbers, so a copy-paste swap between two += lines cannot
  // produce a passing result.
  const aggregate = buildAggregate([
    summary([
      result({
        report: report({
          backend: { total: 7, loaded: 3, skipped: ["x", "y"], errors: [] },
          frontend: { total: 5, valid: 2, errors: [], bundles: [] },
        }),
      }),
    ]),
  ]);
  assert.deepEqual(aggregate.packages, {
    installed: 12,
    backendTotal: 7,
    backendLoaded: 3,
    backendBooted: 3,
    backendNotBooted: 2,
    frontendTotal: 5,
    frontendValidBundle: 2,
  });
});

test("buildAggregate counts loaded-but-not-booted plugins as not booted", () => {
  // `backend.loaded` is computed before startTestBackend runs, so counting it as
  // "booted" reported a workspace whose boot threw as fully booted — overstating the
  // sweep's headline signal.
  const aggregate = buildAggregate([
    summary([
      result({
        status: "fail-start",
        report: report({
          backend: { total: 3, loaded: 3, skipped: [], errors: [] },
          backendStart: { ok: false, error: "boom" },
          status: "fail-start",
        }),
      }),
    ]),
  ]);
  assert.equal(aggregate.packages.backendLoaded, 3);
  assert.equal(aggregate.packages.backendBooted, 0);
});

test("buildAggregate partitions workspaces into passed, failed and skipped", () => {
  const aggregate = buildAggregate([
    summary([
      result({ workspace: "a" }),
      result({ workspace: "b", status: "fail-load" }),
      result({ workspace: "c", status: "skipped", report: null }),
    ]),
  ]);
  assert.deepEqual(aggregate.workspaces, {
    total: 3,
    passed: 1,
    failed: 1,
    skipped: 1,
  });
  assert.deepEqual(
    aggregate.failures.map((f) => f.workspace),
    ["b"],
  );
});

test("buildAggregate counts distinct shard indices, not summary files", () => {
  // Two files for one shard would otherwise report two shards while --expect-shards,
  // which counts indices, still saw one.
  const aggregate = buildAggregate([
    summary([result({ workspace: "a" })], 0),
    summary([result({ workspace: "b" })], 0),
  ]);
  assert.equal(aggregate.shards, 1);
});

test("buildAggregate survives a summary whose workspace entries are hollow", () => {
  // isSweepSummary only validates that `workspaces` is an array, so an element with no
  // `exclusions` reaches here. The job that exists to report on everything else must
  // not die on it.
  const hollow = summary([
    { workspace: "w", status: "pass" } as SweepWorkspaceResult,
  ]);
  assert.doesNotThrow(() => buildAggregate([hollow]));
});

test("buildAggregate sorts failures and frontend packages deterministically", () => {
  const aggregate = buildAggregate([
    summary([
      result({ workspace: "zebra", status: "fail-load" }),
      result({ workspace: "alpha", status: "fail-start" }),
      result({
        workspace: "mid",
        report: report({
          frontend: {
            total: 2,
            valid: 2,
            errors: [],
            bundles: [
              { name: "@s/z", version: "1", systems: ["legacy"] },
              {
                name: "@s/a",
                version: "1",
                systems: ["legacy", "new-frontend-system"],
              },
            ],
          },
        }),
      }),
    ]),
  ]);
  assert.deepEqual(
    aggregate.failures.map((f) => f.workspace),
    ["alpha", "zebra"],
  );
  assert.deepEqual(
    aggregate.frontendSystems.packages.map((p) => p.packageName),
    ["@s/a", "@s/z"],
  );
  assert.equal(aggregate.frontendSystems.counts.dual, 1);
  assert.equal(aggregate.frontendSystems.counts["legacy-only"], 1);
});

test("renderMarkdown escapes pipes so a failure cannot break the table", () => {
  const markdown = renderMarkdown(
    buildAggregate([
      summary([
        result({
          workspace: "ws",
          status: "fail-start",
          report: report({
            backendStart: { ok: false, error: "a | b" },
            status: "fail-start",
          }),
        }),
      ]),
    ]),
  );
  assert.match(markdown, /backend start: a \\\| b/);
  // Every rendered row must have the same cell count as its header.
  const rows = markdown
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
  for (const row of rows) {
    assert.ok(row.endsWith("|"), `row not closed: ${row}`);
  }
});

test("findSummaries recurses into per-shard subdirectories in sorted order", () => {
  const root = mkdtempSync(join(tmpdir(), "agg-find-"));
  for (const shard of ["shard-1", "shard-0"]) {
    mkdirSync(join(root, shard), { recursive: true });
    writeFileSync(
      join(root, shard, `sweep-shard-${shard.slice(-1)}.json`),
      "{}",
    );
    writeFileSync(join(root, shard, "acs.json"), "{}");
  }
  assert.deepEqual(
    findSummaries(root).map((p) => p.slice(root.length + 1)),
    ["shard-0/sweep-shard-0.json", "shard-1/sweep-shard-1.json"],
  );
});
