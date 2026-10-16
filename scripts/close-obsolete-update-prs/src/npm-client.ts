/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import semver from "semver";
import { isPlainObject, trimTrailingSlashes } from "./helpers.ts";
import { compareVersions } from "./semver-compare.ts";

export class NpmClient {
  private readonly registryUrl: string;
  private readonly cache = new Map<string, string | null>();

  constructor(registryUrl: string = "https://registry.npmjs.org") {
    this.registryUrl = trimTrailingSlashes(registryUrl);
  }

  async getLatestVersion(packageName: string): Promise<string | null> {
    if (this.cache.has(packageName)) {
      return this.cache.get(packageName) ?? null;
    }

    try {
      const url = this.buildPackageUrl(packageName);
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
          "User-Agent": "close-obsolete-update-prs",
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.cache.set(packageName, null);
        }
        return null;
      }

      const data: unknown = await response.json();
      if (!isPlainObject(data)) {
        this.cache.set(packageName, null);
        return null;
      }

      const distTags = isPlainObject(data["dist-tags"]) ? data["dist-tags"] : undefined;
      const latestTag =
        distTags && typeof distTags["latest"] === "string" ? distTags["latest"] : undefined;

      const result = latestTag ?? this.extractHighestVersion(data["versions"]);
      this.cache.set(packageName, result);
      return result;
    } catch {
      return null;
    }
  }

  private buildPackageUrl(packageName: string): string {
    const encodedName = packageName.startsWith("@")
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);
    return `${this.registryUrl}/${encodedName}`;
  }

  private extractHighestVersion(versionsObj: unknown): string | null {
    if (!isPlainObject(versionsObj)) return null;
    const versions = Object.keys(versionsObj);
    if (versions.length === 0) return null;

    const stableVersions = versions.filter((v) => {
      const parsed = semver.parse(v);
      return parsed !== null && parsed.prerelease.length === 0;
    });

    const candidates = stableVersions.length > 0 ? stableVersions : versions;
    candidates.sort(compareVersions);
    return candidates.at(-1) ?? null;
  }
}
