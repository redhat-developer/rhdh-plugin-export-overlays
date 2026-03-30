import { APIResponse } from "@playwright/test";
import { RHDH_GITHUB_TEST_ORGANIZATION } from "../constants/github/organization.js";
import {
  APIHelper,
  GITHUB_API_ENDPOINTS,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

const baseApiUrl = "https://api.github.com";
const getOrgUrl = (owner: string) => `${baseApiUrl}/orgs/${owner}`;

// https://docs.github.com/en/rest?apiVersion=2022-11-28
export class GitHubApiHelper extends APIHelper {
  static async safeGithubRequest(
    method: string,
    url: string,
    body?: string | object,
  ): Promise<APIResponse> {
    const response = await this.githubRequest(method, url, body);
    if (!response.ok) {
      throw new Error(
        `Failed to ${method} ${url}: ${response.status()} ${response.statusText()}`,
      );
    }

    return response;
  }

  /**
   * Update a file in a GitHub repository
   */
  static async updateFileInRepo(
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    commitMessage: string,
  ): Promise<void> {
    const getFileResponse = await this.safeGithubRequest(
      "GET",
      `${GITHUB_API_ENDPOINTS.contents(owner, repo)}/${filePath}`,
    );

    const fileData = (await getFileResponse.json()) as { sha: string };

    await this.safeGithubRequest(
      "PUT",
      `${GITHUB_API_ENDPOINTS.contents(owner, repo)}/${filePath}`,
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
  static async deleteFileInRepo(
    owner: string,
    repo: string,
    filePath: string,
    commitMessage: string,
  ): Promise<void> {
    const getFileResponse = await this.githubRequest(
      "GET",
      `${GITHUB_API_ENDPOINTS.contents(owner, repo)}/${filePath}`,
    );
    if (getFileResponse.status() === 404) {
      console.log(`File ${filePath} already deleted or doesn't exist`);
      return;
    }
    if (!getFileResponse.ok) {
      throw new Error(
        `Failed to get file: ${getFileResponse.status()} ${getFileResponse.statusText()}`,
      );
    }

    const fileData = (await getFileResponse.json()) as { sha: string };

    await this.safeGithubRequest(
      "DELETE",
      `${GITHUB_API_ENDPOINTS.contents(owner, repo)}/${filePath}`,
      JSON.stringify({
        message: commitMessage,
        sha: fileData.sha,
      }),
    );
  }

  /**
   * Create a team in a GitHub organization
   */
  static async createTeamInOrg(org: string, teamName: string): Promise<void> {
    await this.safeGithubRequest(
      "POST",
      `${getOrgUrl(org)}/teams`,
      JSON.stringify({
        name: teamName,
        privacy: "closed",
      }),
    );
  }

  /**
   * Delete a team from a GitHub organization
   */
  static async deleteTeamFromOrg(org: string, teamName: string): Promise<void> {
    const response = await this.githubRequest(
      "DELETE",
      `${getOrgUrl(org)}/teams/${teamName}`,
    );

    if (!response.ok && response.status() !== 404) {
      throw new Error(
        `Failed to delete team: ${response.status()} ${response.statusText()}`,
      );
    }
  }

  /**
   * Add a user to a team in a GitHub organization
   */
  static async addUserToTeam(
    org: string,
    teamName: string,
    username: string,
  ): Promise<void> {
    await this.safeGithubRequest(
      "PUT",
      `${getOrgUrl(org)}/teams/${teamName}/memberships/${username}`,
      JSON.stringify({
        role: "member",
      }),
    );
  }

  /**
   * Remove a user from a team in a GitHub organization
   */
  static async removeUserFromTeam(
    org: string,
    teamName: string,
    username: string,
  ): Promise<void> {
    const response = await this.githubRequest(
      "DELETE",
      `${getOrgUrl(org)}/teams/${teamName}/memberships/${username}`,
    );

    if (!response.ok && response.status() !== 404) {
      throw new Error(
        `Failed to remove user from team: ${response.status()} ${response.statusText()}`,
      );
    }
  }

  static async getOrganizationReposUrl(
    org = RHDH_GITHUB_TEST_ORGANIZATION,
  ): Promise<string> {
    const response = await this.safeGithubRequest("GET", getOrgUrl(org));
    return (await response.json())["repos_url"];
  }

  static async getReposFromOrg(org = RHDH_GITHUB_TEST_ORGANIZATION) {
    const reposUrl = await this.getOrganizationReposUrl(org);
    // GitHub defaults to 30; use 100 to reduce API calls.
    return this.getGithubPaginatedRequest(`${reposUrl}?per_page=100`);
  }

  static async fileExistsInRepo(
    owner: string,
    repo: string,
    filePath: string,
  ): Promise<boolean> {
    const resp = await this.githubRequest(
      "GET",
      `${GITHUB_API_ENDPOINTS.contents(owner, repo)}/${filePath}`,
    );
    const status = resp.status();
    return [200, 302, 304].includes(status);
  }
}
