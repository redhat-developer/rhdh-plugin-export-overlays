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
import type { FrontendSystem } from "./loader";
import type { Report, SweepSummary, SweepWorkspaceResult } from "./report";
import { compareStrings } from "./util";

/** How a frontend bundle is packaged, from the systems its layout advertises. */
export type Packaging =
  "legacy-only" | "new-frontend-system-only" | "dual" | "none";

export type FrontendPackaging = {
  packageName: string;
  workspace: string;
  version: string;
  packaging: Packaging;
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
    /** Installed and layout-validated, but not booted — see `exclusions`. */
    backendNotBooted: number;
    frontendTotal: number;
    frontendValidBundle: number;
  };
  /** Frontend-system migration panel, over every frontend bundle the sweep saw. */
  frontendSystems: {
    counts: Record<Packaging, number>;
    packages: FrontendPackaging[];
  };
  failures: Array<{ workspace: string; status: string; detail: string }>;
  exclusions: ExclusionRecord[];
};

const DETAIL_LIMIT = 220;

/** Every `sweep-shard-*.json` under `dir`, recursively, in sorted order. */
export function findSummaries(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) =>
      compareStrings(a.name, b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^sweep-shard-.*\.json$/.test(entry.name)) found.push(path);
    }
  };
  walk(dir);
  return found;
}

export function packagingOf(systems: FrontendSystem[]): Packaging {
  const legacy = systems.includes("legacy");
  const modern = systems.includes("new-frontend-system");
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
  aggregate.packages.backendNotBooted += report.backend.skipped.length;
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
      backendNotBooted: 0,
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
    },
    failures: [],
    exclusions: [],
  };
}

export function buildAggregate(summaries: SweepSummary[]): Aggregate {
  const aggregate = emptyAggregate(summaries[0]?.support ?? "unknown");
  // Distinct shard indices, not the number of files read: the same shard reachable
  // through two --in roots must not double the shard count when --expect-shards (which
  // counts indices) would still pass.
  aggregate.shards = new Set(summaries.map((s) => s.shard.index)).size;

  for (const summary of summaries) {
    for (const result of summary.workspaces) {
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
      if (!result.report) continue;
      accumulatePackageCounts(result.report, aggregate);
      for (const bundle of result.report.frontend.bundles ?? []) {
        const packaging = packagingOf(bundle.systems);
        aggregate.frontendSystems.counts[packaging] += 1;
        aggregate.frontendSystems.packages.push({
          packageName: bundle.name,
          workspace: result.workspace,
          version: bundle.version,
          packaging,
        });
      }
    }
  }

  aggregate.frontendSystems.packages.sort((a, b) =>
    compareStrings(a.packageName, b.packageName),
  );
  aggregate.failures.sort((a, b) => compareStrings(a.workspace, b.workspace));
  return aggregate;
}

/** Escape the characters that would break out of a Markdown table cell. */
function cell(text: string): string {
  return text.replaceAll("|", String.raw`\|`);
}

export function renderMarkdown(aggregate: Aggregate): string {
  const { workspaces, packages, frontendSystems } = aggregate;
  const lines: string[] = [
    `## Community plugin sweep — \`${aggregate.support}\``,
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
    `| Backend installed but not booted | ${packages.backendNotBooted} |`,
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
    `| Neither (bundle invalid) | ${frontendSystems.counts.none} |`,
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
    for (const exclusion of [...aggregate.exclusions].sort((a, b) =>
      compareStrings(a.packageName, b.packageName),
    )) {
      lines.push(
        `| \`${cell(exclusion.packageName)}\` | ${exclusion.scope} | ${exclusion.ticket} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
