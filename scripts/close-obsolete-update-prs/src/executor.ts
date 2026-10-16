/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { GitHubClient } from "./github-client.ts";
import type { PRVerdict } from "./types.ts";

export const SUPERSEDED_LABEL = "superseded";
export const SUPERSEDED_LABEL_COLOR = "6f42c1";
export const SUPERSEDED_LABEL_DESC = "PR is superseded by newer upstream versions or releases";

export class ActionExecutor {
  private readonly githubClient: GitHubClient;

  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }

  formatComment(verdict: PRVerdict): string {
    const tableRows = verdict.comparisons
      .map((c) => {
        const status = c.isObsolete ? "Superseded" : "Current";
        const note = c.details ?? c.source;
        return `| \`${c.packageName}\` | \`${c.prVersion}\` | \`${c.latestVersion}\` | ${status} | ${note} |`;
      })
      .join("\n");

    const workspaceLine = verdict.workspaceName
      ? `\n**Workspace:** \`${verdict.workspaceName}\`\n`
      : "";

    return `### Obsolete Plugin Update Pull Request

This automated pull request is obsolete and has been superseded by newer releases upstream:
${workspaceLine}
| Package | Requested in PR | Latest Available | Status | Note |
|---|---|---|---|---|
${tableRows}

**Action:** Closing this pull request to conserve CI compute and runner resources. A fresh update PR will be opened automatically by workflow automation if an update is needed.

*Automated by [close-obsolete-update-prs](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/main/.github/workflows/close-obsolete-update-prs.yaml).*`;
  }

  async execute(
    owner: string,
    repo: string,
    verdict: PRVerdict,
    dryRun: boolean,
  ): Promise<PRVerdict> {
    if (!verdict.isObsolete) {
      return {
        ...verdict,
        actionTaken: "skipped",
      };
    }

    const comment = this.formatComment(verdict);

    if (dryRun) {
      return {
        ...verdict,
        actionTaken: "dry-run-preview",
        commentBody: comment,
      };
    }

    // Live execution
    // 1. Ensure 'superseded' label exists
    await this.githubClient.ensureLabel(
      owner,
      repo,
      SUPERSEDED_LABEL,
      SUPERSEDED_LABEL_COLOR,
      SUPERSEDED_LABEL_DESC,
    );

    // 2. Add label to PR
    await this.githubClient.addLabels(owner, repo, verdict.pr.number, [SUPERSEDED_LABEL]);

    // 3. Post comment
    await this.githubClient.addComment(owner, repo, verdict.pr.number, comment);

    // 4. Close PR
    await this.githubClient.closePR(owner, repo, verdict.pr.number);

    return {
      ...verdict,
      actionTaken: "closed",
      commentBody: comment,
    };
  }
}
