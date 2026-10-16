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

interface WorkspaceFetchContext {
  owner: string;
  repo: string;
  prOwner: string;
  prRepoName: string;
  headSha: string;
  baseRef: string;
}

const SOURCE_JSON_PATTERN = /^workspaces\/([^/]+)\/source\.json$/;

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
    const candidateCheck = this.checkCandidatePr(pr, files, baseRef);
    if (!candidateCheck.isCandidate) {
      return {
        isCandidate: false,
        skipReason: candidateCheck.skipReason,
        prPackages: [],
        mainPackages: [],
      };
    }

    const affectedWorkspaces = this.findAffectedWorkspaces(files);
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

    const ctx: WorkspaceFetchContext = {
      owner,
      repo,
      prOwner,
      prRepoName,
      headSha: pr.headSha,
      baseRef,
    };

    const prPackages: PackageVersion[] = [];
    const mainPackages: PackageVersion[] = [];
    let prSourceJson: SourceJson | undefined;
    let mainSourceJson: SourceJson | undefined;

    const workspaceData = await Promise.all(
      affectedWorkspaces.map((rawWorkspace) => this.fetchWorkspaceData(ctx, rawWorkspace, files)),
    );

    for (const data of workspaceData) {
      if (data.prSourceJson) prSourceJson = data.prSourceJson;
      if (data.mainSourceJson) mainSourceJson = data.mainSourceJson;
      prPackages.push(...data.prPackages);
      mainPackages.push(...data.mainPackages);
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

  private checkCandidatePr(
    pr: PullRequestSummary,
    files: string[],
    baseRef: string,
  ): { isCandidate: boolean; skipReason?: string } {
    if (pr.baseRef !== baseRef) {
      return {
        isCandidate: false,
        skipReason: `PR targets '${pr.baseRef}', not '${baseRef}'`,
      };
    }

    const touchesFrameworkFiles = files.some(
      (f) => f === "versions.json" || f.startsWith(".github/workflows/"),
    );
    if (touchesFrameworkFiles) {
      return {
        isCandidate: false,
        skipReason:
          "PR modifies framework or workflow files (not purely automated workspace update)",
      };
    }

    return { isCandidate: true };
  }

  private findAffectedWorkspaces(files: string[]): string[] {
    const matched = new Set<string>();
    for (const file of files) {
      const match = SOURCE_JSON_PATTERN.exec(file);
      if (match?.[1]) {
        matched.add(match[1]);
      }
    }
    return [...matched];
  }

  private async fetchWorkspaceData(
    ctx: WorkspaceFetchContext,
    rawWorkspace: string,
    files: string[],
  ): Promise<{
    prSourceJson?: SourceJson;
    mainSourceJson?: SourceJson;
    prPackages: PackageVersion[];
    mainPackages: PackageVersion[];
  }> {
    const canonicalWorkspace = resolveCurrentWorkspaceName(rawWorkspace);

    const [prSourceJson, mainSourceJson] = await Promise.all([
      this.fetchSourceJson(
        ctx.prOwner,
        ctx.prRepoName,
        `workspaces/${rawWorkspace}/source.json`,
        ctx.headSha,
      ),
      this.fetchSourceJson(
        ctx.owner,
        ctx.repo,
        `workspaces/${canonicalWorkspace}/source.json`,
        ctx.baseRef,
      ),
    ]);

    const metadataFiles = files.filter(
      (f) =>
        f.startsWith(`workspaces/${rawWorkspace}/metadata/`) &&
        (f.endsWith(".yaml") || f.endsWith(".yml")),
    );

    const prPackages = await this.fetchPackages(
      ctx.prOwner,
      ctx.prRepoName,
      ctx.headSha,
      metadataFiles,
    );

    const mainMetadataFiles = metadataFiles.map((f) =>
      f.replace(`workspaces/${rawWorkspace}/`, `workspaces/${canonicalWorkspace}/`),
    );
    const mainPackages = await this.fetchPackages(
      ctx.owner,
      ctx.repo,
      ctx.baseRef,
      mainMetadataFiles,
    );

    return { prSourceJson, mainSourceJson, prPackages, mainPackages };
  }

  private async fetchSourceJson(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<SourceJson | undefined> {
    const content = await this.githubClient.getFileContent(owner, repo, path, ref);
    if (!content) return undefined;

    try {
      const parsed: unknown = JSON.parse(content);
      if (
        isPlainObject(parsed) &&
        typeof parsed["repo"] === "string" &&
        typeof parsed["repo-ref"] === "string"
      ) {
        return {
          repo: parsed["repo"],
          "repo-ref": parsed["repo-ref"],
          "repo-flat": typeof parsed["repo-flat"] === "boolean" ? parsed["repo-flat"] : undefined,
          "repo-backstage-version":
            typeof parsed["repo-backstage-version"] === "string"
              ? parsed["repo-backstage-version"]
              : undefined,
        };
      }
    } catch {
      // malformed json
    }
    return undefined;
  }

  private async fetchPackages(
    owner: string,
    repo: string,
    ref: string,
    files: string[],
  ): Promise<PackageVersion[]> {
    const packages: PackageVersion[] = [];
    const contents = await Promise.all(
      files.map((file) => this.githubClient.getFileContent(owner, repo, file, ref)),
    );

    for (let i = 0; i < files.length; i++) {
      const content = contents[i];
      const file = files[i];
      if (content && file) {
        const parsed = this.parsePackageMetadata(content);
        if (parsed) {
          parsed.metadataFile = file;
          packages.push(parsed);
        }
      }
    }

    return packages;
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
