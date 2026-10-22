/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Shard planning and verdict derivation for the sweep (RHIDP-13510).
 *
 * Split from the `sweep` CLI so it can be tested: the entry point ends in
 * `process.exit`, which makes anything beside it unreachable from a test. This is
 * where a mistake turns a sweep green over plugins it never validated, so it is the
 * part that most needs covering.
 */

import type {
  Report,
  Status,
  SweepSummary,
  SweepWorkspaceResult,
} from "./report";
import {
  collectPackages,
  groupByWorkspace,
  planShards,
  selectBySupport,
  type WorkspaceGroup,
} from "./support";
import type { PackageEntry } from "./workspace";

export type ShardPlanEntry = {
  index: number;
  workspaces: string[];
  packageCount: number;
};

export type SweepPlan = {
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

/** Resolve the in-scope workspaces, grouped and shard-balanced. */
export function resolvePlan(
  repoRoot: string,
  support: string,
  shardCount: number,
): {
  groups: WorkspaceGroup[];
  shards: WorkspaceGroup[][];
  packages: PackageEntry[];
} {
  const packages = selectBySupport(collectPackages(repoRoot), support);
  const groups = groupByWorkspace(packages);
  return { groups, shards: planShards(groups, shardCount), packages };
}

export function countByRole(packages: PackageEntry[]): Record<string, number> {
  const byRole: Record<string, number> = {};
  for (const pkg of packages) {
    const role = pkg.role || "(unset)";
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  return byRole;
}

export function buildPlan(
  repoRoot: string,
  support: string,
  shardCount: number,
): SweepPlan {
  const { groups, shards, packages } = resolvePlan(
    repoRoot,
    support,
    shardCount,
  );
  return {
    support,
    shardCount,
    totals: {
      workspaces: groups.length,
      packages: packages.length,
      byRole: countByRole(packages),
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

/** A workspace result that does not count against the sweep. */
export function isAcceptable(result: SweepWorkspaceResult): boolean {
  return result.status === "pass" || result.status === "skipped";
}

export function statusGlyph(status: SweepWorkspaceResult["status"]): string {
  if (status === "pass") return "✓";
  return status === "skipped" ? "–" : "✗";
}

/**
 * Derive the shard summary from its results.
 *
 * A shard with no workspaces is `fail`, not `pass`: `[].every()` is `true`, so the
 * obvious formulation reports a clean verdict for a job that validated nothing —
 * the exact silent-green outcome this sweep exists to prevent. The planner drops
 * empty shards from the CI matrix, so reaching this means the plan and the run
 * disagreed, which is worth failing on.
 */
export function summarize(
  results: SweepWorkspaceResult[],
  support: string,
  shardIndex: number,
  shardTotal: number,
  schemaVersion: number,
): SweepSummary {
  return {
    schemaVersion,
    support,
    shard: { index: shardIndex, total: shardTotal },
    workspaces: results,
    status: results.length > 0 && results.every(isAcceptable) ? "pass" : "fail",
  };
}

/**
 * The status a workspace run gets, from what the harness wrote and how it exited.
 *
 * A harness that wrote `pass` and THEN died — the stale-file removal only defends
 * against a PREVIOUS run's file — must not hand back a green verdict on a crashed
 * process. A report that already says it failed is reported as itself, whatever the
 * exit code, because its own diagnosis is more specific than "the process exited 1".
 */
export function deriveStatus(
  report: Report | null,
  exitCode: number,
): Status | "skipped" {
  if (!report) return "error";
  return exitCode === 0 || report.status !== "pass" ? report.status : "error";
}
