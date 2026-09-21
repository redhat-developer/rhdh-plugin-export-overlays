/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Support-level resolver (RHIDP-13510): select the packages a sweep validates by
 * their `spec.support` across every `workspaces/<name>/metadata/*.yaml`, and plan how
 * to spread them over sharded CI jobs.
 *
 * `spec.support` — NOT the npm scope — is the classifier. `@backstage-community/
 * plugin-topology` and `-tech-radar` are generally-available; `quay`, `tekton` and
 * `3scale` are community. Anything keying off the npm org resolves the wrong set.
 *
 * The workspace, not the package, is the unit of work: a workspace's plugins share
 * the `smoke-tests/app-config.test.yaml` and `test.env` the harness auto-discovers,
 * and it is the unit the container smoke already uses. So a shard is a set of
 * workspaces, each run as its own harness process against its own support filter.
 *
 * Every list this module returns is explicitly sorted. Comparing two workspace or
 * package lists is how coverage gets counted, and the usual tools for that (`comm`,
 * `join`, `diff`) produce wrong output on unsorted input WITHOUT reporting an error —
 * that miscount is what forced a retraction on RHIDP-13510. Sortedness here is a
 * correctness property, not tidiness.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compareStrings } from "./util";
import {
  isValidWorkspaceName,
  readWorkspacePackages,
  type PackageEntry,
} from "./workspace";

/** The `spec.support` levels in use across the repo's metadata. */
export const SUPPORT_LEVELS = [
  "community",
  "generally-available",
  "tech-preview",
  "dev-preview",
] as const;

export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export type WorkspaceGroup = {
  workspace: string;
  packages: PackageEntry[];
};

export function isSupportLevel(value: string): value is SupportLevel {
  return (SUPPORT_LEVELS as readonly string[]).includes(value);
}

/** Every `workspaces/<name>/` that has a `metadata/` directory, sorted by name. */
export function listWorkspaces(
  repoRoot: string,
  // Same seam as readWorkspacePackages: pin the ordering without depending on the
  // filesystem's own.
  listEntries: (dir: string) => string[] = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
): string[] {
  const root = join(repoRoot, "workspaces");
  if (!existsSync(root)) {
    throw new Error(`workspaces directory not found: ${root}`);
  }
  return listEntries(root)
    .filter(
      (name) =>
        isValidWorkspaceName(name) && existsSync(join(root, name, "metadata")),
    )
    .sort(compareStrings);
}

/** Flatten every Package entity in the repo, workspace by workspace. */
export function collectPackages(repoRoot: string): PackageEntry[] {
  return listWorkspaces(repoRoot).flatMap((workspace) =>
    readWorkspacePackages(repoRoot, workspace),
  );
}

export function selectBySupport(
  packages: PackageEntry[],
  support: string,
): PackageEntry[] {
  return packages.filter((pkg) => pkg.support === support);
}

/** Group packages by workspace, workspaces sorted by name, packages by metadata file. */
export function groupByWorkspace(packages: PackageEntry[]): WorkspaceGroup[] {
  const grouped = new Map<string, PackageEntry[]>();
  for (const pkg of packages) {
    const existing = grouped.get(pkg.workspace);
    if (existing) existing.push(pkg);
    else grouped.set(pkg.workspace, [pkg]);
  }
  return [...grouped.entries()]
    .map(([workspace, entries]) => ({
      workspace,
      packages: [...entries].sort((a, b) => compareStrings(a.file, b.file)),
    }))
    .sort((a, b) => compareStrings(a.workspace, b.workspace));
}

/**
 * Spread workspaces over `shardCount` shards, balancing on package count.
 *
 * Longest-processing-time-first: heaviest workspace placed first, onto the lightest
 * shard so far, ties broken by name. Package count is a rough proxy for runtime —
 * each package is an OCI pull — and it beats round-robin badly enough to matter here,
 * where workspaces range from 1 to ~8 packages.
 *
 * Always returns exactly `shardCount` arrays (some possibly empty) so a shard index
 * means the same thing in the planning job and in the job that runs it. Callers drop
 * the empty ones when building a CI matrix.
 */
export function planShards(
  groups: WorkspaceGroup[],
  shardCount: number,
): WorkspaceGroup[][] {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(
      `shard count must be a positive integer, got ${shardCount}`,
    );
  }
  type Shard = { load: number; groups: WorkspaceGroup[] };
  const shards: Shard[] = Array.from({ length: shardCount }, () => ({
    load: 0,
    groups: [],
  }));

  const heaviestFirst = [...groups].sort(
    (a, b) =>
      b.packages.length - a.packages.length ||
      compareStrings(a.workspace, b.workspace),
  );
  for (const group of heaviestFirst) {
    // First minimum wins, so equal loads always resolve to the lowest shard index.
    let target = shards[0];
    for (const shard of shards) {
      if (shard.load < target.load) target = shard;
    }
    target.groups.push(group);
    target.load += group.packages.length;
  }

  // Copy before sorting rather than sorting in place (Sonar S4043): the accumulator
  // objects are local, but returning a sorted copy keeps this a pure function of its
  // input, which is what the determinism guarantee above rests on.
  return shards.map((shard) =>
    [...shard.groups].sort((a, b) => compareStrings(a.workspace, b.workspace)),
  );
}
