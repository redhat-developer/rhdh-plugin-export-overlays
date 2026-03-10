/**
 * Helper class for making API calls to GitHub and RHDH
 */
export class CustomAPIHelper {
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
}
