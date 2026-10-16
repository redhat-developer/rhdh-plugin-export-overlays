/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vite-plus/test";
import { GitHubClient } from "../github-client.ts";
import type { PullRequestSummary } from "../types.ts";
import { WorkspaceAnalyzer } from "../workspace-analyzer.ts";

class MockGitHubClientForAnalyzer extends GitHubClient {
  private readonly filesContent: Record<string, string>;

  constructor(filesContent: Record<string, string> = {}) {
    super();
    this.filesContent = filesContent;
  }

  override async getFileContent(
    _owner: string,
    _repo: string,
    path: string,
    _ref: string,
  ): Promise<string | null> {
    return this.filesContent[path] ?? null;
  }
}

describe("WorkspaceAnalyzer", () => {
  const basePr: PullRequestSummary = {
    number: 123,
    title: "Update `homepage` workspace to commit `abc` on branch `main`",
    headRef: "workspaces/main__homepage",
    headSha: "headsha123",
    baseRef: "main",
    labels: ["workspace-update"],
    author: "app/github-actions",
    htmlUrl: "https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/123",
    createdAt: "2026-10-16T12:00:00Z",
  };

  it("rejects PR targeting non-main branch", async () => {
    const client = new MockGitHubClientForAnalyzer();
    const analyzer = new WorkspaceAnalyzer(client);

    const pr = { ...basePr, baseRef: "release-2.1" };
    const res = await analyzer.analyzePR("redhat-developer", "rhdh-plugin-export-overlays", pr, [
      "workspaces/homepage/source.json",
    ]);

    expect(res.isCandidate).toBe(false);
    expect(res.skipReason).toContain("PR targets 'release-2.1'");
  });

  it("rejects PR that modifies versions.json (framework dependency)", async () => {
    const client = new MockGitHubClientForAnalyzer();
    const analyzer = new WorkspaceAnalyzer(client);

    const res = await analyzer.analyzePR(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      basePr,
      ["versions.json", "workspaces/homepage/source.json"],
    );

    expect(res.isCandidate).toBe(false);
    expect(res.skipReason).toContain("PR modifies framework or workflow files");
  });

  it("rejects PR that does not touch any source.json", async () => {
    const client = new MockGitHubClientForAnalyzer();
    const analyzer = new WorkspaceAnalyzer(client);

    const res = await analyzer.analyzePR(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      basePr,
      ["workspaces/homepage/README.md"],
    );

    expect(res.isCandidate).toBe(false);
    expect(res.skipReason).toContain("does not modify any workspaces/*/source.json");
  });

  it("parses workspace source.json and metadata for a valid candidate", async () => {
    const filesContent: Record<string, string> = {
      "workspaces/homepage/source.json": JSON.stringify({
        repo: "https://github.com/redhat-developer/rhdh-plugins",
        "repo-ref": "b2110290c8af66dece1dd421f3c34956ba81779d",
        "repo-flat": false,
        "repo-backstage-version": "1.49.3",
      }),
      "workspaces/homepage/metadata/red-hat-developer-hub-backstage-plugin-homepage.yaml": `
apiVersion: extensions.backstage.io/v1alpha1
kind: Package
metadata:
  name: red-hat-developer-hub-backstage-plugin-homepage
spec:
  packageName: '@red-hat-developer-hub/backstage-plugin-homepage'
  version: 1.13.4
`,
    };

    const client = new MockGitHubClientForAnalyzer(filesContent);
    const analyzer = new WorkspaceAnalyzer(client);

    const changedFiles = [
      "workspaces/homepage/source.json",
      "workspaces/homepage/metadata/red-hat-developer-hub-backstage-plugin-homepage.yaml",
    ];

    const res = await analyzer.analyzePR(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      basePr,
      changedFiles,
    );

    expect(res.isCandidate).toBe(true);
    expect(res.workspaceName).toBe("homepage");
    expect(res.canonicalWorkspaceName).toBe("homepage");
    expect(res.prSourceJson?.["repo-ref"]).toBe("b2110290c8af66dece1dd421f3c34956ba81779d");
    expect(res.prPackages).toHaveLength(1);
    expect(res.prPackages[0]?.packageName).toBe("@red-hat-developer-hub/backstage-plugin-homepage");
    expect(res.prPackages[0]?.version).toBe("1.13.4");
  });

  it("resolves historical workspace rename (marketplace -> extensions)", async () => {
    const client = new MockGitHubClientForAnalyzer({
      "workspaces/marketplace/source.json": JSON.stringify({
        repo: "https://github.com/redhat-developer/rhdh-plugins",
        "repo-ref": "oldref123",
      }),
    });
    const analyzer = new WorkspaceAnalyzer(client);

    const res = await analyzer.analyzePR(
      "redhat-developer",
      "rhdh-plugin-export-overlays",
      basePr,
      ["workspaces/marketplace/source.json"],
    );

    expect(res.isCandidate).toBe(true);
    expect(res.workspaceName).toBe("marketplace");
    expect(res.canonicalWorkspaceName).toBe("extensions");
  });

  it("parses valid Package metadata and ignores non-Package docs", () => {
    const client = new MockGitHubClientForAnalyzer();
    const analyzer = new WorkspaceAnalyzer(client);

    const validPackage = `
apiVersion: extensions.backstage.io/v1alpha1
kind: Package
metadata:
  name: test-pkg
spec:
  packageName: '@scope/plugin-test'
  version: 2.1.0
`;
    expect(analyzer.parsePackageMetadata(validPackage)).toEqual({
      packageName: "@scope/plugin-test",
      version: "2.1.0",
    });

    const pluginKind = `
apiVersion: extensions.backstage.io/v1alpha1
kind: Plugin
metadata:
  name: test-plugin
`;
    expect(analyzer.parsePackageMetadata(pluginKind)).toBeNull();

    expect(analyzer.parsePackageMetadata("not: yaml: [")).toBeNull();
  });
});
