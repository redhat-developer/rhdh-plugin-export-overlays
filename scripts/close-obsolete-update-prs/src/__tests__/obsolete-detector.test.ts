/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vite-plus/test";
import { GitHubClient } from "../github-client.ts";
import { NpmClient } from "../npm-client.ts";
import { ObsoleteDetector } from "../obsolete-detector.ts";
import type { PullRequestSummary } from "../types.ts";
import type { WorkspaceAnalysisResult } from "../workspace-analyzer.ts";

class MockNpmClient extends NpmClient {
  private readonly mockPackages: Record<string, string | null>;

  constructor(mockPackages: Record<string, string | null> = {}) {
    super();
    this.mockPackages = mockPackages;
  }

  override async getLatestVersion(packageName: string): Promise<string | null> {
    return this.mockPackages[packageName] ?? null;
  }
}

class MockGitHubClient extends GitHubClient {}

describe("ObsoleteDetector", () => {
  const basePr: PullRequestSummary = {
    number: 4420,
    title: "Update `homepage` workspace to commit `123` for backstage `1.54.6` on branch `main`",
    headRef: "workspaces/main__homepage",
    baseRef: "main",
    labels: ["workspace-update"],
    author: "app/github-actions",
    htmlUrl: "https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/4420",
    createdAt: "2026-10-15T12:00:00Z",
  };

  it("marks PR obsolete when overlays main has a newer package version", async () => {
    const npmClient = new MockNpmClient();
    const githubClient = new MockGitHubClient();
    const detector = new ObsoleteDetector(npmClient, githubClient);

    const analysis: WorkspaceAnalysisResult = {
      isCandidate: true,
      workspaceName: "homepage",
      canonicalWorkspaceName: "homepage",
      prPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-homepage",
          version: "1.13.4",
        },
      ],
      mainPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-homepage",
          version: "3.1.0",
        },
      ],
    };

    const verdict = await detector.evaluatePR(basePr, analysis);

    expect(verdict.isCandidate).toBe(true);
    expect(verdict.isObsolete).toBe(true);
    expect(verdict.reason).toContain("Superseded by newer upstream release(s)");
    expect(verdict.comparisons[0]?.isObsolete).toBe(true);
    expect(verdict.comparisons[0]?.latestVersion).toBe("3.1.0");
  });

  it("marks PR obsolete when NPM registry has a newer version", async () => {
    const npmClient = new MockNpmClient({
      "@red-hat-developer-hub/backstage-plugin-homepage": "3.1.0",
    });
    const githubClient = new MockGitHubClient();
    const detector = new ObsoleteDetector(npmClient, githubClient);

    const analysis: WorkspaceAnalysisResult = {
      isCandidate: true,
      workspaceName: "homepage",
      canonicalWorkspaceName: "homepage",
      prPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-homepage",
          version: "1.13.4",
        },
      ],
      mainPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-homepage",
          version: "1.13.4",
        },
      ],
    };

    const verdict = await detector.evaluatePR(basePr, analysis);

    expect(verdict.isObsolete).toBe(true);
    expect(verdict.comparisons[0]?.source).toBe("npm");
    expect(verdict.comparisons[0]?.latestVersion).toBe("3.1.0");
  });

  it("accounts for renamed package (dynamic-home-page -> homepage)", async () => {
    const npmClient = new MockNpmClient({
      "@red-hat-developer-hub/backstage-plugin-homepage": "3.1.0",
    });
    const githubClient = new MockGitHubClient();
    const detector = new ObsoleteDetector(npmClient, githubClient);

    const analysis: WorkspaceAnalysisResult = {
      isCandidate: true,
      workspaceName: "homepage",
      canonicalWorkspaceName: "homepage",
      prPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-dynamic-home-page",
          version: "1.13.4",
        },
      ],
      mainPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-homepage",
          version: "3.1.0",
        },
      ],
    };

    const verdict = await detector.evaluatePR(basePr, analysis);

    expect(verdict.isObsolete).toBe(true);
    expect(verdict.comparisons[0]?.source).toBe("renamed");
    expect(verdict.comparisons[0]?.latestVersion).toBe("3.1.0");
    expect(verdict.comparisons[0]?.details).toContain(
      "renamed to @red-hat-developer-hub/backstage-plugin-homepage",
    );
  });

  it("leaves PR open when requested version is equal to upstream", async () => {
    const npmClient = new MockNpmClient({
      "@red-hat-developer-hub/backstage-plugin-x2a": "2.0.2",
    });
    const githubClient = new MockGitHubClient();
    const detector = new ObsoleteDetector(npmClient, githubClient);

    const analysis: WorkspaceAnalysisResult = {
      isCandidate: true,
      workspaceName: "x2a",
      canonicalWorkspaceName: "x2a",
      prPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-x2a",
          version: "2.0.2",
        },
      ],
      mainPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-x2a",
          version: "2.0.0",
        },
      ],
    };

    const verdict = await detector.evaluatePR(basePr, analysis);

    expect(verdict.isObsolete).toBe(false);
  });

  it("leaves PR open when requested version is newer than upstream", async () => {
    const npmClient = new MockNpmClient({
      "@red-hat-developer-hub/backstage-plugin-x2a": "2.0.0",
    });
    const githubClient = new MockGitHubClient();
    const detector = new ObsoleteDetector(npmClient, githubClient);

    const analysis: WorkspaceAnalysisResult = {
      isCandidate: true,
      workspaceName: "x2a",
      canonicalWorkspaceName: "x2a",
      prPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-x2a",
          version: "2.0.2",
        },
      ],
      mainPackages: [
        {
          packageName: "@red-hat-developer-hub/backstage-plugin-x2a",
          version: "2.0.0",
        },
      ],
    };

    const verdict = await detector.evaluatePR(basePr, analysis);

    expect(verdict.isObsolete).toBe(false);
  });

  it("handles multi-package workspaces correctly", async () => {
    const npmClient = new MockNpmClient({
      "@scope/pkg-a": "1.2.0",
      "@scope/pkg-b": "1.0.0",
    });
    const githubClient = new MockGitHubClient();
    const detector = new ObsoleteDetector(npmClient, githubClient);

    // Multi-package: pkg-a is older in PR (1.1.0 vs 1.2.0), pkg-b is equal (1.0.0 vs 1.0.0)
    // -> PR should be obsolete
    const analysis: WorkspaceAnalysisResult = {
      isCandidate: true,
      workspaceName: "multi",
      canonicalWorkspaceName: "multi",
      prPackages: [
        { packageName: "@scope/pkg-a", version: "1.1.0" },
        { packageName: "@scope/pkg-b", version: "1.0.0" },
      ],
      mainPackages: [
        { packageName: "@scope/pkg-a", version: "1.2.0" },
        { packageName: "@scope/pkg-b", version: "1.0.0" },
      ],
    };

    const verdict = await detector.evaluatePR(basePr, analysis);
    expect(verdict.isObsolete).toBe(true);

    // If one package in PR is newer than upstream, PR should NOT be obsolete
    const analysisWithNewer: WorkspaceAnalysisResult = {
      isCandidate: true,
      workspaceName: "multi",
      canonicalWorkspaceName: "multi",
      prPackages: [
        { packageName: "@scope/pkg-a", version: "1.3.0" }, // newer than 1.2.0
        { packageName: "@scope/pkg-b", version: "0.9.0" },
      ],
      mainPackages: [
        { packageName: "@scope/pkg-a", version: "1.2.0" },
        { packageName: "@scope/pkg-b", version: "1.0.0" },
      ],
    };

    const verdictWithNewer = await detector.evaluatePR(basePr, analysisWithNewer);
    expect(verdictWithNewer.isObsolete).toBe(false);
  });

  it("detects obsolete PR via source.json repo-ref tag when no metadata files changed", async () => {
    const npmClient = new MockNpmClient();
    const githubClient = new MockGitHubClient();
    const detector = new ObsoleteDetector(npmClient, githubClient);

    const analysis: WorkspaceAnalysisResult = {
      isCandidate: true,
      workspaceName: "backstage",
      canonicalWorkspaceName: "backstage",
      prSourceJson: {
        repo: "https://github.com/backstage/backstage",
        "repo-ref": "v1.54.6",
      },
      mainSourceJson: {
        repo: "https://github.com/backstage/backstage",
        "repo-ref": "v1.54.9",
      },
      prPackages: [],
      mainPackages: [],
    };

    const verdict = await detector.evaluatePR(basePr, analysis);
    expect(verdict.isObsolete).toBe(true);
    expect(verdict.comparisons[0]?.latestVersion).toBe("v1.54.9");
  });
});
