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
 * This file is argv in, files out. The logic lives in src/aggregate-report.ts so it
 * can be tested; anything beside the `process.exit` below is unreachable from a test.
 *
 * Usage:
 *   yarn aggregate --in results [--in more-results] [--out aggregate.json]
 *                  [--summary summary.md] [--expect-shards 6]
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  buildAggregate,
  findSummaries,
  renderMarkdown,
} from "./aggregate-report";
import { requireContained, resolveContained } from "./paths";
import { isSweepSummary, SWEEP_SCHEMA_VERSION } from "./report";
import { errorMessage } from "./util";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Contain each `--in` root, then confirm it is a directory that exists. */
function resolveInputDirs(dirs: string[]): string[] {
  return dirs.map((dir) => {
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
}

/**
 * A shard whose artifact never uploaded (job cancelled, runner lost, upload failed)
 * would otherwise vanish from the totals and let the run report a clean pass over a
 * subset. The caller knows how many shards it launched; hold it to that.
 *
 * The plan drops empty shards but keeps each shard's original index, and LPT fills
 * from index 0 without gaps, so the launched indices are always `0..expected-1`.
 */
function checkShardCount(seen: Set<number>, raw: string): void {
  const expected = Number(raw);
  if (!Number.isInteger(expected) || expected < 1) {
    fail(`--expect-shards must be a positive integer, got '${raw}'`);
  }
  if (seen.size === expected) return;
  const missing = Array.from({ length: expected }, (_, i) => i).filter(
    (i) => !seen.has(i),
  );
  fail(
    `expected ${expected} shard summaries, found ${seen.size}` +
      (missing.length ? ` — missing shard(s): ${missing.join(", ")}` : "") +
      `. Results would cover only part of the sweep.`,
  );
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

  const inDirs = values.in ?? ["results"];
  // findSummaries only ever descends from a contained root, so its results are
  // contained too (Sonar S8707).
  const files = resolveInputDirs(inDirs).flatMap((root) => findSummaries(root));
  if (files.length === 0) {
    // Not an empty pass: a sweep that produced no summaries did not run.
    fail(`no sweep-shard-*.json found under ${inDirs.join(", ")}`);
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

  // Two files for one shard (overlapping --in roots, a merged download) would double
  // every total while --expect-shards, which counts distinct indices, still passed.
  const seen = new Set<number>();
  for (const summary of summaries) {
    if (seen.has(summary.shard.index)) {
      fail(
        `shard ${summary.shard.index} appears in more than one summary — ` +
          `every total would be counted twice.`,
      );
    }
    seen.add(summary.shard.index);
  }

  if (values["expect-shards"] !== undefined) {
    checkShardCount(seen, values["expect-shards"]);
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
    fail(errorMessage(err));
  }

  writeFileSync(outPath, JSON.stringify(aggregate, null, 2));
  const markdown = renderMarkdown(aggregate);
  if (summaryPath) writeFileSync(summaryPath, markdown);

  // Report the caller's own argument rather than the absolute resolved path: the
  // resolved form adds nothing and puts the runner's directory layout into CI logs
  // (Sonar S8689).
  console.log(markdown);
  console.log(
    `▶ aggregate → ${values.out ?? "aggregate.json"} (${files.length} shard summary file(s))`,
  );
  return aggregate.workspaces.failed > 0 ? 1 : 0;
}

process.exit(main());
