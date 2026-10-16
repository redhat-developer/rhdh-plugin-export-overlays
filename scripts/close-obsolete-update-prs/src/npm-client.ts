/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

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
      const encodedName = packageName.startsWith("@")
        ? `@${encodeURIComponent(packageName.slice(1))}`
        : encodeURIComponent(packageName);

      const url = `${this.registryUrl}/${encodedName}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
          "User-Agent": "close-obsolete-update-prs",
        },
      });

      if (response.status === 404) {
        this.cache.set(packageName, null);
        return null;
      }

      if (!response.ok) {
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

      if (latestTag) {
        this.cache.set(packageName, latestTag);
        return latestTag;
      }

      const versionsObj = isPlainObject(data["versions"]) ? data["versions"] : undefined;
      const versions = versionsObj ? Object.keys(versionsObj) : [];
      if (versions.length > 0) {
        versions.sort(compareVersions);
        const highest = versions.at(-1);
        if (highest) {
          this.cache.set(packageName, highest);
          return highest;
        }
      }

      this.cache.set(packageName, null);
      return null;
    } catch {
      return null;
    }
  }
}
