/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { parse as parseYaml } from "yaml";
import type { GitHubClient } from "./github-client.ts";
import { isPlainObject } from "./helpers.ts";
import { resolveCurrentWorkspaceName } from "./renames.ts";
import type { PackageVersion, PullRequestSummary, SourceJson } from "./types.ts";

export interface WorkspaceAnalysisResult {
  isCandidate: boolean;
  skipReason?: string;
  workspaceName?: string;
  canonicalWorkspaceName?: string;
  prSourceJson?: SourceJson;
  mainSourceJson?: SourceJson;
  prPackages: PackageVersion[];
  mainPackages: PackageVersion[];
}

export class WorkspaceAnalyzer {
  private readonly githubClient: GitHubClient;

  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
  }

  async analyzePR(
    owner: string,
    repo: string,
    pr: PullRequestSummary,
    files: string[],
    baseRef: string = "main",
  ): Promise<WorkspaceAnalysisResult> {
    // 1. Must target baseRef
    if (pr.baseRef !== baseRef) {
      return {
        isCandidate: false,
        skipReason: `PR targets '${pr.baseRef}', not '${baseRef}'`,
        prPackages: [],
        mainPackages: [],
      };
    }

    // 2. Check for manual framework changes (e.g. versions.json, workflow files)
    const touchesFrameworkFiles = files.some(
      (f) => f === "versions.json" || f.startsWith(".github/workflows/"),
    );
    if (touchesFrameworkFiles) {
      return {
        isCandidate: false,
        skipReason:
          "PR modifies framework or workflow files (not purely automated workspace update)",
        prPackages: [],
        mainPackages: [],
      };
    }

    // 3. Find modified workspaces/*/source.json
    const affectedWorkspaces = [
      ...new Set(
        files
          .map((f) => f.match(/^workspaces\/([^/]+)\/source\.json$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => m[1]!),
      ),
    ];

    if (affectedWorkspaces.length === 0) {
      return {
        isCandidate: false,
        skipReason: "PR does not modify any workspaces/*/source.json",
        prPackages: [],
        mainPackages: [],
      };
    }

    const prRepo = pr.headRepo || `${owner}/${repo}`;
    const [prOwner, prRepoName] = prRepo.split("/");
    if (!prOwner || !prRepoName) {
      return {
        isCandidate: false,
        skipReason: `Could not parse head repo '${prRepo}'`,
        prPackages: [],
        mainPackages: [],
      };
    }

    const prPackages: PackageVersion[] = [];
    const mainPackages: PackageVersion[] = [];
    let prSourceJson: SourceJson | undefined;
    let mainSourceJson: SourceJson | undefined;

    for (const rawWorkspace of affectedWorkspaces) {
      const canonicalWorkspace = resolveCurrentWorkspaceName(rawWorkspace);

      // Read PR source.json from PR head
      const prSourceJsonContent = await this.githubClient.getFileContent(
        prOwner,
        prRepoName,
        `workspaces/${rawWorkspace}/source.json`,
        pr.headRef,
      );

      if (prSourceJsonContent) {
        try {
          const parsed: unknown = JSON.parse(prSourceJsonContent);
          if (
            isPlainObject(parsed) &&
            typeof parsed["repo"] === "string" &&
            typeof parsed["repo-ref"] === "string"
          ) {
            prSourceJson = {
              repo: parsed["repo"],
              "repo-ref": parsed["repo-ref"],
              "repo-flat":
                typeof parsed["repo-flat"] === "boolean" ? parsed["repo-flat"] : undefined,
              "repo-backstage-version":
                typeof parsed["repo-backstage-version"] === "string"
                  ? parsed["repo-backstage-version"]
                  : undefined,
            };
          }
        } catch {
          // malformed json
        }
      }

      // Read main source.json from base branch
      const mainSourceJsonContent = await this.githubClient.getFileContent(
        owner,
        repo,
        `workspaces/${canonicalWorkspace}/source.json`,
        baseRef,
      );

      if (mainSourceJsonContent) {
        try {
          const parsed: unknown = JSON.parse(mainSourceJsonContent);
          if (
            isPlainObject(parsed) &&
            typeof parsed["repo"] === "string" &&
            typeof parsed["repo-ref"] === "string"
          ) {
            mainSourceJson = {
              repo: parsed["repo"],
              "repo-ref": parsed["repo-ref"],
              "repo-flat":
                typeof parsed["repo-flat"] === "boolean" ? parsed["repo-flat"] : undefined,
              "repo-backstage-version":
                typeof parsed["repo-backstage-version"] === "string"
                  ? parsed["repo-backstage-version"]
                  : undefined,
            };
          }
        } catch {
          // malformed json
        }
      }

      // Extract package versions in PR from metadata files modified in PR
      const metadataFiles = files.filter(
        (f) =>
          f.startsWith(`workspaces/${rawWorkspace}/metadata/`) &&
          (f.endsWith(".yaml") || f.endsWith(".yml")),
      );

      for (const file of metadataFiles) {
        const content = await this.githubClient.getFileContent(
          prOwner,
          prRepoName,
          file,
          pr.headRef,
        );
        if (!content) continue;
        const parsed = this.parsePackageMetadata(content);
        if (parsed) {
          parsed.metadataFile = file;
          prPackages.push(parsed);
        }
      }

      // Extract package versions on main
      for (const file of metadataFiles) {
        const mainPath = file.replace(
          `workspaces/${rawWorkspace}/`,
          `workspaces/${canonicalWorkspace}/`,
        );
        const content = await this.githubClient.getFileContent(owner, repo, mainPath, baseRef);
        if (!content) continue;
        const parsed = this.parsePackageMetadata(content);
        if (parsed) {
          parsed.metadataFile = mainPath;
          mainPackages.push(parsed);
        }
      }
    }

    return {
      isCandidate: true,
      workspaceName: affectedWorkspaces.join(", "),
      canonicalWorkspaceName: affectedWorkspaces.map(resolveCurrentWorkspaceName).join(", "),
      prSourceJson,
      mainSourceJson,
      prPackages,
      mainPackages,
    };
  }

  parsePackageMetadata(content: string): PackageVersion | null {
    try {
      const doc: unknown = parseYaml(content);
      if (!isPlainObject(doc) || doc["kind"] !== "Package") {
        return null;
      }
      const spec = isPlainObject(doc["spec"]) ? doc["spec"] : undefined;
      if (!spec || typeof spec["packageName"] !== "string" || spec["version"] === undefined) {
        return null;
      }

      const rawVersion = spec["version"];
      const versionStr =
        typeof rawVersion === "string" || typeof rawVersion === "number"
          ? String(rawVersion).trim()
          : "";
      if (!versionStr) {
        return null;
      }

      return {
        packageName: spec["packageName"].trim(),
        version: versionStr,
      };
    } catch {
      return null;
    }
  }
}
