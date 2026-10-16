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
import { sanitizeLog, sanitizeNumber } from "./helpers.ts";
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

function logInfo(message: string): void {
  console.log(sanitizeLog(message));
}

function logError(message: string): void {
  console.error(sanitizeLog(message));
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
      prNumber = Number.isSafeInteger(parsedPr) && parsedPr > 0 ? parsedPr : undefined;
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
    logError("Error: --repo <owner/repo> or $GITHUB_REPOSITORY is required");
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
  const detector = new ObsoleteDetector(npmClient);
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

  const results = await Promise.allSettled(prsToEvaluate.map((pr) => processCandidatePr(pr, ctx)));
  const verdicts: PRVerdict[] = [];

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const pr = prsToEvaluate[i];
    if (!res || !pr) continue;
    if (res.status === "fulfilled") {
      verdicts.push(res.value);
    } else {
      logError(`Failed to process PR #${sanitizeNumber(pr.number)}: ${res.reason}`);
      verdicts.push({
        pr,
        isCandidate: false,
        skipReason: `Processing error: ${res.reason}`,
        isObsolete: false,
        comparisons: [],
        actionTaken: "skipped",
      });
    }
  }

  printSummary(verdicts, options);
  writeStepSummary(verdicts, options);

  return verdicts;
}

function logBanner(options: DetectorOptions): void {
  logInfo(`\n=== Obsolete Plugin Update PR Detector ===`);
  logInfo(`Repository:   ${options.repo}`);
  logInfo(`Base Branch:  ${options.baseBranch}`);
  logInfo(`Dry Run:      ${options.dryRun ? "YES (preview only)" : "NO (live closures)"}`);
  if (options.prNumber) {
    logInfo(`Scope:        PR #${sanitizeNumber(options.prNumber)} only`);
  } else {
    logInfo(`Scope:        All open PRs targeting '${options.baseBranch}'`);
  }
  logInfo(`==========================================\n`);
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
  // Candidate branch and PR heuristics:
  // 1. `workspaces/main__*`: Branch naming pattern generated by update-plugins-repo-refs.yaml
  //    (via rhdh-plugin-export-utils) for automated workspace updates targeting main.
  // 2. `*/update-main`: Legacy branch naming pattern used by older update automation runs
  //    (for example, PR #2525 with branch `homepage/update-main`).
  // 3. `Update \`*`: Standard PR title prefix generated by update-plugins-repo-refs automation.
  // 4. `workspace-update`: PR label automatically applied by label-mandatory-workspace-prs.yaml
  //    to all PRs that modify workspace files.
  const candidates = allOpenPrs.filter((pr) => {
    return (
      pr.headRef.startsWith("workspaces/main__") ||
      pr.headRef.endsWith("/update-main") ||
      pr.title.startsWith("Update `") ||
      pr.labels.includes("workspace-update")
    );
  });
  logInfo(
    `Found ${allOpenPrs.length} open PR(s), ${candidates.length} matched update candidate criteria.`,
  );
  return candidates;
}

async function processCandidatePr(
  pr: PullRequestSummary,
  ctx: ExecutionContext,
): Promise<PRVerdict> {
  const safeNumber = sanitizeNumber(pr.number);
  logInfo(`Evaluating PR #${safeNumber}: ${pr.title}`);
  const files = await ctx.githubClient.getPRFiles(ctx.owner, ctx.repo, safeNumber);
  const analysis = await ctx.analyzer.analyzePR(
    ctx.owner,
    ctx.repo,
    pr,
    files,
    ctx.options.baseBranch,
  );

  if (!analysis.isCandidate) {
    if (ctx.options.verbose) {
      logInfo(`  -> Skipped candidate: ${analysis.skipReason ?? "not a candidate"}`);
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
    logInfo(`  -> OBSOLETE: ${verdict.reason ?? "superseded"}`);
    const executed = await ctx.executor.execute(ctx.owner, ctx.repo, verdict, ctx.options.dryRun);
    if (ctx.options.dryRun) {
      logInfo(`  -> [DRY-RUN] Previewed closure for PR #${safeNumber}`);
    } else {
      logInfo(`  -> Closed PR #${safeNumber} and labeled 'superseded'`);
    }
    return executed;
  }

  logInfo(`  -> Still current or newer than upstream (retaining open)`);
  return { ...verdict, actionTaken: "skipped" };
}

function printSummary(verdicts: PRVerdict[], options: DetectorOptions): void {
  const obsolete = verdicts.filter((v) => v.isObsolete);
  const skipped = verdicts.filter((v) => !v.isObsolete);

  logInfo(`\n================ Summary ================`);
  logInfo(`Total PRs Evaluated: ${verdicts.length}`);
  logInfo(`Obsolete PRs:        ${obsolete.length}`);
  logInfo(`Current / Skipped:   ${skipped.length}`);

  if (obsolete.length > 0) {
    logInfo(`\nObsolete Pull Requests:`);
    for (const v of obsolete) {
      const mode = options.dryRun ? "[WOULD CLOSE]" : "[CLOSED]";
      const safeNumber = sanitizeNumber(v.pr.number);
      const ws = v.workspaceName ? `[${v.workspaceName}] ` : "";
      logInfo(`  - ${mode} ${ws}PR #${safeNumber}: ${v.pr.title}`);
      if (v.reason) {
        logInfo(`      Reason: ${v.reason}`);
      }
    }
  }
  logInfo(`=========================================\n`);
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
    md += `| PR | Workspace | Title | Action | Details |\n`;
    md += `|---|---|---|---|---|\n`;
    for (const v of obsolete) {
      const action = options.dryRun ? "⚠️ Would Close" : "🛑 Closed";
      const safeNumber = sanitizeNumber(v.pr.number);
      const ws = v.workspaceName ? `\`${v.workspaceName}\`` : "-";
      const details = sanitizeLog(v.reason ?? "Superseded by newer release");
      md += `| [#${safeNumber}](${v.pr.htmlUrl}) | ${ws} | ${sanitizeLog(v.pr.title)} | ${action} | ${details} |\n`;
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
    logError(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
