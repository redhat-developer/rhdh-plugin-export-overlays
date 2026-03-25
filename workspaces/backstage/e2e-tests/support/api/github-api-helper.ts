import { APIResponse, request } from "@playwright/test";
import { RHDH_GITHUB_TEST_ORGANIZATION } from "../constants/github/organization.js";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

// https://docs.github.com/en/rest?apiVersion=2022-11-28
export class GitHubApiHelper {
  private static readonly gitHubApiVersion = "2022-11-28";
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
        "X-GitHub-Api-Version": this.gitHubApiVersion,
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
    const result = await GitHubApiHelper.githubRequest("GET", fullUrl);
    const body = await result.json();

    if (!Array.isArray(body)) {
      throw new TypeError(
        `Expected array but got ${typeof body}: ${JSON.stringify(body)}`,
      );
    }

    if (body.length === 0) {
      return response;
    }

    return GitHubApiHelper.getGithubPaginatedRequest(url, pageNo + 1, [
      ...response,
      ...body,
    ]);
  }

  /**
   * Create a GitHub repository with a file
   */
  public async createGitHubRepoWithFile(
    owner: string,
    repo: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    await GitHubApiHelper.githubRequest(
      "POST",
      `${this.apiUrl}/orgs/${owner}/repos`,
      JSON.stringify({
        name: repo,
        private: false,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        auto_init: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 2000));

    await GitHubApiHelper.githubRequest(
      "PUT",
      `${this.apiUrl}/repos/${owner}/${repo}/contents/${filePath}`,
      JSON.stringify({
        message: `Add ${filePath}`,
        content: Buffer.from(content).toString("base64"),
      }),
    );
  }

  /**
   * Update a file in a GitHub repository
   */
  public async updateFileInRepo(
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    commitMessage: string,
  ): Promise<void> {
    const resp = await GitHubApiHelper.githubRequest(
      "GET",
      `${this.apiUrl}/repos/${owner}/${repo}/contents/${filePath}`,
    );
    const fileData = (await resp.json()) as { sha: string };
    await GitHubApiHelper.githubRequest(
      "PUT",
      `${this.apiUrl}/repos/${owner}/${repo}/contents/${filePath}`,
      JSON.stringify({
        message: commitMessage,
        content: Buffer.from(content).toString("base64"),
        sha: fileData.sha,
      }),
    );
  }

  /**
   * Delete a file from a GitHub repository
   */
  public async deleteFileInRepo(
    owner: string,
    repo: string,
    filePath: string,
    commitMessage: string,
  ): Promise<void> {
    const getFileResponse = await GitHubApiHelper.githubRequest(
      "GET",
      `${this.apiUrl}/repos/${owner}/${repo}/contents/${filePath}`,
      undefined,
      true,
    );
    if (getFileResponse.status() === 404) {
      return;
    }
    if (!getFileResponse.ok()) {
      throw new Error(
        `Failed to get file: ${getFileResponse.status()} ${getFileResponse.statusText()}`,
      );
    }

    const fileData = (await getFileResponse.json()) as { sha: string };

    await GitHubApiHelper.githubRequest(
      "DELETE",
      `${this.apiUrl}/repos/${owner}/${repo}/contents/${filePath}`,
      JSON.stringify({
        message: commitMessage,
        sha: fileData.sha,
      }),
    );
  }

  /**
   * Delete a GitHub repository
   */
  public async deleteRepo(owner: string, repo: string): Promise<void> {
    const response = await GitHubApiHelper.githubRequest(
      "DELETE",
      `${this.apiUrl}/repos/${owner}/${repo}`,
      undefined,
      true,
    );

    if (!response.ok() && response.status() !== 404) {
      throw new Error(
        `Failed to delete repository: ${response.status()} ${response.statusText()}`,
      );
    }
  }

  /**
   * Create a team in a GitHub organization
   */
  public async createTeamInOrg(org: string, teamName: string): Promise<void> {
    await GitHubApiHelper.githubRequest(
      "POST",
      `${this.apiUrl}/orgs/${org}/teams`,
      JSON.stringify({
        name: teamName,
        privacy: "closed",
      }),
    );
  }

  /**
   * Delete a team from a GitHub organization
   */
  public async deleteTeamFromOrg(org: string, teamName: string): Promise<void> {
    const response = await GitHubApiHelper.githubRequest(
      "DELETE",
      `${this.apiUrl}/orgs/${org}/teams/${teamName}`,
      undefined,
      true,
    );

    if (!response.ok() && response.status() !== 404) {
      throw new Error(
        `Failed to delete team: ${response.status()} ${response.statusText()}`,
      );
    }
  }

  /**
   * Add a user to a team in a GitHub organization
   */
  public async addUserToTeam(
    org: string,
    teamName: string,
    username: string,
  ): Promise<void> {
    await GitHubApiHelper.githubRequest(
      "PUT",
      `${this.apiUrl}/orgs/${org}/teams/${teamName}/memberships/${username}`,
      JSON.stringify({
        role: "member",
      }),
    );
  }

  /**
   * Remove a user from a team in a GitHub organization
   */
  public async removeUserFromTeam(
    org: string,
    teamName: string,
    username: string,
  ): Promise<void> {
    const response = await GitHubApiHelper.githubRequest(
      "DELETE",
      `${this.apiUrl}/orgs/${org}/teams/${teamName}/memberships/${username}`,
      undefined,
      true,
    );

    if (!response.ok() && response.status() !== 404) {
      throw new Error(
        `Failed to remove user from team: ${response.status()} ${response.statusText()}`,
      );
    }
  }

  public async getOrganizationReposUrl(
    org = RHDH_GITHUB_TEST_ORGANIZATION,
  ): Promise<string> {
    const response = await GitHubApiHelper.githubRequest(
      "GET",
      `${this.apiUrl}/orgs/${org}`,
    );
    return (await response.json())["repos_url"];
  }

  public async getReposFromOrg(org = RHDH_GITHUB_TEST_ORGANIZATION) {
    const reposUrl = await this.getOrganizationReposUrl(org);
    // GitHub defaults to 30; use 100 to reduce API calls.
    return GitHubApiHelper.getGithubPaginatedRequest(
      `${reposUrl}?per_page=100`,
    );
  }

  public async fileExistsInRepo(
    owner: string,
    repo: string,
    filePath: string,
  ): Promise<boolean> {
    const resp = await GitHubApiHelper.githubRequest(
      "GET",
      `${this.apiUrl}/repos/${owner}/${repo}/contents/${filePath}`,
      undefined,
      true,
    );
    const status = resp.status();
    return [200, 302, 304].includes(status);
  }
}
