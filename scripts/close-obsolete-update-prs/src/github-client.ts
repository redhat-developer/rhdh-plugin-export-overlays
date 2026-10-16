/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { errorProperty, isPlainObject, trimTrailingSlashes } from "./helpers.ts";
import type { PullRequestSummary } from "./types.ts";

const REPO_SLUG_REGEX = /^[a-zA-Z0-9_.-]+$/;

function validateRepoSlug(owner: string, repo: string): void {
  if (!REPO_SLUG_REGEX.test(owner) || !REPO_SLUG_REGEX.test(repo)) {
    throw new Error(`Invalid repository identifier: ${owner}/${repo}`);
  }
}

function validateId(id: number): number {
  const n = Math.floor(Math.abs(id));
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid numeric ID: ${id}`);
  }
  return n;
}

function extractLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const labels: string[] = [];
  for (const item of raw) {
    if (isPlainObject(item) && typeof item["name"] === "string") {
      labels.push(item["name"]);
    }
  }
  return labels;
}

function parsePullRequestSummary(item: unknown): PullRequestSummary | null {
  if (!isPlainObject(item)) return null;

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

  return {
    number,
    title,
    headRef,
    headSha,
    headRepo,
    baseRef,
    labels: extractLabels(item["labels"]),
    author,
    htmlUrl,
    createdAt,
  };
}

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
    if (endpoint.includes("..")) {
      throw new Error("Path traversal forbidden");
    }

    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const targetUrl = new URL(cleanEndpoint, `${this.apiBase}/`);

    if (targetUrl.origin !== new URL(this.apiBase).origin) {
      throw new Error(`Cross-origin API request forbidden: ${targetUrl.origin}`);
    }

    const mergedHeaders = new Headers(this.headers);
    if (options.headers) {
      new Headers(options.headers).forEach((v, k) => mergedHeaders.set(k, v));
    }

    const response = await fetch(targetUrl.href, {
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
    validateRepoSlug(owner, repo);
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
        const parsed = parsePullRequestSummary(item);
        if (parsed) {
          prs.push(parsed);
        }
      }

      if (data.length < perPage) {
        break;
      }
      page++;
    }

    return prs;
  }

  async getPR(owner: string, repo: string, pullNumber: number): Promise<PullRequestSummary> {
    validateRepoSlug(owner, repo);
    const safePullNumber = validateId(pullNumber);
    const data = await this.requestJson(`/repos/${owner}/${repo}/pulls/${safePullNumber}`);
    const pr = parsePullRequestSummary(data);
    if (!pr) {
      throw new Error(`Invalid PR response for #${pullNumber}`);
    }
    return pr;
  }

  async getPRFiles(owner: string, repo: string, pullNumber: number): Promise<string[]> {
    validateRepoSlug(owner, repo);
    const safePullNumber = validateId(pullNumber);
    const files: string[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const endpoint = `/repos/${owner}/${repo}/pulls/${safePullNumber}/files?per_page=${perPage}&page=${page}`;
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
    validateRepoSlug(owner, repo);
    try {
      const cleanPath = path.split("/").map(encodeURIComponent).join("/");
      const endpoint = `/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(ref)}`;
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
    validateRepoSlug(owner, repo);
    const safeIssueNumber = validateId(issueNumber);
    await this.requestJson(`/repos/${owner}/${repo}/issues/${safeIssueNumber}/comments`, {
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
    validateRepoSlug(owner, repo);
    const safeIssueNumber = validateId(issueNumber);
    await this.requestJson(`/repos/${owner}/${repo}/issues/${safeIssueNumber}/labels`, {
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
    validateRepoSlug(owner, repo);
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
    validateRepoSlug(owner, repo);
    const safePullNumber = validateId(pullNumber);
    await this.requestJson(`/repos/${owner}/${repo}/pulls/${safePullNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }
}
