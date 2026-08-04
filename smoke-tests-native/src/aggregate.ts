/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Merge the sharded sweep summaries into one verdict (RHIDP-13510).
 *
 * Reads every `sweep-shard-*.json` under the given directories — CI downloads one
 * artifact per shard, each into its own subdirectory, so the search recurses — and
 * emits `aggregate.json` plus a Markdown report for `$GITHUB_STEP_SUMMARY`.
 *
 * Besides pass/fail it reports the frontend-system breakdown. Each run records which
 * system every frontend bundle ships (`frontend.bundles[].systems`: legacy Scalprum,
 * module federation, or both), so running this on a schedule gives the new-frontend-
 * system migration a continuously refreshed view across the community frontend
 * packages — which today has no automated source.
 *
 * Usage:
 *   yarn aggregate --in results [--in more-results] [--out aggregate.json]
 *                  [--summary summary.md] [--expect-shards 6]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ExclusionRecord } from "./exclusions";
import type { FrontendSystem } from "./loader";
import { requireContained, resolveContained } from "./paths";
import {
  isSweepSummary,
  SWEEP_SCHEMA_VERSION,
  type Report,
  type SweepSummary,
  type SweepWorkspaceResult,
} from "./report";

/** Ascending string comparison, stable across environments (no locale collation). */
function byString(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** How a frontend bundle is packaged, from the systems its layout advertises. */
type Packaging = "legacy-only" | "new-frontend-system-only" | "dual" | "none";

type FrontendPackaging = {
  packageName: string;
  workspace: string;
  version: string;
  packaging: Packaging;
};

type Aggregate = {
  support: string;
  shards: number;
  workspaces: {
    total: number;
    passed: number;
    failed: number;
    /** Every in-scope package barred by a tracked install-scope exclusion. */
    skipped: number;
  };
  packages: {
    /** Artifacts pulled and laid out by the install CLI. */
    installed: number;
    backendTotal: number;
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
  failures: Array<{
    workspace: string;
    status: string;
    detail: string;
  }>;
  exclusions: ExclusionRecord[];
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Every `sweep-shard-*.json` under `dir`, recursively, in sorted order. */
function findSummaries(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => byString(a.name, b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^sweep-shard-.*\.json$/.test(entry.name)) found.push(path);
    }
  };
  walk(dir);
  return found;
}

function packagingOf(systems: FrontendSystem[]): Packaging {
  const legacy = systems.includes("legacy");
  const modern = systems.includes("new-frontend-system");
  if (legacy && modern) return "dual";
  if (legacy) return "legacy-only";
  if (modern) return "new-frontend-system-only";
  return "none";
}

/**
 * Squash an error into one table-safe cell: plugin errors carry `Require stack:` dumps
 * and backend-start errors are multi-line, either of which would break the row apart.
 */
function oneLine(text: string, limit = 220): string {
  const flat = text
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("|", String.raw`\|`);
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** One line of failure detail, preferring the most specific error the report holds. */
function failureDetail(result: SweepWorkspaceResult): string {
  const report = result.report;
  if (!report) return `harness exited ${result.exitCode} with no report`;
  const loadError = report.backend.errors[0];
  if (loadError) {
    return oneLine(`${loadError.plugin.name}: ${loadError.error}`);
  }
  if (!report.backendStart.ok && report.backendStart.error) {
    return oneLine(`backend start: ${report.backendStart.error}`);
  }
  const bundleError = report.frontend.errors[0];
  if (bundleError) {
    return oneLine(`${bundleError.plugin.name}: ${bundleError.error}`);
  }
  return report.status;
}

function accumulate(report: Report, aggregate: Aggregate): void {
  aggregate.packages.installed += report.backend.total + report.frontend.total;
  aggregate.packages.backendTotal += report.backend.total;
  aggregate.packages.backendBooted += report.backend.loaded;
  aggregate.packages.backendNotBooted += report.backend.skipped.length;
  aggregate.packages.frontendTotal += report.frontend.total;
  aggregate.packages.frontendValidBundle += report.frontend.valid;
}

function buildAggregate(summaries: SweepSummary[]): Aggregate {
  const aggregate: Aggregate = {
    support: summaries[0]?.support ?? "unknown",
    shards: summaries.length,
    workspaces: { total: 0, passed: 0, failed: 0, skipped: 0 },
    packages: {
      installed: 0,
      backendTotal: 0,
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
      aggregate.exclusions.push(...result.exclusions);
      if (!result.report) continue;
      accumulate(result.report, aggregate);
      for (const bundle of result.report.frontend.bundles) {
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
    byString(a.packageName, b.packageName),
  );
  aggregate.failures.sort((a, b) => byString(a.workspace, b.workspace));
  return aggregate;
}

function renderMarkdown(aggregate: Aggregate): string {
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
      // detail is already flattened and pipe-escaped by oneLine(); aggregate.json keeps
      // the same single-line form so both views agree.
      lines.push(
        `| ${failure.workspace} | \`${failure.status}\` | ${failure.detail} |`,
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
    // One row per package even if several share a ticket; duplicates across shards
    // cannot happen (a package belongs to exactly one workspace).
    for (const exclusion of [...aggregate.exclusions].sort((a, b) =>
      byString(a.packageName, b.packageName),
    )) {
      lines.push(
        `| \`${exclusion.packageName}\` | ${exclusion.scope} | ${exclusion.ticket} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function main(): number {
  const { values } = parseArgs({
    options: {
      in: { type: "string", multiple: true },
      out: { type: "string" },
      summary: { type: "string" },
      "expect-shards": { type: "string" },
    },
  });

  // Every path below comes from argv, so contain each one to the working directory
  // before it reaches the filesystem (Sonar S8707).
  const inputs = values.in ?? ["results"];
  const roots = inputs.map((dir) => {
    const resolved = resolveContained(dir);
    if (!resolved) {
      fail(`--in must resolve inside the working directory: ${dir}`);
    }
    try {
      if (!statSync(resolved).isDirectory()) {
        fail(`--in is not a directory: ${dir}`);
      }
    } catch {
      fail(`--in directory not found: ${dir}`);
    }
    return resolved;
  });
  // findSummaries only ever descends from a contained root, so its results are
  // contained too.
  const files = roots.flatMap((root) => findSummaries(root));
  if (files.length === 0) {
    // Not an empty pass: a sweep that produced no summaries did not run.
    fail(`no sweep-shard-*.json found under ${inputs.join(", ")}`);
  }

  const summaries = files.map((file) => {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isSweepSummary(parsed)) {
      fail(
        `${file}: not a sweep summary at schemaVersion ${SWEEP_SCHEMA_VERSION} — ` +
          `refusing to aggregate a file whose shape cannot be trusted.`,
      );
    }
    return parsed;
  });

  // A shard whose artifact never uploaded (job cancelled, runner lost, upload failed)
  // would otherwise just vanish from the totals and let the run report a clean pass
  // over a subset. The caller knows how many shards it launched; hold it to that.
  if (values["expect-shards"] !== undefined) {
    const expected = Number(values["expect-shards"]);
    if (!Number.isInteger(expected) || expected < 1) {
      fail(
        `--expect-shards must be a positive integer, got '${values["expect-shards"]}'`,
      );
    }
    const seen = new Set(summaries.map((s) => s.shard.index));
    if (seen.size !== expected) {
      const missing = Array.from({ length: expected }, (_, i) => i).filter(
        (i) => !seen.has(i),
      );
      fail(
        `expected ${expected} shard summaries, found ${seen.size} — missing shard(s): ` +
          `${missing.join(", ")}. Results would cover only part of the sweep.`,
      );
    }
  }

  const aggregate = buildAggregate(summaries);

  let outPath: string;
  let summaryPath: string | undefined;
  try {
    outPath = requireContained("--out", values.out ?? "aggregate.json");
    summaryPath = values.summary
      ? requireContained("--summary", values.summary)
      : undefined;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  writeFileSync(outPath, JSON.stringify(aggregate, null, 2));
  const markdown = renderMarkdown(aggregate);
  if (summaryPath) writeFileSync(summaryPath, markdown);

  // Report the caller's own argument rather than the absolute resolved path: the
  // resolved form adds nothing here and puts the runner's directory layout into CI
  // logs (Sonar S8689).
  console.log(markdown);
  console.log(
    `▶ aggregate → ${values.out ?? "aggregate.json"} (${files.length} shard summary file(s))`,
  );
  return aggregate.workspaces.failed > 0 ? 1 : 0;
}

process.exit(main());
