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
import { NpmClient } from "./npm-client.ts";
import { ObsoleteDetector } from "./obsolete-detector.ts";
import type { DetectorOptions, PRVerdict, PullRequestSummary } from "./types.ts";
import { WorkspaceAnalyzer } from "./workspace-analyzer.ts";

export function parseArgs(argv: string[]): DetectorOptions {
  let repo = process.env.GITHUB_REPOSITORY || "";
  let baseBranch = "main";
  let prNumber: number | undefined;
  let dryRun = false;
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  let npmRegistry = "https://registry.npmjs.org";
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
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
      process.exit(0);
    } else if (arg === "--repo") {
      repo = argv[++i] || "";
    } else if (arg === "--base") {
      baseBranch = argv[++i] || "main";
    } else if (arg === "--pr") {
      const val = argv[++i];
      if (val) prNumber = parseInt(val, 10);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--dry-run=")) {
      dryRun = arg.split("=")[1] === "true";
    } else if (arg === "--token") {
      token = argv[++i] || "";
    } else if (arg === "--npm-registry") {
      npmRegistry = argv[++i] || npmRegistry;
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

  console.log(`\n=== Obsolete Plugin Update PR Detector ===`);
  console.log(`Repository:   ${options.repo}`);
  console.log(`Base Branch:  ${options.baseBranch}`);
  console.log(`Dry Run:      ${options.dryRun ? "YES (preview only)" : "NO (live closures)"}`);
  if (options.prNumber) {
    console.log(`Scope:        PR #${options.prNumber} only`);
  } else {
    console.log(`Scope:        All open PRs targeting '${options.baseBranch}'`);
  }
  console.log(`==========================================\n`);

  const githubClient = new GitHubClient(options.token);
  const npmClient = new NpmClient(options.npmRegistry);
  const analyzer = new WorkspaceAnalyzer(githubClient);
  const detector = new ObsoleteDetector(npmClient, githubClient);
  const executor = new ActionExecutor(githubClient);

  let prsToEvaluate: PullRequestSummary[] = [];

  if (options.prNumber) {
    const singlePr = await githubClient.getPR(owner, repoName, options.prNumber);
    prsToEvaluate = [singlePr];
  } else {
    const allOpenPrs = await githubClient.listOpenPRs(owner, repoName, options.baseBranch);
    // Filter for candidate branches or labels
    prsToEvaluate = allOpenPrs.filter((pr) => {
      const isWorkspaceBranch =
        pr.headRef.startsWith("workspaces/main__") ||
        pr.headRef.endsWith("/update-main") ||
        pr.title.startsWith("Update `") ||
        pr.labels.includes("workspace-update");
      return isWorkspaceBranch;
    });
    console.log(
      `Found ${allOpenPrs.length} open PR(s), ${prsToEvaluate.length} matched update candidate criteria.`,
    );
  }

  const verdicts: PRVerdict[] = [];

  for (const pr of prsToEvaluate) {
    console.log(`Evaluating PR #${pr.number}: ${pr.title}`);
    const files = await githubClient.getPRFiles(owner, repoName, pr.number);
    const analysis = await analyzer.analyzePR(owner, repoName, pr, files, options.baseBranch);

    if (!analysis.isCandidate) {
      if (options.verbose) {
        console.log(`  -> Skipped candidate: ${analysis.skipReason}`);
      }
      verdicts.push({
        pr,
        isCandidate: false,
        skipReason: analysis.skipReason,
        isObsolete: false,
        comparisons: [],
        actionTaken: "skipped",
      });
      continue;
    }

    const verdict = await detector.evaluatePR(pr, analysis);

    if (verdict.isObsolete) {
      console.log(`  -> OBSOLETE: ${verdict.reason}`);
      const executed = await executor.execute(owner, repoName, verdict, options.dryRun);
      verdicts.push(executed);
      if (options.dryRun) {
        console.log(`  -> [DRY-RUN] Previewed closure for PR #${pr.number}`);
      } else {
        console.log(`  -> Closed PR #${pr.number} and labeled 'superseded'`);
      }
    } else {
      console.log(`  -> Still current or newer than upstream (retaining open)`);
      verdicts.push({
        ...verdict,
        actionTaken: "skipped",
      });
    }
  }

  // Print summary
  printSummary(verdicts, options);
  writeStepSummary(verdicts, options);

  return verdicts;
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
      console.log(`  - ${mode} PR #${v.pr.number}: ${v.pr.title}`);
      if (v.reason) {
        console.log(`      Reason: ${v.reason}`);
      }
    }
  }
  console.log(`=========================================\n`);
}

function writeStepSummary(verdicts: PRVerdict[], options: DetectorOptions): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const obsolete = verdicts.filter((v) => v.isObsolete);
  const mode = options.dryRun ? "Dry Run Preview" : "Active Execution";

  let md = `## Obsolete Plugin Update PR Detection (${mode})\n\n`;
  md += `- **Repository:** \`${options.repo}\`\n`;
  md += `- **Base Branch:** \`${options.baseBranch}\`\n`;
  md += `- **Mode:** \`${options.dryRun ? "dry-run (no changes applied)" : "live (closed and labeled)"}\`\n`;
  md += `- **Total Evaluated:** ${verdicts.length}\n`;
  md += `- **Obsolete PRs Found:** ${obsolete.length}\n\n`;

  if (obsolete.length > 0) {
    md += `### Obsolete Pull Requests\n\n`;
    md += `| PR | Title | Action | Details |\n`;
    md += `|---|---|---|---|\n`;
    for (const v of obsolete) {
      const action = options.dryRun ? "⚠️ Would Close" : "🛑 Closed";
      const details = v.reason ?? "Superseded by newer release";
      md += `| [#${v.pr.number}](${v.pr.htmlUrl}) | ${v.pr.title} | ${action} | ${details} |\n`;
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

// Run CLI when invoked directly
if (isInvokedDirectly()) {
  const options = parseArgs(process.argv.slice(2));
  run(options).catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
