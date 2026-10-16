/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { errorProperty, isPlainObject, trimTrailingSlashes } from "./helpers.ts";
import type { PullRequestSummary } from "./types.ts";

export class GitHubClient {
  private readonly token?: string;
  private readonly apiBase: string;

  constructor(token?: string, apiBase: string = "https://api.github.com") {
    this.token = token || process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
    this.apiBase = trimTrailingSlashes(apiBase);
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "close-obsolete-update-prs",
    };
    if (this.token) {
      h["Authorization"] = `Bearer ${this.token}`;
    }
    return h;
  }

  private async requestJson(endpoint: string, options: RequestInit = {}): Promise<unknown> {
    const url = endpoint.startsWith("http") ? endpoint : `${this.apiBase}${endpoint}`;
    const mergedHeaders = new Headers(this.headers);
    if (options.headers) {
      new Headers(options.headers).forEach((v, k) => mergedHeaders.set(k, v));
    }

    const response = await fetch(url, {
      ...options,
      headers: mergedHeaders,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(
        `GitHub API request failed [${response.status} ${response.statusText}]: ${errorText}`,
      );
      Reflect.set(err, "status", response.status);
      throw err;
    }

    if (response.status === 204) {
      return undefined;
    }

    return response.json();
  }

  async listOpenPRs(
    owner: string,
    repo: string,
    base: string = "main",
  ): Promise<PullRequestSummary[]> {
    const prs: PullRequestSummary[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const endpoint = `/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=${perPage}&page=${page}`;
      const data = await this.requestJson(endpoint);
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }

      for (const item of data) {
        if (!isPlainObject(item)) continue;
        const number = typeof item["number"] === "number" ? item["number"] : 0;
        const title = typeof item["title"] === "string" ? item["title"] : "";
        const htmlUrl = typeof item["html_url"] === "string" ? item["html_url"] : "";
        const createdAt = typeof item["created_at"] === "string" ? item["created_at"] : "";

        const head = isPlainObject(item["head"]) ? item["head"] : {};
        const headRef = typeof head["ref"] === "string" ? head["ref"] : "";
        const headSha = typeof head["sha"] === "string" ? head["sha"] : headRef;
        const headRepoObj = isPlainObject(head["repo"]) ? head["repo"] : undefined;
        const headRepo =
          headRepoObj && typeof headRepoObj["full_name"] === "string"
            ? headRepoObj["full_name"]
            : undefined;

        const baseObj = isPlainObject(item["base"]) ? item["base"] : {};
        const baseRef = typeof baseObj["ref"] === "string" ? baseObj["ref"] : "";

        const userObj = isPlainObject(item["user"]) ? item["user"] : {};
        const author = typeof userObj["login"] === "string" ? userObj["login"] : "";

        const rawLabels = Array.isArray(item["labels"]) ? item["labels"] : [];
        const labels: string[] = [];
        for (const l of rawLabels) {
          if (isPlainObject(l) && typeof l["name"] === "string") {
            labels.push(l["name"]);
          }
        }

        prs.push({
          number,
          title,
          headRef,
          headSha,
          headRepo,
          baseRef,
          labels,
          author,
          htmlUrl,
          createdAt,
        });
      }

      if (data.length < perPage) {
        break;
      }
      page++;
    }

    return prs;
  }

  async getPR(owner: string, repo: string, pullNumber: number): Promise<PullRequestSummary> {
    const data = await this.requestJson(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
    if (!isPlainObject(data)) {
      throw new Error(`Invalid PR response for #${pullNumber}`);
    }

    const number = typeof data["number"] === "number" ? data["number"] : pullNumber;
    const title = typeof data["title"] === "string" ? data["title"] : "";
    const htmlUrl = typeof data["html_url"] === "string" ? data["html_url"] : "";
    const createdAt = typeof data["created_at"] === "string" ? data["created_at"] : "";

    const head = isPlainObject(data["head"]) ? data["head"] : {};
    const headRef = typeof head["ref"] === "string" ? head["ref"] : "";
    const headSha = typeof head["sha"] === "string" ? head["sha"] : headRef;
    const headRepoObj = isPlainObject(head["repo"]) ? head["repo"] : undefined;
    const headRepo =
      headRepoObj && typeof headRepoObj["full_name"] === "string"
        ? headRepoObj["full_name"]
        : undefined;

    const baseObj = isPlainObject(data["base"]) ? data["base"] : {};
    const baseRef = typeof baseObj["ref"] === "string" ? baseObj["ref"] : "";

    const userObj = isPlainObject(data["user"]) ? data["user"] : {};
    const author = typeof userObj["login"] === "string" ? userObj["login"] : "";

    const rawLabels = Array.isArray(data["labels"]) ? data["labels"] : [];
    const labels: string[] = [];
    for (const l of rawLabels) {
      if (isPlainObject(l) && typeof l["name"] === "string") {
        labels.push(l["name"]);
      }
    }

    return {
      number,
      title,
      headRef,
      headSha,
      headRepo,
      baseRef,
      labels,
      author,
      htmlUrl,
      createdAt,
    };
  }

  async getPRFiles(owner: string, repo: string, pullNumber: number): Promise<string[]> {
    const files: string[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const endpoint = `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${perPage}&page=${page}`;
      const data = await this.requestJson(endpoint);
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }

      for (const item of data) {
        if (isPlainObject(item) && typeof item["filename"] === "string") {
          files.push(item["filename"]);
        }
      }

      if (data.length < perPage) {
        break;
      }
      page++;
    }

    return files;
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const endpoint = `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
      const data = await this.requestJson(endpoint);
      if (!isPlainObject(data) || data["type"] !== "file" || typeof data["content"] !== "string") {
        return null;
      }
      const rawEncoding = typeof data["encoding"] === "string" ? data["encoding"] : "base64";
      const encoding: BufferEncoding =
        rawEncoding === "utf-8" || rawEncoding === "utf8" ? "utf8" : "base64";
      return Buffer.from(data["content"], encoding).toString("utf8");
    } catch (err: unknown) {
      if (errorProperty(err, "status") === 404) {
        return null;
      }
      throw err;
    }
  }

  async addComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.requestJson(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    await this.requestJson(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels }),
    });
  }

  async ensureLabel(
    owner: string,
    repo: string,
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    try {
      await this.requestJson(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`);
    } catch (err: unknown) {
      if (errorProperty(err, "status") === 404) {
        await this.requestJson(`/repos/${owner}/${repo}/labels`, {
          method: "POST",
          body: JSON.stringify({ name, color, description }),
        });
      } else {
        throw err;
      }
    }
  }

  async closePR(owner: string, repo: string, pullNumber: number): Promise<void> {
    await this.requestJson(`/repos/${owner}/${repo}/pulls/${pullNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }
}
