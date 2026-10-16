/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { NpmClient } from "./npm-client.ts";
import { resolveCurrentPackageName } from "./renames.ts";
import { cleanVersion, isNewerVersion } from "./semver-compare.ts";
import type { PackageComparison, PackageVersion, PRVerdict, PullRequestSummary } from "./types.ts";
import type { WorkspaceAnalysisResult } from "./workspace-analyzer.ts";

export class ObsoleteDetector {
  private readonly npmClient: NpmClient;

  constructor(npmClient: NpmClient) {
    this.npmClient = npmClient;
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

    const comparisons = await this.buildComparisons(analysis);
    const hasOlder = comparisons.some((c) => isNewerVersion(c.latestVersion, c.prVersion));
    const hasNewer = comparisons.some((c) => isNewerVersion(c.prVersion, c.latestVersion));
    const isObsolete = hasOlder && !hasNewer;

    const reason = isObsolete ? this.buildObsoleteReason(comparisons) : undefined;

    return {
      pr,
      workspaceName: analysis.workspaceName,
      isCandidate: true,
      isObsolete,
      reason,
      comparisons,
    };
  }

  private async buildComparisons(analysis: WorkspaceAnalysisResult): Promise<PackageComparison[]> {
    if (analysis.prPackages.length > 0) {
      const canonicalNames = analysis.prPackages.map((p) =>
        resolveCurrentPackageName(p.packageName),
      );
      const npmVersions = await Promise.all(
        canonicalNames.map((name) => this.npmClient.getLatestVersion(name)),
      );

      return analysis.prPackages.map((prPkg, idx) =>
        this.comparePackage(prPkg, analysis.mainPackages, npmVersions[idx] ?? null),
      );
    }

    const refComparison = this.compareRepoRef(analysis);
    return refComparison ? [refComparison] : [];
  }

  private comparePackage(
    prPkg: PackageVersion,
    mainPackages: PackageVersion[],
    npmVersion: string | null,
  ): PackageComparison {
    const canonicalName = resolveCurrentPackageName(prPkg.packageName);
    let upstreamVersion: string | undefined;
    let source: PackageComparison["source"] = "overlays-main";
    let details: string | undefined;

    const mainPkg = mainPackages.find(
      (p) => p.packageName === prPkg.packageName || p.packageName === canonicalName,
    );

    if (mainPkg) {
      upstreamVersion = mainPkg.version;
      details = `Target branch 'main' has version ${mainPkg.version}`;
    }

    if (npmVersion && (!upstreamVersion || isNewerVersion(npmVersion, upstreamVersion))) {
      upstreamVersion = npmVersion;
      source = "npm";
      details = `NPM registry has released version ${npmVersion}`;
    }

    const latestVersion = upstreamVersion ?? prPkg.version;
    const isPackageObsolete = isNewerVersion(latestVersion, prPkg.version);

    if (canonicalName !== prPkg.packageName) {
      source = "renamed";
      details = details
        ? `${details} (package renamed to ${canonicalName})`
        : `Package renamed to ${canonicalName}`;
    }

    return {
      packageName: prPkg.packageName,
      prVersion: prPkg.version,
      latestVersion,
      source,
      isObsolete: isPackageObsolete,
      details,
    };
  }

  private compareRepoRef(analysis: WorkspaceAnalysisResult): PackageComparison | null {
    if (!analysis.prSourceJson || !analysis.mainSourceJson) {
      return null;
    }

    const prRef = analysis.prSourceJson["repo-ref"];
    const mainRef = analysis.mainSourceJson["repo-ref"];
    const prClean = cleanVersion(prRef);
    const mainClean = cleanVersion(mainRef);

    if (prClean && mainClean && isNewerVersion(mainClean, prClean)) {
      return {
        packageName: `${analysis.workspaceName} (repo-ref)`,
        prVersion: prRef,
        latestVersion: mainRef,
        source: "overlays-main",
        isObsolete: true,
        details: `source.json repo-ref on 'main' (${mainRef}) is newer than PR (${prRef})`,
      };
    }

    return null;
  }

  private buildObsoleteReason(comparisons: PackageComparison[]): string {
    const obsoletePkgs = comparisons
      .filter((c) => isNewerVersion(c.latestVersion, c.prVersion))
      .map(
        (c) =>
          `${c.packageName} (requested: ${c.prVersion}, latest: ${c.latestVersion} [${c.source}])`,
      )
      .join(", ");
    return `Superseded by newer upstream release(s): ${obsoletePkgs}`;
  }
}
