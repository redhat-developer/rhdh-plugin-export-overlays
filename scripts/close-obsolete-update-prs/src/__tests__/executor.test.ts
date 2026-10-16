/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { ActionExecutor, SUPERSEDED_LABEL } from "../executor.ts";
import { GitHubClient } from "../github-client.ts";
import type { PRVerdict, PullRequestSummary } from "../types.ts";

class MockGitHubClient extends GitHubClient {
  readonly ensureLabelMock = vi.fn(async (..._args: unknown[]) => {});
  readonly addLabelsMock = vi.fn(async (..._args: unknown[]) => {});
  readonly addCommentMock = vi.fn(async (..._args: unknown[]) => {});
  readonly closePRMock = vi.fn(async (..._args: unknown[]) => {});

  override async ensureLabel(
    owner: string,
    repo: string,
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    await this.ensureLabelMock(owner, repo, name, color, description);
  }

  override async addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    await this.addLabelsMock(owner, repo, issueNumber, labels);
  }

  override async addComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void> {
    await this.addCommentMock(owner, repo, issueNumber, body);
  }

  override async closePR(owner: string, repo: string, pullNumber: number): Promise<void> {
    await this.closePRMock(owner, repo, pullNumber);
  }
}

describe("ActionExecutor", () => {
  const basePr: PullRequestSummary = {
    number: 2525,
    title: "fix(homepage): update homepage frontend and backend",
    headRef: "homepage/update-main",
    baseRef: "main",
    labels: ["workspace-update"],
    author: "app/github-actions",
    htmlUrl: "https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/2525",
    createdAt: "2026-07-15T12:00:00Z",
  };

  const obsoleteVerdict: PRVerdict = {
    pr: basePr,
    workspaceName: "homepage",
    isCandidate: true,
    isObsolete: true,
    reason: "Superseded by newer upstream release",
    comparisons: [
      {
        packageName: "@red-hat-developer-hub/backstage-plugin-homepage",
        prVersion: "1.13.4",
        latestVersion: "3.1.0",
        source: "npm",
        isObsolete: true,
        details: "NPM registry has 3.1.0",
      },
    ],
  };

  it("formats explanatory markdown comment with details table", () => {
    const client = new MockGitHubClient();
    const executor = new ActionExecutor(client);

    const comment = executor.formatComment(obsoleteVerdict);
    expect(comment).toContain("### Obsolete Plugin Update Pull Request");
    expect(comment).toContain("@red-hat-developer-hub/backstage-plugin-homepage");
    expect(comment).toContain("1.13.4");
    expect(comment).toContain("3.1.0");
    expect(comment).toContain(
      "Closing this pull request to conserve CI compute and runner resources",
    );
  });

  it("previews closure on dry-run without performing mutations", async () => {
    const client = new MockGitHubClient();
    const executor = new ActionExecutor(client);

    const res = await executor.execute(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      obsoleteVerdict,
      true, // dryRun
    );

    expect(res.actionTaken).toBe("dry-run-preview");
    expect(res.commentBody).toBeDefined();
    expect(client.ensureLabelMock).not.toHaveBeenCalled();
    expect(client.addLabelsMock).not.toHaveBeenCalled();
    expect(client.addCommentMock).not.toHaveBeenCalled();
    expect(client.closePRMock).not.toHaveBeenCalled();
  });

  it("performs live closure, comment, and labeling when dryRun is false", async () => {
    const client = new MockGitHubClient();
    const executor = new ActionExecutor(client);

    const res = await executor.execute(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      obsoleteVerdict,
      false, // live
    );

    expect(res.actionTaken).toBe("closed");
    expect(client.ensureLabelMock).toHaveBeenCalledWith(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      SUPERSEDED_LABEL,
      expect.any(String),
      expect.any(String),
    );
    expect(client.addLabelsMock).toHaveBeenCalledWith(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      2525,
      [SUPERSEDED_LABEL],
    );
    expect(client.addCommentMock).toHaveBeenCalledWith(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      2525,
      expect.stringContaining("Obsolete Plugin Update Pull Request"),
    );
    expect(client.closePRMock).toHaveBeenCalledWith(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      2525,
    );
  });

  it("skips non-obsolete PR without mutations", async () => {
    const client = new MockGitHubClient();
    const executor = new ActionExecutor(client);

    const nonObsoleteVerdict: PRVerdict = {
      pr: basePr,
      workspaceName: "homepage",
      isCandidate: true,
      isObsolete: false,
      comparisons: [],
    };

    const res = await executor.execute(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      nonObsoleteVerdict,
      false,
    );

    expect(res.actionTaken).toBe("skipped");
    expect(client.closePRMock).not.toHaveBeenCalled();
  });
});
