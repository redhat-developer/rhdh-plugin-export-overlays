/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { GitHubClient } from "./github-client.ts";
import type { NpmClient } from "./npm-client.ts";
import { resolveCurrentPackageName } from "./renames.ts";
import { cleanVersion, isNewerVersion } from "./semver-compare.ts";
import type { PackageComparison, PRVerdict, PullRequestSummary } from "./types.ts";
import type { WorkspaceAnalysisResult } from "./workspace-analyzer.ts";

export class ObsoleteDetector {
  private readonly npmClient: NpmClient;
  private readonly githubClient: GitHubClient;

  constructor(npmClient: NpmClient, githubClient: GitHubClient) {
    this.npmClient = npmClient;
    this.githubClient = githubClient;
  }

  async evaluatePR(pr: PullRequestSummary, analysis: WorkspaceAnalysisResult): Promise<PRVerdict> {
    if (!analysis.isCandidate) {
      return {
        pr,
        workspaceName: analysis.workspaceName,
        isCandidate: false,
        skipReason: analysis.skipReason,
        isObsolete: false,
        comparisons: [],
      };
    }

    const comparisons: PackageComparison[] = [];

    // 1. Evaluate packages in metadata
    if (analysis.prPackages.length > 0) {
      for (const prPkg of analysis.prPackages) {
        const canonicalName = resolveCurrentPackageName(prPkg.packageName);
        let upstreamVersion: string | undefined;
        let source: PackageComparison["source"] = "overlays-main";
        let details: string | undefined;

        // A. Check against main branch in overlays
        const mainPkg = analysis.mainPackages.find(
          (p) => p.packageName === prPkg.packageName || p.packageName === canonicalName,
        );

        if (mainPkg) {
          upstreamVersion = mainPkg.version;
          source = "overlays-main";
          details = `Target branch 'main' has version ${mainPkg.version}`;
        }

        // B. Check against NPM registry
        const npmVersion = await this.npmClient.getLatestVersion(canonicalName);
        if (npmVersion) {
          if (!upstreamVersion || isNewerVersion(npmVersion, upstreamVersion)) {
            upstreamVersion = npmVersion;
            source = "npm";
            details = `NPM registry has released version ${npmVersion}`;
          }
        }

        const latestVersion = upstreamVersion ?? prPkg.version;
        const isPackageObsolete = isNewerVersion(latestVersion, prPkg.version);

        // C. If package was renamed, note that in details
        if (canonicalName !== prPkg.packageName) {
          source = "renamed";
          details = details
            ? `${details} (package renamed to ${canonicalName})`
            : `Package renamed to ${canonicalName}`;
        }

        comparisons.push({
          packageName: prPkg.packageName,
          prVersion: prPkg.version,
          latestVersion,
          source,
          isObsolete: isPackageObsolete,
          details,
        });
      }
    } else if (analysis.prSourceJson && analysis.mainSourceJson) {
      // 2. If no metadata files were modified, check source.json repo-ref if it's a version tag
      const prRef = analysis.prSourceJson["repo-ref"];
      const mainRef = analysis.mainSourceJson["repo-ref"];

      const prClean = cleanVersion(prRef);
      const mainClean = cleanVersion(mainRef);

      if (prClean && mainClean && isNewerVersion(mainClean, prClean)) {
        comparisons.push({
          packageName: `${analysis.workspaceName} (repo-ref)`,
          prVersion: prRef,
          latestVersion: mainRef,
          source: "overlays-main",
          isObsolete: true,
          details: `source.json repo-ref on 'main' (${mainRef}) is newer than PR (${prRef})`,
        });
      }
    }

    // Determine overall verdict
    // Obsolete if:
    // - At least one package/ref is strictly older than latest
    // - AND no package in the PR is newer than latest
    const hasOlder = comparisons.some((c) => isNewerVersion(c.latestVersion, c.prVersion));
    const hasNewer = comparisons.some((c) => isNewerVersion(c.prVersion, c.latestVersion));
    const isObsolete = hasOlder && !hasNewer;

    let reason: string | undefined;
    if (isObsolete) {
      const obsoletePkgs = comparisons
        .filter((c) => isNewerVersion(c.latestVersion, c.prVersion))
        .map(
          (c) =>
            `${c.packageName} (requested: ${c.prVersion}, latest: ${c.latestVersion} [${c.source}])`,
        )
        .join(", ");
      reason = `Superseded by newer upstream release(s): ${obsoletePkgs}`;
    }

    return {
      pr,
      workspaceName: analysis.workspaceName,
      isCandidate: true,
      isObsolete,
      reason,
      comparisons,
    };
  }
}
