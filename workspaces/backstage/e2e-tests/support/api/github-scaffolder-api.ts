import { randomBytes } from "node:crypto";

import {
  APIHelper,
  GITHUB_API_ENDPOINTS,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

import { GitHubApiHelper } from "./github-api-helper.js";

/* eslint-disable @typescript-eslint/naming-convention --
   GitHub REST response bodies and query params follow API names (snake_case). */

/** Repository fields consumed from GitHub REST in these tests */
export interface GitHubRepository {
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
}

/** Issue fields consumed from GitHub REST (`/repos/:owner/:repo/issues`) in these tests */
export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  labels: GitHubLabel[];
}

/** Label fields consumed from GitHub REST in these tests */
export interface GitHubLabel {
  name: string;
}

/** Pull request fields consumed from GitHub REST in these tests */
export interface GitHubPullRequest {
  number: number;
  title: string;
  html_url: string;
  head: {
    ref: string;
  };
}

/** Repository contents entry from GitHub REST (`/repos/:owner/:repo/contents/:path`) */
export interface GitHubRepositoryFile {
  name: string;
  path: string;
  type: string;
}

/** Autolink reference from GitHub REST (`/repos/:owner/:repo/autolinks`) */
export interface GitHubAutolinkReference {
  id: number;
  key_prefix: string;
  url_template: string;
}

/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Scaffolder-specific GitHub REST assertion helpers.
 *
 * Extends {@link GitHubApiHelper} so it reuses `safeGithubRequest()` /
 * `APIHelper.githubRequest()` and `GITHUB_API_ENDPOINTS` from the shared
 * e2e-test-utils package — no duplicate HTTP-client setup needed.
 *
 * @see https://docs.github.com/en/rest
 */
export class GitHubScaffolderApi extends GitHubApiHelper {
  /** GET `/repos/{owner}/{repo}` */
  static async getRepository(
    owner: string,
    repo: string,
  ): Promise<GitHubRepository> {
    const response = await this.safeGithubRequest(
      "GET",
      GITHUB_API_ENDPOINTS.getRepo(owner, repo),
    );
    return (await response.json()) as GitHubRepository;
  }

  /**
   * GET `/repos/{owner}/{repo}/issues`
   * Returns open issues (not PRs), optionally filtered by title.
   */
  static async listIssues(
    owner: string,
    repo: string,
    title?: string,
  ): Promise<GitHubIssue[]> {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const params = new URLSearchParams({ state: "open", per_page: "100" });
    const response = await this.safeGithubRequest(
      "GET",
      `${GITHUB_API_ENDPOINTS.getRepo(owner, repo)}/issues?${params}`,
    );
    const issues = (await response.json()) as GitHubIssue[];
    // GitHub issues endpoint also returns PRs; filter them out.
    const issuesOnly = issues.filter(
      (i) => !("pull_request" in (i as unknown as Record<string, unknown>)),
    );
    return title ? issuesOnly.filter((i) => i.title === title) : issuesOnly;
  }

  /** GET `/repos/{owner}/{repo}/issues/{issue_number}/labels` */
  static async getIssueLabels(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GitHubLabel[]> {
    const response = await this.safeGithubRequest(
      "GET",
      `${GITHUB_API_ENDPOINTS.getRepo(owner, repo)}/issues/${issueNumber}/labels`,
    );
    return (await response.json()) as GitHubLabel[];
  }

  /**
   * GET `/repos/{owner}/{repo}/pulls`
   * Returns open pull requests, optionally filtered by source branch.
   */
  static async listPullRequests(
    owner: string,
    repo: string,
    head?: string,
  ): Promise<GitHubPullRequest[]> {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const params = new URLSearchParams({ state: "open", per_page: "100" });
    if (head) {
      params.set("head", `${owner}:${head}`);
    }
    const response = await this.safeGithubRequest(
      "GET",
      `${GITHUB_API_ENDPOINTS.getRepo(owner, repo)}/pulls?${params}`,
    );
    return (await response.json()) as GitHubPullRequest[];
  }

  /**
   * GET `/repos/{owner}/{repo}/contents/{path}`
   * Returns file metadata or `undefined` when the path does not exist (404).
   */
  static async getRepositoryFile(
    owner: string,
    repo: string,
    filePath: string,
    ref = "main",
  ): Promise<GitHubRepositoryFile | undefined> {
    const url = `${GITHUB_API_ENDPOINTS.contents(owner, repo)}/${filePath}?ref=${encodeURIComponent(ref)}`;
    const response = await APIHelper.githubRequest("GET", url);
    if (response.status() === 404) {
      return undefined;
    }
    if (!response.ok()) {
      const text = await response.text();
      throw new Error(
        `GitHub API GET contents ${filePath} failed: ${response.status()}\n${text}`,
      );
    }
    return (await response.json()) as GitHubRepositoryFile;
  }

  /** GET `/repos/{owner}/{repo}/autolinks` */
  static async listAutolinks(
    owner: string,
    repo: string,
  ): Promise<GitHubAutolinkReference[]> {
    const response = await this.safeGithubRequest(
      "GET",
      `${GITHUB_API_ENDPOINTS.getRepo(owner, repo)}/autolinks`,
    );
    return (await response.json()) as GitHubAutolinkReference[];
  }

  /**
   * DELETE `/repos/{owner}/{repo}`
   * Silently succeeds when the repo is already gone (404).
   */
  static async deleteRepository(owner: string, repo: string): Promise<void> {
    await this.deleteGitHubRepo(owner, repo);
  }

  /** Generate a unique test prefix for GitHub resource names. */
  static generateTestPrefix(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString("hex");
    return `e2e-${timestamp}-${random}`;
  }
}
