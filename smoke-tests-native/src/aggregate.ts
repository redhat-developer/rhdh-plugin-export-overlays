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
  describeShardCoverage,
  findSummaries,
  renderMarkdown,
} from "./aggregate-report";
import { requireContained, resolveContained } from "./paths";
import { isSweepSummary, SWEEP_SCHEMA_VERSION } from "./report";
import { compareStrings, errorMessage } from "./util";

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      // A truncated or zero-byte artifact is exactly the "upload failed" case this job
      // guards against; a bare SyntaxError names no file.
      fail(`${file}: unreadable JSON (${errorMessage(err)})`);
    }
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
  const levels = new Set<string>();
  for (const summary of summaries) {
    if (seen.has(summary.shard.index)) {
      fail(
        `shard ${summary.shard.index} appears in more than one summary — ` +
          `every total would be counted twice.`,
      );
    }
    seen.add(summary.shard.index);
    levels.add(summary.support);
  }
  // buildAggregate labels the report with the first summary's level, so mixing two
  // would silently file one tier's results under another's heading.
  if (levels.size > 1) {
    fail(
      `summaries span more than one support level ` +
        `(${[...levels].sort(compareStrings).join(", ")}) — ` +
        `they belong to different sweeps and must not be aggregated together.`,
    );
  }

  if (values["expect-shards"] !== undefined) {
    const problem = describeShardCoverage(seen, values["expect-shards"]);
    if (problem) fail(problem);
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

  console.log(markdown);
  // Report the caller's own argument rather than the absolute resolved path: the
  // resolved form adds nothing and puts the runner's directory layout into CI logs
  // (Sonar S8689).
  console.log(
    `▶ aggregate → ${values.out ?? "aggregate.json"} (${files.length} shard summary file(s))`,
  );
  return aggregate.workspaces.failed > 0 ? 1 : 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}
