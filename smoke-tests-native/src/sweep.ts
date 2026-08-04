/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Support-level sweep (RHIDP-13510): run the native smoke harness across every
 * workspace holding packages at a given `spec.support` level.
 *
 * The harness validates one workspace per invocation. This driver resolves which
 * workspaces are in scope (src/support.ts), splits them into balanced shards, and
 * runs one harness PROCESS per workspace. Separate processes rather than one big
 * install because a plugin that crashes the Node process, or a `startTestBackend`
 * boot that hangs, must cost one workspace's result and not the shard's.
 *
 * Usage:
 *   yarn sweep --support community --shards 6 --plan        # print the shard plan, run nothing
 *   yarn sweep --support community --shards 6 --shard 0     # run one shard
 *   yarn sweep --support community                          # run everything (1 shard)
 *
 * `--plan` exists so CI can compute the matrix in a cheap job and each sharded job
 * can recompute the same plan locally: `planShards` is deterministic, so shard N
 * holds the same workspaces in both.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { excluderFor, loadExclusions, type Exclusion } from "./exclusions";
import { requireContained, resolveContained } from "./paths";
import {
  SWEEP_SCHEMA_VERSION,
  type Report,
  type SweepSummary,
  type SweepWorkspaceResult,
} from "./report";
import {
  collectPackages,
  groupByWorkspace,
  isSupportLevel,
  planShards,
  selectBySupport,
  SUPPORT_LEVELS,
  type WorkspaceGroup,
} from "./support";
import type { PackageEntry } from "./workspace";

const HERE = dirname(fileURLToPath(import.meta.url));
// Both entry points are bundled into dist/, so the harness sits next to this file.
const HARNESS = join(HERE, "native-smoke.mjs");
const HARNESS_ROOT = dirname(HERE);
const REPO_ROOT = dirname(HARNESS_ROOT);

type ShardPlanEntry = {
  index: number;
  workspaces: string[];
  packageCount: number;
};

type SweepPlan = {
  support: string;
  shardCount: number;
  totals: {
    workspaces: number;
    packages: number;
    byRole: Record<string, number>;
  };
  /** Non-empty shards only — an empty one would be a CI job with nothing to do. */
  shards: ShardPlanEntry[];
};

type CliInputs = {
  support: string;
  shards: number;
  shard: number;
  exclusions: Exclusion[];
  /** Path as given, to forward to each harness process. */
  exclusionsFile?: string;
  outDir: string;
  plan: boolean;
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseCount(
  raw: string | undefined,
  flag: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${flag} must be a non-negative integer, got '${raw}'`);
  }
  return value;
}

function parseCliInputs(): CliInputs {
  const { values } = parseArgs({
    options: {
      support: { type: "string" },
      shards: { type: "string" },
      shard: { type: "string" },
      exclusions: { type: "string" },
      "out-dir": { type: "string" },
      plan: { type: "boolean" },
    },
  });

  const support = values.support;
  if (!support) {
    fail(`--support <level> is required (one of ${SUPPORT_LEVELS.join(", ")})`);
  }
  if (!isSupportLevel(support)) {
    // A typo would otherwise select nothing and report a clean, meaningless pass.
    fail(
      `unknown support level '${support}' — expected one of ${SUPPORT_LEVELS.join(", ")}`,
    );
  }

  const shards = parseCount(values.shards, "--shards", 1);
  if (shards < 1) fail("--shards must be at least 1");
  const shard = parseCount(values.shard, "--shard", 0);
  if (shard >= shards) {
    fail(`--shard ${shard} is out of range for --shards ${shards}`);
  }

  let exclusions: Exclusion[] = [];
  let exclusionsFile: string | undefined;
  if (values.exclusions) {
    try {
      exclusionsFile = requireContained("--exclusions", values.exclusions);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    if (!existsSync(exclusionsFile)) {
      fail(`--exclusions file not found: ${values.exclusions}`);
    }
    try {
      exclusions = loadExclusions(exclusionsFile);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // Results are written by the harness, which constrains its own --out to its CWD;
  // keep --out-dir under the same roof so the two agree.
  const outDirArg = values["out-dir"] ?? join("results", support);
  const outDir = resolveContained(outDirArg);
  if (!outDir) {
    fail(`--out-dir must resolve inside the working directory: ${outDirArg}`);
  }

  return {
    support,
    shards,
    shard,
    exclusions,
    exclusionsFile,
    outDir,
    plan: values.plan ?? false,
  };
}

/** Resolve the in-scope workspaces, grouped and shard-balanced. */
function resolvePlan(
  support: string,
  shardCount: number,
): {
  groups: WorkspaceGroup[];
  shards: WorkspaceGroup[][];
  packages: PackageEntry[];
} {
  const packages = selectBySupport(collectPackages(REPO_ROOT), support);
  const groups = groupByWorkspace(packages);
  return { groups, shards: planShards(groups, shardCount), packages };
}

function buildPlan(support: string, shardCount: number): SweepPlan {
  const { groups, shards, packages } = resolvePlan(support, shardCount);
  const byRole: Record<string, number> = {};
  for (const pkg of packages) {
    byRole[pkg.role || "(unset)"] = (byRole[pkg.role || "(unset)"] ?? 0) + 1;
  }
  return {
    support,
    shardCount,
    totals: {
      workspaces: groups.length,
      packages: packages.length,
      byRole,
    },
    shards: shards
      .map((shard, index) => ({
        index,
        workspaces: shard.map((group) => group.workspace),
        packageCount: shard.reduce(
          (sum, group) => sum + group.packages.length,
          0,
        ),
      }))
      .filter((entry) => entry.workspaces.length > 0),
  };
}

/** Run one workspace through the harness, in its own process. */
function runWorkspace(
  group: WorkspaceGroup,
  inputs: CliInputs,
): SweepWorkspaceResult {
  const installExcluded = excluderFor(inputs.exclusions, "install");
  const excluded = group.packages
    .map((pkg) => installExcluded(pkg.packageName))
    .filter((record) => record !== undefined);

  // Every in-scope package is barred from installing, so there is nothing to pull.
  // Invoking the harness here would fail with "nothing to validate" and turn a fully
  // tracked, ticketed exclusion into a red sweep.
  if (excluded.length === group.packages.length) {
    console.log(
      `▶ ${group.workspace}: skipped — all ${group.packages.length} package(s) ` +
        `install-excluded (${[...new Set(excluded.map((e) => e.ticket))].join(", ")})`,
    );
    return {
      workspace: group.workspace,
      packageCount: group.packages.length,
      status: "skipped",
      exitCode: 0,
      durationMs: 0,
      report: null,
      exclusions: excluded,
    };
  }

  const outFile = join(inputs.outDir, `${group.workspace}.json`);
  const args = [
    HARNESS,
    "--workspace",
    group.workspace,
    "--support",
    inputs.support,
    "--out",
    // The harness resolves --out against its own CWD, which is this process's CWD.
    relative(process.cwd(), outFile),
  ];
  if (inputs.exclusionsFile) args.push("--exclusions", inputs.exclusionsFile);

  console.log(
    `\n▶ ${group.workspace} (${group.packages.length} package(s) at '${inputs.support}')`,
  );
  // Remove any report left by a previous run FIRST: if this run's harness dies before
  // writing one (signal, OOM), a leftover file would be read back below as this run's
  // verdict — a stale pass is the one outcome a sweep must never report.
  rmSync(outFile, { force: true });
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  const durationMs = Date.now() - startedAt;

  let report: Report | null = null;
  if (existsSync(outFile)) {
    try {
      report = JSON.parse(readFileSync(outFile, "utf8")) as Report;
    } catch (err) {
      console.error(
        `⚠ ${group.workspace}: results file is unreadable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return {
    workspace: group.workspace,
    packageCount: group.packages.length,
    // A harness that died without writing a report (signal, OOM) leaves no status —
    // call it `error` rather than inheriting a stale or absent verdict.
    status: report?.status ?? "error",
    exitCode: result.status ?? 1,
    durationMs,
    report,
    exclusions: [...excluded, ...(report?.exclusions ?? [])],
  };
}

function statusGlyph(status: SweepWorkspaceResult["status"]): string {
  if (status === "pass") return "✓";
  return status === "skipped" ? "–" : "✗";
}

function main(): number {
  const inputs = parseCliInputs();

  if (inputs.plan) {
    console.log(
      JSON.stringify(buildPlan(inputs.support, inputs.shards), null, 2),
    );
    return 0;
  }

  const { shards } = resolvePlan(inputs.support, inputs.shards);
  const groups = shards[inputs.shard];

  mkdirSync(inputs.outDir, { recursive: true });
  console.log(
    `▶ sweep '${inputs.support}' shard ${inputs.shard + 1}/${inputs.shards}: ` +
      `${groups.length} workspace(s) — ${groups.map((g) => g.workspace).join(", ") || "(none)"}`,
  );

  const results = groups.map((group) => runWorkspace(group, inputs));
  const summary: SweepSummary = {
    schemaVersion: SWEEP_SCHEMA_VERSION,
    support: inputs.support,
    shard: { index: inputs.shard, total: inputs.shards },
    workspaces: results,
    status: results.every((r) => r.status === "pass" || r.status === "skipped")
      ? "pass"
      : "fail",
  };

  const summaryPath = join(inputs.outDir, `sweep-shard-${inputs.shard}.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  const failed = results.filter(
    (r) => r.status !== "pass" && r.status !== "skipped",
  );
  console.log(`\n▶ shard summary → ${summaryPath} (status: ${summary.status})`);
  for (const result of results) {
    console.log(
      `  ${statusGlyph(result.status)} ` +
        `${result.workspace}: ${result.status} (${Math.round(result.durationMs / 1000)}s)`,
    );
  }
  return failed.length > 0 ? 1 : 0;
}

process.exit(main());
