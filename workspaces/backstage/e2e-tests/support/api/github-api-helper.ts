import { APIResponse, request } from "@playwright/test";
import { RHDH_GITHUB_TEST_ORGANIZATION } from "../constants/github/organization.js";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

// https://docs.github.com/en/rest?apiVersion=2022-11-28
export class GithubApiHelper {
  private static readonly githubApiVersion = "2022-11-28";
  private readonly apiUrl = "https://api.github.com";

  public constructor() {
    requireEnv("VAULT_GITHUB_USER_TOKEN");
  }

  static async githubRequest(
    method: string,
    url: string,
    body?: string | object,
    suppressError: boolean = false,
  ): Promise<APIResponse> {
    const context = await request.newContext();
    const options: {
      method: string;
      headers: Record<string, string>;
      data?: string | object;
    } = {
      method: method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.VAULT_GITHUB_USER_TOKEN}`,
        "X-GitHub-Api-Version": this.githubApiVersion,
      },
    };

    if (body !== undefined) {
      options.data = body;
    }

    const resp = await context.fetch(url, options);
    if (!suppressError && !resp.ok()) {
      throw new Error(
        `Failed to ${method} ${url}: ${resp.status()} ${resp.statusText()}`,
      );
    }

    return resp;
  }

  static async getGithubPaginatedRequest(
    url: string,
    pageNo = 1,
    response: unknown[] = [],
  ): Promise<unknown[]> {
    const fullUrl = url.includes("?")
      ? `${url}&page=${pageNo}`
      : `${url}?page=${pageNo}`;
    const result = await GithubApiHelper.githubRequest("GET", fullUrl);
    const body = await result.json();

    if (!Array.isArray(body)) {
      throw new TypeError(
        `Expected array but got ${typeof body}: ${JSON.stringify(body)}`,
      );
    }

    if (body.length === 0) {
      return response;
    }

    return GithubApiHelper.getGithubPaginatedRequest(url, pageNo + 1, [
      ...response,
      ...body,
    ]);
  }

  public async getOrganizationReposUrl(
    org = RHDH_GITHUB_TEST_ORGANIZATION,
  ): Promise<string> {
    const response = await GithubApiHelper.githubRequest(
      "GET",
      `${this.apiUrl}/orgs/${org}`,
    );
    return (await response.json())["repos_url"];
  }

  public async getReposFromOrg(org = RHDH_GITHUB_TEST_ORGANIZATION) {
    const reposUrl = await this.getOrganizationReposUrl(org);
    // GitHub defaults to 30; use 100 to reduce API calls.
    return GithubApiHelper.getGithubPaginatedRequest(
      `${reposUrl}?per_page=100`,
    );
  }

  public async fileExistsInRepo(repo: string, file: string): Promise<boolean> {
    const resp = await GithubApiHelper.githubRequest(
      "GET",
      `${this.apiUrl}/repos/${repo}/contents/${file}`,
      undefined,
      true,
    );
    const status = resp.status();
    return [200, 302, 304].includes(status);
  }
}
