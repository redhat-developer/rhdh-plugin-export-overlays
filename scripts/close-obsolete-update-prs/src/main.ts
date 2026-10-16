#!/usr/bin/env node
/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionExecutor } from "./executor.ts";
import { GitHubClient } from "./github-client.ts";
import { sanitizeLog } from "./helpers.ts";
import { NpmClient } from "./npm-client.ts";
import { ObsoleteDetector } from "./obsolete-detector.ts";
import type { DetectorOptions, PRVerdict, PullRequestSummary } from "./types.ts";
import { WorkspaceAnalyzer } from "./workspace-analyzer.ts";

interface ExecutionContext {
  owner: string;
  repo: string;
  options: DetectorOptions;
  analyzer: WorkspaceAnalyzer;
  detector: ObsoleteDetector;
  executor: ActionExecutor;
  githubClient: GitHubClient;
}

function printHelp(): void {
  console.log(`
Usage: close-obsolete-update-prs [options]

Options:
  --repo <owner/repo>       Target GitHub repository (default: $GITHUB_REPOSITORY)
  --base <branch>           Target base branch (default: main)
  --pr <number>             Specific PR number to evaluate
  --dry-run                 Preview candidate closures without making changes (default: false)
  --token <token>           GitHub token (default: $GITHUB_TOKEN or $GH_TOKEN)
  --npm-registry <url>      NPM registry URL (default: https://registry.npmjs.org)
  --verbose                 Enable verbose logging
  --help, -h                Show this help message
`);
}

export function parseArgs(argv: string[]): DetectorOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let repo = process.env["GITHUB_REPOSITORY"] || "";
  let baseBranch = "main";
  let prNumber: number | undefined;
  let dryRun = false;
  let token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"] || "";
  let npmRegistry = "https://registry.npmjs.org";
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--repo") {
      repo = argv[++i] ?? "";
    } else if (arg === "--base") {
      baseBranch = argv[++i] ?? "main";
    } else if (arg === "--pr") {
      const parsedPr = Number.parseInt(argv[++i] ?? "", 10);
      prNumber = Number.isNaN(parsedPr) ? undefined : parsedPr;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--dry-run=")) {
      dryRun = arg.slice(10) === "true";
    } else if (arg === "--token") {
      token = argv[++i] ?? "";
    } else if (arg === "--npm-registry") {
      npmRegistry = argv[++i] ?? npmRegistry;
    } else if (arg === "--verbose") {
      verbose = true;
    }
  }

  if (!repo) {
    console.error("Error: --repo <owner/repo> or $GITHUB_REPOSITORY is required");
    process.exit(1);
  }

  return {
    repo,
    baseBranch,
    prNumber,
    dryRun,
    token,
    npmRegistry,
    verbose,
  };
}

export async function run(options: DetectorOptions): Promise<PRVerdict[]> {
  const [owner, repoName] = options.repo.split("/");
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format '${options.repo}'. Expected 'owner/repo'.`);
  }

  logBanner(options);

  const githubClient = new GitHubClient(options.token);
  const npmClient = new NpmClient(options.npmRegistry);
  const analyzer = new WorkspaceAnalyzer(githubClient);
  const detector = new ObsoleteDetector(npmClient, githubClient);
  const executor = new ActionExecutor(githubClient);

  const ctx: ExecutionContext = {
    owner,
    repo: repoName,
    options,
    analyzer,
    detector,
    executor,
    githubClient,
  };

  const prsToEvaluate = await fetchCandidatePrs(
    githubClient,
    owner,
    repoName,
    options.baseBranch,
    options.prNumber,
  );

  const verdicts = await Promise.all(prsToEvaluate.map((pr) => processCandidatePr(pr, ctx)));

  printSummary(verdicts, options);
  writeStepSummary(verdicts, options);

  return verdicts;
}

function logBanner(options: DetectorOptions): void {
  console.log(`\n=== Obsolete Plugin Update PR Detector ===`);
  console.log(`Repository:   ${sanitizeLog(options.repo)}`);
  console.log(`Base Branch:  ${sanitizeLog(options.baseBranch)}`);
  console.log(`Dry Run:      ${options.dryRun ? "YES (preview only)" : "NO (live closures)"}`);
  if (options.prNumber) {
    console.log(`Scope:        PR #${options.prNumber} only`);
  } else {
    console.log(`Scope:        All open PRs targeting '${sanitizeLog(options.baseBranch)}'`);
  }
  console.log(`==========================================\n`);
}

async function fetchCandidatePrs(
  githubClient: GitHubClient,
  owner: string,
  repo: string,
  baseBranch: string,
  prNumber?: number,
): Promise<PullRequestSummary[]> {
  if (prNumber) {
    const singlePr = await githubClient.getPR(owner, repo, prNumber);
    return [singlePr];
  }

  const allOpenPrs = await githubClient.listOpenPRs(owner, repo, baseBranch);
  const candidates = allOpenPrs.filter((pr) => {
    return (
      pr.headRef.startsWith("workspaces/main__") ||
      pr.headRef.endsWith("/update-main") ||
      pr.title.startsWith("Update `") ||
      pr.labels.includes("workspace-update")
    );
  });
  console.log(
    `Found ${allOpenPrs.length} open PR(s), ${candidates.length} matched update candidate criteria.`,
  );
  return candidates;
}

async function processCandidatePr(
  pr: PullRequestSummary,
  ctx: ExecutionContext,
): Promise<PRVerdict> {
  const safeTitle = sanitizeLog(pr.title);
  console.log(`Evaluating PR #${pr.number}: ${safeTitle}`);
  const files = await ctx.githubClient.getPRFiles(ctx.owner, ctx.repo, pr.number);
  const analysis = await ctx.analyzer.analyzePR(
    ctx.owner,
    ctx.repo,
    pr,
    files,
    ctx.options.baseBranch,
  );

  if (!analysis.isCandidate) {
    if (ctx.options.verbose) {
      console.log(`  -> Skipped candidate: ${sanitizeLog(analysis.skipReason)}`);
    }
    return {
      pr,
      isCandidate: false,
      skipReason: analysis.skipReason,
      isObsolete: false,
      comparisons: [],
      actionTaken: "skipped",
    };
  }

  const verdict = await ctx.detector.evaluatePR(pr, analysis);

  if (verdict.isObsolete) {
    console.log(`  -> OBSOLETE: ${sanitizeLog(verdict.reason)}`);
    const executed = await ctx.executor.execute(ctx.owner, ctx.repo, verdict, ctx.options.dryRun);
    if (ctx.options.dryRun) {
      console.log(`  -> [DRY-RUN] Previewed closure for PR #${pr.number}`);
    } else {
      console.log(`  -> Closed PR #${pr.number} and labeled 'superseded'`);
    }
    return executed;
  }

  console.log(`  -> Still current or newer than upstream (retaining open)`);
  return { ...verdict, actionTaken: "skipped" };
}

function printSummary(verdicts: PRVerdict[], options: DetectorOptions): void {
  const obsolete = verdicts.filter((v) => v.isObsolete);
  const skipped = verdicts.filter((v) => !v.isObsolete);

  console.log(`\n================ Summary ================`);
  console.log(`Total PRs Evaluated: ${verdicts.length}`);
  console.log(`Obsolete PRs:        ${obsolete.length}`);
  console.log(`Current / Skipped:   ${skipped.length}`);

  if (obsolete.length > 0) {
    console.log(`\nObsolete Pull Requests:`);
    for (const v of obsolete) {
      const mode = options.dryRun ? "[WOULD CLOSE]" : "[CLOSED]";
      console.log(`  - ${mode} PR #${v.pr.number}: ${sanitizeLog(v.pr.title)}`);
      if (v.reason) {
        console.log(`      Reason: ${sanitizeLog(v.reason)}`);
      }
    }
  }
  console.log(`=========================================\n`);
}

function writeStepSummary(verdicts: PRVerdict[], options: DetectorOptions): void {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (!summaryPath) return;

  const obsolete = verdicts.filter((v) => v.isObsolete);
  const mode = options.dryRun ? "Dry Run Preview" : "Active Execution";

  let md = `## Obsolete Plugin Update PR Detection (${mode})\n\n`;
  md += `- **Repository:** \`${sanitizeLog(options.repo)}\`\n`;
  md += `- **Base Branch:** \`${sanitizeLog(options.baseBranch)}\`\n`;
  md += `- **Mode:** \`${options.dryRun ? "dry-run (no changes applied)" : "live (closed and labeled)"}\`\n`;
  md += `- **Total Evaluated:** ${verdicts.length}\n`;
  md += `- **Obsolete PRs Found:** ${obsolete.length}\n\n`;

  if (obsolete.length > 0) {
    md += `### Obsolete Pull Requests\n\n`;
    md += `| PR | Title | Action | Details |\n`;
    md += `|---|---|---|---|\n`;
    for (const v of obsolete) {
      const action = options.dryRun ? "⚠️ Would Close" : "🛑 Closed";
      const details = sanitizeLog(v.reason ?? "Superseded by newer release");
      md += `| [#${v.pr.number}](${v.pr.htmlUrl}) | ${sanitizeLog(v.pr.title)} | ${action} | ${details} |\n`;
    }
  } else {
    md += `✅ No obsolete plugin update pull requests found.\n`;
  }

  try {
    appendFileSync(summaryPath, md, "utf8");
  } catch {
    // ignore
  }
}

function isInvokedDirectly(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Run CLI when invoked directly with top-level await
if (isInvokedDirectly()) {
  const options = parseArgs(process.argv.slice(2));
  try {
    await run(options);
  } catch (err: unknown) {
    const message = sanitizeLog(err instanceof Error ? err.message : String(err));
    console.error(`Fatal error: ${message}`);
    process.exit(1);
  }
}
