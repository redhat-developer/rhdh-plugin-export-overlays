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
  isReport,
  REPORT_SCHEMA_VERSION,
  SWEEP_SCHEMA_VERSION,
  type Report,
  type SweepSummary,
  type SweepWorkspaceResult,
} from "./report";
import {
  buildPlan,
  deriveStatus,
  resolvePlan,
  statusGlyph,
  summarize,
} from "./sweep-plan";
import { isSupportLevel, SUPPORT_LEVELS, type WorkspaceGroup } from "./support";
import { errorMessage } from "./util";

const HERE = dirname(fileURLToPath(import.meta.url));
// All three entry points are bundled into dist/, so the harness sits next to this file.
const HARNESS = join(HERE, "native-smoke.mjs");
const HARNESS_ROOT = dirname(HERE);
const REPO_ROOT = dirname(HARNESS_ROOT);

type CliInputs = {
  support: string;
  shards: number;
  shard: number;
  exclusions: Exclusion[];
  /** Contained absolute path, forwarded to each harness process. */
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

/**
 * Resolve and parse `--exclusions`, if given. Kept separate from parseCliInputs so the
 * three ways it can fail — escaping the working directory, missing, malformed — read
 * as one concern rather than padding the argument parser.
 */
function readExclusions(arg: string | undefined): {
  exclusions: Exclusion[];
  exclusionsFile?: string;
} {
  if (!arg) return { exclusions: [] };
  try {
    const exclusionsFile = requireContained("--exclusions", arg);
    if (!existsSync(exclusionsFile)) {
      fail(`--exclusions file not found: ${arg}`);
    }
    return { exclusions: loadExclusions(exclusionsFile), exclusionsFile };
  } catch (err) {
    fail(errorMessage(err));
  }
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

  const { exclusions, exclusionsFile } = readExclusions(values.exclusions);

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
      const parsed: unknown = JSON.parse(readFileSync(outFile, "utf8"));
      if (isReport(parsed)) {
        report = parsed;
      } else {
        console.error(
          `✗ ${group.workspace}: results file is not a report at schemaVersion ` +
            `${REPORT_SCHEMA_VERSION} — treating the run as an error.`,
        );
      }
    } catch (err) {
      console.error(
        `✗ ${group.workspace}: results file is unreadable (${errorMessage(err)})`,
      );
    }
  }

  const exitCode = result.status ?? 1;
  const status = deriveStatus(report, exitCode);
  if (report?.status === "pass" && exitCode !== 0) {
    console.error(
      `✗ ${group.workspace}: harness wrote a passing report but exited ${exitCode} — treating as an error.`,
    );
  }

  return {
    workspace: group.workspace,
    packageCount: group.packages.length,
    status,
    exitCode,
    durationMs,
    report,
    // The harness applies the same install-scope excluder to the same package set, so
    // taking both copies duplicated every record. Its report is a superset on success
    // (it also carries boot-scope records) — but writeErrorReport hardcodes an empty
    // list, so on an error report the driver's own records are all that survive.
    exclusions:
      report && report.status !== "error" ? report.exclusions : excluded,
  };
}

function main(): number {
  const inputs = parseCliInputs();

  if (inputs.plan) {
    console.log(
      JSON.stringify(
        buildPlan(REPO_ROOT, inputs.support, inputs.shards),
        null,
        2,
      ),
    );
    return 0;
  }

  const { shards } = resolvePlan(REPO_ROOT, inputs.support, inputs.shards);
  const groups = shards[inputs.shard];

  mkdirSync(inputs.outDir, { recursive: true });
  console.log(
    `▶ sweep '${inputs.support}' shard ${inputs.shard + 1}/${inputs.shards}: ` +
      `${groups.length} workspace(s) — ${groups.map((g) => g.workspace).join(", ") || "(none)"}`,
  );

  const results = groups.map((group) => runWorkspace(group, inputs));
  const summary: SweepSummary = summarize(
    results,
    inputs.support,
    inputs.shard,
    inputs.shards,
    SWEEP_SCHEMA_VERSION,
  );

  const summaryPath = join(inputs.outDir, `sweep-shard-${inputs.shard}.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`\n▶ shard summary → ${summaryPath} (status: ${summary.status})`);
  for (const result of results) {
    console.log(
      `  ${statusGlyph(result.status)} ` +
        `${result.workspace}: ${result.status} (${Math.round(result.durationMs / 1000)}s)`,
    );
  }
  return summary.status === "pass" ? 0 : 1;
}

try {
  process.exit(main());
} catch (err) {
  // Anything that escapes fail() — a missing workspaces/ dir, an exclusions parse
  // error, EACCES on the out dir — would otherwise print a raw stack trace in CI.
  console.error(errorMessage(err));
  process.exit(1);
}
