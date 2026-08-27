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
  buildAggregate,
  describeShardCoverage,
  failureDetail,
  findSummaries,
  oneLine,
  packagingOf,
  nfsSupportOf,
  renderMarkdown,
} from "./aggregate-report";
import { REPORT_SCHEMA_VERSION, SWEEP_SCHEMA_VERSION } from "./report";
import type { Report, SweepSummary, SweepWorkspaceResult } from "./report";
import type { FrontendSystem, MfRemoteInfo } from "./loader";

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

/**
 * An mf record the new frontend system can mount from.
 *
 * Deliberately not cast: the fixture has to stop compiling when MfRemoteInfo grows a
 * field, which is the drift this file already fixes three other fixtures for.
 */
function usableMf(over: Partial<MfRemoteInfo> = {}): MfRemoteInfo {
  return {
    name: "plugin",
    remoteEntry: "remoteEntry.js",
    exposes: ["./alpha"],
    nfsFeatures: ["./alpha"],
    nfsFeaturesError: null,
    nfsFeaturesExposed: ["./alpha"],
    servable: true,
    ...over,
  };
}

test("packagingOf classifies every system combination", () => {
  assert.equal(packagingOf({ systems: ["legacy"], mf: null }), "legacy-only");
  assert.equal(
    packagingOf({ systems: ["new-frontend-system"], mf: usableMf() }),
    "new-frontend-system-only",
  );
  assert.equal(
    packagingOf({
      systems: ["legacy", "new-frontend-system"],
      mf: usableMf(),
    }),
    "dual",
  );
  assert.equal(packagingOf({ systems: [], mf: null }), "none");
});

test("declaring no backstage.features is undetermined, not legacy", () => {
  // The state 27 of 47 bundles are actually in. nfsModuleFilter installs no filter,
  // every exposed module is advertised, and the loader decides at runtime from each
  // module's $$type — so calling it legacy states a guess as a fact. Ten of those 27
  // expose an `alpha` module, the same shape as bundles that are unambiguously NFS.
  const declaresNothing = {
    systems: ["legacy", "new-frontend-system"] as FrontendSystem[],
    mf: usableMf({ nfsFeatures: [], nfsFeaturesExposed: [] }),
  };
  assert.equal(nfsSupportOf(declaresNothing), "undetermined");
  assert.equal(packagingOf(declaresNothing), "dual");
});

test("a failure to read backstage.features is undetermined, not a finding", () => {
  // REPORT_SCHEMA_VERSION was bumped to 5 precisely so this is not recorded as the
  // artifact declaring none. Reading only nfsFeaturesExposed.length would lose that.
  const couldNotLook = {
    systems: ["legacy", "new-frontend-system"] as FrontendSystem[],
    mf: usableMf({
      nfsFeatures: [],
      nfsFeaturesExposed: [],
      nfsFeaturesError: "could not read package.json (EACCES)",
    }),
  };
  assert.equal(nfsSupportOf(couldNotLook), "undetermined");
  assert.equal(packagingOf(couldNotLook), "dual");
});

test("a declared NFS entry point the remote never exposes is a real no", () => {
  // Here the filter IS installed and keeps nothing, so the host mounts nothing. That
  // is knowable, unlike the declares-nothing case above.
  const declaredButUnexposed = {
    systems: ["new-frontend-system"] as FrontendSystem[],
    mf: usableMf({ nfsFeatures: ["./alpha"], nfsFeaturesExposed: [] }),
  };
  assert.equal(nfsSupportOf(declaredButUnexposed), "none");
  assert.equal(packagingOf(declaredButUnexposed), "none");
});

test("an unservable remote mounts nothing however much it declares", () => {
  const unservable = {
    systems: ["legacy", "new-frontend-system"] as FrontendSystem[],
    mf: usableMf({ servable: false }),
  };
  assert.equal(nfsSupportOf(unservable), "none");
  assert.equal(packagingOf(unservable), "legacy-only");
});

test("renderMarkdown qualifies the new-frontend-system figure it prints", () => {
  const markdown = renderMarkdown(
    buildAggregate([
      summary([
        result({
          workspace: "ws",
          report: report({
            frontend: {
              total: 2,
              valid: 2,
              errors: [],
              bundles: [
                {
                  name: "@s/ships-mf-only",
                  version: "1",
                  systems: ["legacy", "new-frontend-system"],
                  mf: usableMf({ nfsFeatures: [], nfsFeaturesExposed: [] }),
                },
                {
                  name: "@s/really-nfs",
                  version: "1",
                  systems: ["legacy", "new-frontend-system"],
                  mf: usableMf(),
                },
              ],
            },
          }),
        }),
      ]),
    ]),
  );
  // Both bundles still count as dual, which is the point: the figure is unchanged and
  // qualified, rather than quietly replaced by a smaller one that is wrong the other way.
  assert.match(markdown, /\| Dual \| 2 \|/);
  assert.match(markdown, /\*\*1\*\* are confirmed/);
  assert.match(markdown, /\*\*1\*\* are undetermined/);
  assert.match(markdown, /Read the migration figure as the confirmed count/);
});

test("a bundle with no module-federation layout is not undetermined", () => {
  // Absent layout is a plain legacy bundle. Calling it undetermined would pad the very
  // figure the split exists to qualify.
  const legacyOnly = { systems: ["legacy"] as FrontendSystem[], mf: null };
  assert.equal(nfsSupportOf(legacyOnly), "none");
  assert.equal(packagingOf(legacyOnly), "legacy-only");
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
    backendExcludedFromBoot: 2,
    backendBootFailed: 0,
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
  // The three must land in a row of their own, not vanish between two rows.
  assert.equal(aggregate.packages.backendBootFailed, 3);
  assert.equal(aggregate.packages.backendExcludedFromBoot, 0);
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
              { name: "@s/z", version: "1", systems: ["legacy"], mf: null },
              {
                name: "@s/a",
                version: "1",
                systems: ["legacy", "new-frontend-system"],
                mf: usableMf(),
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
  const root = tempDir(join(tmpdir(), "agg-find-"));
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

test("describeShardCoverage accepts complete coverage", () => {
  assert.equal(describeShardCoverage(new Set([0, 1, 2]), "3"), null);
});

test("describeShardCoverage reports a missing shard", () => {
  const problem = describeShardCoverage(new Set([0, 2]), "3");
  assert.match(problem ?? "", /missing shard\(s\): 1/);
  assert.match(problem ?? "", /only part of the sweep/);
});

test("describeShardCoverage catches a contaminated set of the right size", () => {
  // {0, 2} has the same SIZE as an expected 2, so a size comparison passed it while
  // shard 1 was missing AND a shard 2 from another run was mixed in.
  const problem = describeShardCoverage(new Set([0, 2]), "2");
  assert.match(problem ?? "", /missing shard\(s\): 1/);
  assert.match(problem ?? "", /unexpected shard\(s\): 2/);
});

test("describeShardCoverage rejects a nonsensical --expect-shards", () => {
  for (const bad of ["0", "-1", "abc", "1.5", ""]) {
    assert.match(
      describeShardCoverage(new Set([0]), bad) ?? "",
      /must be a positive integer/,
      `--expect-shards '${bad}' must be rejected`,
    );
  }
});

test("renderMarkdown puts each computed number in its own row", () => {
  // Every number here is DISTINCT from every other, so swapping any two rows fails.
  // An earlier version of this test used 3/3 and 1/1 and could not detect a swap.
  const markdown = renderMarkdown(
    buildAggregate([
      summary([
        result({
          workspace: "a",
          report: report({
            backend: { total: 7, loaded: 5, skipped: ["x", "y"], errors: [] },
            frontend: {
              total: 4,
              valid: 3,
              errors: [],
              bundles: [
                { name: "@s/l1", version: "1", systems: ["legacy"], mf: null },
                { name: "@s/l2", version: "1", systems: ["legacy"], mf: null },
                {
                  name: "@s/n",
                  version: "1",
                  systems: ["new-frontend-system"],
                  mf: usableMf(),
                },
                {
                  name: "@s/d",
                  version: "1",
                  systems: ["legacy", "new-frontend-system"],
                  mf: usableMf(),
                },
              ],
            },
          }),
          exclusions: [
            {
              packageName: "@s/x",
              scope: "install",
              ticket: "RHIDP-1",
              patternSource: "^@s/x$",
            },
          ],
        }),
        // Boot failed here, so its 4 loaded plugins are loaded-but-not-booted.
        result({
          workspace: "b",
          status: "fail-start",
          report: report({
            backend: { total: 6, loaded: 4, skipped: [], errors: [] },
            backendStart: { ok: false, error: "boom" },
            status: "fail-start",
          }),
        }),
        result({ workspace: "c", status: "skipped", report: null }),
      ]),
    ]),
  );
  assert.match(markdown, /^## Plugin sweep — `community`$/m);
  assert.match(
    markdown,
    /^1\/3 workspaces passed, 1 fully excluded across 1 shard\(s\)\.$/m,
  );
  assert.match(markdown, /^\| Artifacts installed \| 17 \|$/m);
  assert.match(markdown, /^\| Backend loaded \| 9\/13 \|$/m);
  assert.match(markdown, /^\| Backend booted \| 5\/13 \|$/m);
  assert.match(markdown, /^\| Backend excluded from boot \| 2 \|$/m);
  assert.match(markdown, /^\| Backend loaded but boot failed \| 4 \|$/m);
  assert.match(markdown, /^\| Frontend bundle layout valid \| 3\/4 \|$/m);
  assert.match(markdown, /^\| Legacy \(Scalprum\) only \| 2 \|$/m);
  assert.match(markdown, /^\| New frontend system only \| 1 \|$/m);
  assert.match(markdown, /^\| Dual \| 1 \|$/m);
  assert.match(markdown, /^\| No recognized layout \| 0 \|$/m);
  assert.match(markdown, /^\| `@s\/x` \| install \| RHIDP-1 \|$/m);
});

test("every markdown table row has the header's cell count", () => {
  // The previous assertion only checked that a row ends in "|", which a template
  // literal does unconditionally — a cell() that appends a stray pipe survived it.
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
  const rows = markdown.split("\n").filter((l) => l.startsWith("|"));
  const failuresHeader = rows.find((r) => r.startsWith("| Workspace |"));
  assert.ok(failuresHeader, "failures table missing");
  // Split on UNESCAPED pipes only: an escaped `\|` is cell content, and counting it
  // as a separator would defeat the point of checking that escaping happened.
  const cells = (row: string): number => row.split(/(?<!\\)\|/).length;
  const width = cells(failuresHeader);
  for (const row of rows.slice(rows.indexOf(failuresHeader))) {
    assert.equal(cells(row), width, `cell count differs from header: ${row}`);
  }
});

test("buildAggregate collects every workspace's exclusions", () => {
  const rec = (n: string) => ({
    packageName: n,
    scope: "install" as const,
    ticket: "RHIDP-1",
    patternSource: `^${n}$`,
  });
  const aggregate = buildAggregate([
    summary([
      result({ workspace: "a", exclusions: [rec("@s/y")] }),
      result({ workspace: "b", exclusions: [rec("@s/x")] }),
      { workspace: "hollow", status: "pass" } as SweepWorkspaceResult,
    ]),
  ]);
  assert.deepEqual(
    aggregate.exclusions.map((e) => e.packageName),
    ["@s/x", "@s/y"],
  );
  assert.equal(aggregate.workspaces.total, 3);
});

test("failureDetail falls through to the bundle error, then to the bare status", () => {
  const fe = {
    plugin: {
      name: "@s/fe",
      version: "1",
      dirName: "d",
      path: "/p",
      role: "frontend" as const,
    },
    error: "missing plugin-manifest.json",
  };
  assert.equal(
    failureDetail(
      result({
        report: report({
          frontend: { total: 1, valid: 0, errors: [fe], bundles: [] },
          status: "fail-bundle",
        }),
      }),
    ),
    "@s/fe: missing plugin-manifest.json",
  );
  // Nothing more specific to say: the status itself, not a placeholder.
  assert.equal(
    failureDetail(result({ report: report({ status: "error" }) })),
    "error",
  );
});

test("a shard that ran no workspaces fails the aggregate", () => {
  // summarize() marks it fail; without reading that, the aggregate printed
  // "0/0 workspaces passed" and exited 0 over a job that validated nothing.
  const empty: SweepSummary = { ...summary([]), status: "fail" };
  const aggregate = buildAggregate([empty]);
  assert.equal(aggregate.workspaces.failed, 1);
  assert.match(aggregate.failures[0].detail, /ran no workspaces/);
});

test("findSummaries walks subdirectories in sorted order", () => {
  // Injected listing: the on-disk fixture above cannot prove the sort, because readdir
  // already returns sorted entries on this filesystem.
  const tree: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
    "/root": [
      { name: "shard-1", isDirectory: true },
      { name: "shard-0", isDirectory: true },
    ],
    "/root/shard-0": [
      { name: "acs.json", isDirectory: false },
      { name: "sweep-shard-0.json", isDirectory: false },
    ],
    "/root/shard-1": [{ name: "sweep-shard-1.json", isDirectory: false }],
  };
  assert.deepEqual(
    findSummaries("/root", (dir) => tree[dir] ?? []),
    ["/root/shard-0/sweep-shard-0.json", "/root/shard-1/sweep-shard-1.json"],
  );
});
