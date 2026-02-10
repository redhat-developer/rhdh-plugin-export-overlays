import { request } from "@playwright/test";
/**
 * Helper class for making API calls to GitHub and RHDH
 */
export class CustomAPIHelper {
  /**
   * Get a group entity from the RHDH catalog API
   */
  static async getGroupEntityFromAPI(
    baseUrl: string,
    token: string,
    groupName: string,
  ): Promise<any> {
    const context = await request.newContext({
      ignoreHTTPSErrors: true,
    });

    const url = `${baseUrl}/api/catalog/entities/by-name/group/default/${groupName}`;
    const response = await context.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok()) {
      throw new Error(
        `Failed to get group entity: ${response.status()} ${response.statusText()}`,
      );
    }

    return await response.json();
  }

  /**
   * Extract group members from a group entity
   */
  static async getGroupMembers(
    baseUrl: string,
    token: string,
    groupName: string,
  ): Promise<string[]> {
    const groupEntity = await CustomAPIHelper.getGroupEntityFromAPI(
      baseUrl,
      token,
      groupName,
    );
    const members =
      groupEntity.relations
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ?.filter((r: any) => r.type === "hasMember")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => r.targetRef.split("/")[1]) || [];
    return members;
  }

  /**
   * Create a GitHub repository with a file
   */
  static async createGitHubRepoWithFile(
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    token: string,
  ): Promise<void> {
    const createRepoResponse = await fetch(
      `https://api.github.com/orgs/${owner}/repos`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          name: repo,
          private: false,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          auto_init: true,
        }),
      },
    );

    if (!createRepoResponse.ok) {
      const errorText = await createRepoResponse.text();
      throw new Error(
        `Failed to create repository: ${createRepoResponse.status} ${errorText}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const createFileResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          message: `Add ${filePath}`,
          content: Buffer.from(content).toString("base64"),
        }),
      },
    );

    if (!createFileResponse.ok) {
      const errorText = await createFileResponse.text();
      throw new Error(
        `Failed to create file: ${createFileResponse.status} ${errorText}`,
      );
    }
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
    token: string,
  ): Promise<void> {
    const getFileResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!getFileResponse.ok) {
      throw new Error(
        `Failed to get file: ${getFileResponse.status} ${getFileResponse.statusText}`,
      );
    }

    const fileData = (await getFileResponse.json()) as { sha: string };

    const updateFileResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          message: commitMessage,
          content: Buffer.from(content).toString("base64"),
          sha: fileData.sha,
        }),
      },
    );

    if (!updateFileResponse.ok) {
      const errorText = await updateFileResponse.text();
      throw new Error(
        `Failed to update file: ${updateFileResponse.status} ${errorText}`,
      );
    }
  }

  /**
   * Delete a file from a GitHub repository
   */
  static async deleteFileInRepo(
    owner: string,
    repo: string,
    filePath: string,
    commitMessage: string,
    token: string,
  ): Promise<void> {
    const getFileResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (getFileResponse.status === 404) {
      console.log(`File ${filePath} already deleted or doesn't exist`);
      return;
    }

    if (!getFileResponse.ok) {
      throw new Error(
        `Failed to get file: ${getFileResponse.status} ${getFileResponse.statusText}`,
      );
    }

    const fileData = (await getFileResponse.json()) as { sha: string };

    const deleteFileResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          message: commitMessage,
          sha: fileData.sha,
        }),
      },
    );

    if (!deleteFileResponse.ok && deleteFileResponse.status !== 404) {
      const errorText = await deleteFileResponse.text();
      throw new Error(
        `Failed to delete file: ${deleteFileResponse.status} ${errorText}`,
      );
    }
  }

  /**
   * Delete a GitHub repository
   */
  static async deleteRepo(
    owner: string,
    repo: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(
        `Failed to delete repository: ${response.status} ${errorText}`,
      );
    }
  }

  /**
   * Create a team in a GitHub organization
   */
  static async createTeamInOrg(
    org: string,
    teamName: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(`https://api.github.com/orgs/${org}/teams`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        name: teamName,
        privacy: "closed",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create team: ${response.status} ${errorText}`);
    }
  }

  /**
   * Delete a team from a GitHub organization
   */
  static async deleteTeamFromOrg(
    org: string,
    teamName: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(
      `https://api.github.com/orgs/${org}/teams/${teamName}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`Failed to delete team: ${response.status} ${errorText}`);
    }
  }

  /**
   * Add a user to a team in a GitHub organization
   */
  static async addUserToTeam(
    org: string,
    teamName: string,
    username: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(
      `https://api.github.com/orgs/${org}/teams/${teamName}/memberships/${username}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          role: "member",
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to add user to team: ${response.status} ${errorText}`,
      );
    }
  }

  /**
   * Remove a user from a team in a GitHub organization
   */
  static async removeUserFromTeam(
    org: string,
    teamName: string,
    username: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(
      `https://api.github.com/orgs/${org}/teams/${teamName}/memberships/${username}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(
        `Failed to remove user from team: ${response.status} ${errorText}`,
      );
    }
  }
}
