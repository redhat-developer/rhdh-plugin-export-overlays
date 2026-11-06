/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

export interface PullRequestSummary {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  headRepo?: string;
  baseRef: string;
  labels: string[];
  author: string;
  htmlUrl: string;
  createdAt: string;
}

export interface SourceJson {
  repo: string;
  "repo-ref": string;
  "repo-flat"?: boolean;
  "repo-backstage-version"?: string;
  [key: string]: unknown;
}

export interface WorkspaceSourceInfo {
  workspaceName: string;
  canonicalWorkspaceName: string;
  prSourceJson?: SourceJson;
  mainSourceJson?: SourceJson;
}

export interface WorkspaceAnalysisResult {
  isCandidate: boolean;
  skipReason?: string;
  workspaceName?: string;
  canonicalWorkspaceName?: string;
  workspaces: WorkspaceSourceInfo[];
  prSourceJson?: SourceJson;
  mainSourceJson?: SourceJson;
  prPackages: PackageVersion[];
  mainPackages: PackageVersion[];
}

export interface PackageVersion {
  packageName: string;
  version: string;
  metadataFile?: string;
}

export interface PackageComparison {
  packageName: string;
  prVersion: string;
  latestVersion: string;
  source: "overlays-main" | "npm" | "upstream-repo";
  isRenamed?: boolean;
  renamedTo?: string;
  isObsolete: boolean;
  details?: string;
}

export interface PRVerdict {
  pr: PullRequestSummary;
  workspaceName?: string;
  isCandidate: boolean;
  skipReason?: string;
  isObsolete: boolean;
  reason?: string;
  comparisons: PackageComparison[];
  actionTaken?: "closed" | "dry-run-preview" | "skipped";
  commentBody?: string;
}

export interface DetectorOptions {
  repo: string;
  baseBranch: string;
  prNumber?: number;
  dryRun: boolean;
  token?: string;
  npmRegistry: string;
  verbose: boolean;
}
