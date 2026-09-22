import { APIRequestContext, request } from "@playwright/test";

export interface GitLabOAuthApp {
  id: number;
  applicationId: string;
  secret: string;
}

/**
 * GitLab OAuth application helper for auth-provider e2e.
 * Ported from RHDH core (gitlab-helper) — create/delete OAuth apps only.
 */
export class GitLabOAuthHelper {
  private readonly personalAccessToken: string;
  private readonly apiBaseUrl: string;
  private context: APIRequestContext | undefined;

  constructor(host: string, personalAccessToken: string) {
    const cleanHost = host.replace(/^https?:\/\//, "");
    this.apiBaseUrl = `https://${cleanHost}/api/v4`;
    this.personalAccessToken = personalAccessToken;
  }

  private async getContext(): Promise<APIRequestContext> {
    if (!this.context) {
      this.context = await request.newContext({ ignoreHTTPSErrors: true });
    }
    return this.context;
  }

  async dispose(): Promise<void> {
    if (this.context) {
      await this.context.dispose();
      this.context = undefined;
    }
  }

  async createOAuthApplication(
    name: string,
    redirectUri: string,
    scopes = "read_user openid profile email",
    trusted = true,
  ): Promise<GitLabOAuthApp> {
    const context = await this.getContext();
    const response = await context.post(`${this.apiBaseUrl}/applications`, {
      headers: {
        // GitLab API header name
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "PRIVATE-TOKEN": this.personalAccessToken,
        "Content-Type": "application/json",
      },
      data: {
        name,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        redirect_uri: redirectUri,
        scopes,
        trusted,
      },
    });

    if (!response.ok()) {
      const errorText = await response.text();
      throw new Error(
        `Failed to create OAuth application: ${response.status()} ${response.statusText()} - ${errorText}`,
      );
    }

    const app = (await response.json()) as Record<string, unknown>;
    const id = app.id;
    const applicationId = app.application_id;
    const secret = app.secret;
    if (
      typeof id !== "number" ||
      typeof applicationId !== "string" ||
      typeof secret !== "string"
    ) {
      throw new TypeError(
        "GitLab API response missing required fields (id, application_id, or secret)",
      );
    }

    return { id, applicationId, secret };
  }

  async deleteOAuthApplication(id: number): Promise<void> {
    const context = await this.getContext();
    const response = await context.delete(
      `${this.apiBaseUrl}/applications/${id}`,
      {
        headers: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          "PRIVATE-TOKEN": this.personalAccessToken,
        },
      },
    );

    if (!response.ok() && response.status() !== 404) {
      const errorText = await response.text();
      throw new Error(
        `Failed to delete OAuth application: ${response.status()} ${response.statusText()} - ${errorText}`,
      );
    }
  }
}
