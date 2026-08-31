/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Building and rendering the sweep aggregate (RHIDP-13510).
 *
 * Split from the `aggregate` CLI so every function here is importable and testable:
 * the entry point ends in `process.exit`, which makes anything living beside it
 * unreachable from a test. These are the numbers a human acts on — the totals, the
 * failure table, and the frontend-migration panel — so they are the part that most
 * needs covering.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExclusionRecord } from "./exclusions";
import type {
  FrontendBundleInfo,
  Report,
  SweepSummary,
  SweepWorkspaceResult,
} from "./report";
import { compareStrings } from "./util";

/** How a frontend bundle is packaged, from the systems its layout advertises. */
export type Packaging =
  "legacy-only" | "new-frontend-system-only" | "dual" | "none";

export type FrontendPackaging = {
  packageName: string;
  workspace: string;
  version: string;
  packaging: Packaging;
  /** See {@link nfsSupportOf}. Recorded per package so the aggregate is auditable. */
  nfsSupport: NfsSupport;
};

export type Aggregate = {
  support: string;
  /** Distinct shard indices seen, not the number of files read. */
  shards: number;
  workspaces: {
    total: number;
    passed: number;
    failed: number;
    /**
     * Workspaces where every in-scope package was install-excluded, so the harness
     * never ran. A workspace count, not a package count.
     */
    skipped: number;
  };
  packages: {
    /** Artifacts pulled and laid out by the install CLI. */
    installed: number;
    backendTotal: number;
    /** require()'d and exposing a default BackendFeature. */
    backendLoaded: number;
    /** Loaded AND part of a backend that actually started. */
    backendBooted: number;
    /** Installed and layout-validated, but deliberately not booted — see `exclusions`. */
    backendExcludedFromBoot: number;
    /** Loaded into a backend that then failed to start. */
    backendBootFailed: number;
    frontendTotal: number;
    frontendValidBundle: number;
  };
  /** Frontend-system migration panel, over every frontend bundle the sweep saw. */
  frontendSystems: {
    counts: Record<Packaging, number>;
    packages: FrontendPackaging[];
    /**
     * How much of the new-frontend-system count is established rather than merely
     * not ruled out. `undetermined` bundles declare no `backstage.features`, so the
     * host decides at runtime and the sweep cannot say — see {@link nfsSupportOf}.
     */
    nfsSupport: Record<NfsSupport, number>;
  };
  failures: Array<{ workspace: string; status: string; detail: string }>;
  exclusions: ExclusionRecord[];
};

const DETAIL_LIMIT = 220;

/** Every `sweep-shard-*.json` under `dir`, recursively, in sorted order. */
export type DirEntry = { name: string; isDirectory: boolean };

export function findSummaries(
  dir: string,
  // Seam: see readWorkspacePackages — readdir order is filesystem-dependent.
  listEntries: (path: string) => DirEntry[] = (path) =>
    readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    })),
): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of [...listEntries(current)].sort((a, b) =>
      compareStrings(a.name, b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory) walk(path);
      else if (/^sweep-shard-.*\.json$/.test(entry.name)) found.push(path);
    }
  };
  walk(dir);
  return found;
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}

/**
 * Check that the shard summaries actually cover the sweep that was launched.
 *
 * A shard whose artifact never uploaded (job cancelled, runner lost, upload failed)
 * would otherwise vanish from the totals and let the run report a clean pass over a
 * subset. The caller knows how many shards it launched; hold it to that.
 *
 * Compares the index SET, not its size: {0, 2} against an expected 2 has the same
 * size as {0, 1} while missing shard 1 and carrying a shard 2 from a different run.
 *
 * The plan drops empty shards but keeps each shard's original index, and LPT fills
 * from index 0 without gaps, so the launched indices are always `0..expected-1`.
 *
 * Returns null when the coverage is complete, or a message describing what is wrong.
 */
export function describeShardCoverage(
  seen: Set<number>,
  rawExpected: string,
): string | null {
  const expected = Number(rawExpected);
  if (!Number.isInteger(expected) || expected < 1) {
    return `--expect-shards must be a positive integer, got '${rawExpected}'`;
  }
  const missing = Array.from({ length: expected }, (_, i) => i).filter(
    (i) => !seen.has(i),
  );
  const spurious = [...seen].filter((i) => i >= expected).sort(compareNumbers);
  if (missing.length === 0 && spurious.length === 0) return null;

  const problems = [
    missing.length
      ? `missing shard(s): ${missing.join(", ")} — results would cover only part of the sweep`
      : undefined,
    spurious.length
      ? `unexpected shard(s): ${spurious.join(", ")} — summaries from a different run are mixed in`
      : undefined,
  ].filter(Boolean);
  return (
    `expected shards 0..${expected - 1}, found ` +
    `${[...seen].sort(compareNumbers).join(", ")}. ${problems.join("; ")}.`
  );
}

/**
 * How much the sweep can say about a bundle's new-frontend-system support.
 *
 * Three states, not two, because the data has three. `systems` says only that
 * `dist/mf-manifest.json` exists — module-federation *layout*, which RHDH also uses to
 * ship legacy Scalprum plugins — so it overstates. But the obvious correction,
 * "count it only when `nfsFeaturesExposed` is non-empty", understates by exactly as
 * much: that array is empty both when a package declares entry points its remote never
 * exposes *and* when it declares no `backstage.features` at all, and those are not the
 * same fact.
 *
 * `describeNfsShortfall` in harness-logic.ts already draws that line and explains why:
 * with `backstage.features` absent, RHDH's `nfsModuleFilter` installs no filter at all,
 * the router advertises every exposed module, and the dynamic feature loader decides at
 * runtime from each module's `$$type`. Whether NFS mounts anything then cannot be known
 * without executing the bundle. Over the 2026-08-21 community sweep that is the state of
 * 27 of 47 bundles — ten of which expose an `alpha` module, the same shape as bundles
 * that are unambiguously NFS. Publishing those as legacy would be a guess stated as a
 * fact, in the opposite direction from the one this function exists to fix.
 */
export type NfsSupport = "confirmed" | "none" | "undetermined";

/**
 * The part of a frontend bundle these verdicts read.
 *
 * Named rather than repeated inline: the two functions below have to agree on it,
 * and a `FrontendBundleInfo` that grew a field would otherwise drift past both.
 */
export type BundleSystems = Pick<FrontendBundleInfo, "systems" | "mf">;

export function nfsSupportOf(bundle: BundleSystems): NfsSupport {
  if (!bundle.systems.includes("new-frontend-system")) return "none";
  const mf = bundle.mf;
  // A layout the router will not serve mounts nothing, whatever it declares.
  if (!mf?.servable) return "none";
  // Nothing declared. Two ways to arrive here — the package declares no
  // backstage.features, or reading it failed (readNfsFeatures returns an empty list
  // beside the error) — and for a three-way verdict they give the same answer, so
  // nfsFeaturesError needs no branch of its own. describeNfsShortfall separates them
  // only because it emits prose, where "declares none" and "we could not look" have to
  // read differently.
  if (mf.nfsFeatures.length === 0) return "undetermined";
  // Declared and exposed is the only combination that establishes support: declaring an
  // entry point the remote never exposes leaves nothing for the host to resolve.
  return mf.nfsFeaturesExposed.length > 0 ? "confirmed" : "none";
}

/**
 * Classify a bundle by the frontend systems it can serve.
 *
 * Undetermined counts toward the new frontend system, which keeps this number where it
 * was for those bundles rather than replacing an overstatement with an understatement.
 * What the panel gains is the confirmed/undetermined split beside it, so the reader can
 * see how much of the figure is established and how much is merely not ruled out.
 */
export function packagingOf(bundle: BundleSystems): Packaging {
  const legacy = bundle.systems.includes("legacy");
  const modern = nfsSupportOf(bundle) !== "none";
  if (legacy && modern) return "dual";
  if (legacy) return "legacy-only";
  if (modern) return "new-frontend-system-only";
  return "none";
}

/**
 * Squash an error into one line. Plugin errors carry `Require stack:` dumps and
 * backend-start errors are multi-line; either would break a Markdown table row apart.
 * Escaping is deliberately NOT done here — see renderMarkdown.
 */
export function oneLine(text: string, limit: number = DETAIL_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** One line of failure detail, preferring the most specific error the report holds. */
export function failureDetail(result: SweepWorkspaceResult): string {
  const report = result.report;
  if (!report) return `harness exited ${result.exitCode} with no report`;
  const loadError = report.backend.errors?.[0];
  if (loadError) return oneLine(`${loadError.plugin.name}: ${loadError.error}`);
  if (!report.backendStart.ok && report.backendStart.error) {
    return oneLine(`backend start: ${report.backendStart.error}`);
  }
  const bundleError = report.frontend.errors?.[0];
  if (bundleError) {
    return oneLine(`${bundleError.plugin.name}: ${bundleError.error}`);
  }
  return report.status;
}

function accumulatePackageCounts(report: Report, aggregate: Aggregate): void {
  aggregate.packages.installed += report.backend.total + report.frontend.total;
  aggregate.packages.backendTotal += report.backend.total;
  aggregate.packages.backendLoaded += report.backend.loaded;
  // `backend.loaded` means require()'d with a default BackendFeature, and it is
  // computed BEFORE startTestBackend runs. Counting it as "booted" reported every
  // loaded plugin of a workspace whose boot threw as having booted — overstating the
  // sweep's headline signal. A plugin booted only if the backend it joined came up.
  aggregate.packages.backendBooted += report.backendStart.ok
    ? report.backend.loaded
    : 0;
  aggregate.packages.backendExcludedFromBoot += report.backend.skipped.length;
  // Counted separately from the deliberate exclusions: a reader reconciling the panel
  // against backendTotal found these packages in no row at all.
  aggregate.packages.backendBootFailed += report.backendStart.ok
    ? 0
    : report.backend.loaded;
  aggregate.packages.frontendTotal += report.frontend.total;
  aggregate.packages.frontendValidBundle += report.frontend.valid;
}

function emptyAggregate(support: string): Aggregate {
  return {
    support,
    shards: 0,
    workspaces: { total: 0, passed: 0, failed: 0, skipped: 0 },
    packages: {
      installed: 0,
      backendTotal: 0,
      backendLoaded: 0,
      backendBooted: 0,
      backendExcludedFromBoot: 0,
      backendBootFailed: 0,
      frontendTotal: 0,
      frontendValidBundle: 0,
    },
    frontendSystems: {
      counts: {
        "legacy-only": 0,
        "new-frontend-system-only": 0,
        dual: 0,
        none: 0,
      },
      packages: [],
      nfsSupport: { confirmed: 0, none: 0, undetermined: 0 },
    },
    failures: [],
    exclusions: [],
  };
}

/** Fold one workspace result into the running totals. */
function accumulateWorkspaceResult(
  result: SweepSummary["workspaces"][number],
  aggregate: Aggregate,
): void {
  aggregate.workspaces.total += 1;
  if (result.status === "pass") aggregate.workspaces.passed += 1;
  else if (result.status === "skipped") aggregate.workspaces.skipped += 1;
  else {
    aggregate.workspaces.failed += 1;
    aggregate.failures.push({
      workspace: result.workspace,
      status: result.status,
      detail: failureDetail(result),
    });
  }
  // Tolerate a workspace entry without exclusions/report: isSweepSummary only
  // validates that `workspaces` is an array, so a hollow element reaches here and
  // must not crash the job that exists to report on everything else.
  aggregate.exclusions.push(...(result.exclusions ?? []));
  if (!result.report) return;
  accumulatePackageCounts(result.report, aggregate);
  for (const bundle of result.report.frontend.bundles ?? []) {
    const packaging = packagingOf(bundle);
    const nfsSupport = nfsSupportOf(bundle);
    aggregate.frontendSystems.counts[packaging] += 1;
    aggregate.frontendSystems.nfsSupport[nfsSupport] += 1;
    aggregate.frontendSystems.packages.push({
      packageName: bundle.name,
      workspace: result.workspace,
      version: bundle.version,
      packaging,
      // Per package as well as in aggregate, so a reader of aggregate.json can list
      // which bundles are undetermined without re-running the sweep.
      nfsSupport,
    });
  }
}

export function buildAggregate(summaries: SweepSummary[]): Aggregate {
  const aggregate = emptyAggregate(summaries[0]?.support ?? "unknown");
  // Distinct shard indices, not the number of files read: the same shard reachable
  // through two --in roots must not double the shard count when --expect-shards (which
  // counts indices) would still pass.
  aggregate.shards = new Set(summaries.map((s) => s.shard.index)).size;

  for (const summary of summaries) {
    // A shard that ran no workspaces is a failure summarize() already recorded; without
    // this the aggregate reports "0/0 workspaces passed" and exits 0 over it.
    if (summary.status === "fail" && summary.workspaces.length === 0) {
      aggregate.workspaces.failed += 1;
      aggregate.failures.push({
        workspace: `(shard ${summary.shard.index})`,
        status: "fail",
        detail: "the shard ran no workspaces — the plan and the run disagreed",
      });
    }
    for (const result of summary.workspaces) {
      accumulateWorkspaceResult(result, aggregate);
    }
  }

  aggregate.frontendSystems.packages.sort((a, b) =>
    compareStrings(a.packageName, b.packageName),
  );
  aggregate.failures.sort((a, b) => compareStrings(a.workspace, b.workspace));
  aggregate.exclusions.sort((a, b) =>
    compareStrings(a.packageName, b.packageName),
  );
  return aggregate;
}

/** Escape the characters that would break out of a Markdown table cell. */
function cell(text: string): string {
  return text.replaceAll("|", String.raw`\|`);
}

export function renderMarkdown(aggregate: Aggregate): string {
  const { workspaces, packages, frontendSystems } = aggregate;
  const lines: string[] = [
    `## Plugin sweep — \`${aggregate.support}\``,
    "",
    `${workspaces.passed}/${workspaces.total} workspaces passed` +
      (workspaces.skipped ? `, ${workspaces.skipped} fully excluded` : "") +
      ` across ${aggregate.shards} shard(s).`,
    "",
    "| Signal | Result |",
    "| --- | --- |",
    `| Artifacts installed | ${packages.installed} |`,
    `| Backend loaded | ${packages.backendLoaded}/${packages.backendTotal} |`,
    `| Backend booted | ${packages.backendBooted}/${packages.backendTotal} |`,
    `| Backend excluded from boot | ${packages.backendExcludedFromBoot} |`,
    `| Backend loaded but boot failed | ${packages.backendBootFailed} |`,
    `| Frontend bundle layout valid | ${packages.frontendValidBundle}/${packages.frontendTotal} |`,
    "",
    "### Frontend system packaging",
    "",
    "Which frontend system each bundle ships — the migration signal this sweep exists to keep fresh.",
    "",
    "| Packaging | Packages |",
    "| --- | --- |",
    `| Legacy (Scalprum) only | ${frontendSystems.counts["legacy-only"]} |`,
    `| New frontend system only | ${frontendSystems.counts["new-frontend-system-only"]} |`,
    `| Dual | ${frontendSystems.counts.dual} |`,
    `| No recognized layout | ${frontendSystems.counts.none} |`,
    "",
    `Of the bundles counted above as shipping the new frontend system, ` +
      `**${frontendSystems.nfsSupport.confirmed}** are confirmed — the remote is ` +
      `servable and exposes an NFS entry point it declares — and ` +
      `**${frontendSystems.nfsSupport.undetermined}** are undetermined: they declare ` +
      "no `backstage.features`, so `nfsModuleFilter` installs no filter, every exposed " +
      "module is advertised, and whether the new frontend system mounts any of them " +
      "cannot be known without executing the bundle. Read the migration figure as the " +
      "confirmed count, not the total.",
    "",
  ];

  if (aggregate.failures.length > 0) {
    lines.push(
      "### Failures",
      "",
      "| Workspace | Status | Detail |",
      "| --- | --- | --- |",
    );
    for (const failure of aggregate.failures) {
      lines.push(
        `| ${failure.workspace} | \`${failure.status}\` | ${cell(failure.detail)} |`,
      );
    }
    lines.push("");
  }

  if (aggregate.exclusions.length > 0) {
    lines.push(
      "### Tracked exclusions",
      "",
      "| Package | Scope | Ticket |",
      "| --- | --- | --- |",
    );
    for (const exclusion of aggregate.exclusions) {
      lines.push(
        `| \`${cell(exclusion.packageName)}\` | ${exclusion.scope} | ${exclusion.ticket} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
