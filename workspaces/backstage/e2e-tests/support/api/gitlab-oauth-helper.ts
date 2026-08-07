export interface GitLabOAuthApp {
  id: number;
  applicationId: string;
  applicationName: string;
  secret: string;
  callbackUrl: string;
  scopes: string[];
}

/**
 * GitLab OAuth application helper for auth-provider e2e.
 * Ported from RHDH core (gitlab-helper) — create/delete OAuth apps only.
 */
export class GitLabOAuthHelper {
  private readonly personalAccessToken: string;
  private readonly apiBaseUrl: string;

  constructor(host: string, personalAccessToken: string) {
    const cleanHost = host.replace(/^https?:\/\//, "");
    this.apiBaseUrl = `https://${cleanHost}/api/v4`;
    this.personalAccessToken = personalAccessToken;
  }

  async createOAuthApplication(
    name: string,
    redirectUri: string,
    scopes = "api read_user write_repository sudo",
    trusted = true,
  ): Promise<GitLabOAuthApp> {
    const response = await fetch(`${this.apiBaseUrl}/applications`, {
      method: "POST",
      headers: {
        // GitLab API header name
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "PRIVATE-TOKEN": this.personalAccessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        redirect_uri: redirectUri,
        scopes,
        trusted,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to create OAuth application: ${response.status} ${response.statusText} - ${errorText}`,
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
      throw new Error(
        "GitLab API response missing required fields (id, application_id, or secret)",
      );
    }

    const applicationName =
      (typeof app.application_name === "string" && app.application_name) ||
      (typeof app.name === "string" && app.name) ||
      name;
    const callbackUrl =
      (typeof app.callback_url === "string" && app.callback_url) ||
      (typeof app.redirect_uri === "string" && app.redirect_uri) ||
      redirectUri;
    const responseScopes = Array.isArray(app.scopes)
      ? app.scopes.filter((s): s is string => typeof s === "string")
      : scopes.split(" ");

    return {
      id,
      applicationId,
      applicationName,
      secret,
      callbackUrl,
      scopes: responseScopes,
    };
  }

  async deleteOAuthApplication(applicationId: number): Promise<void> {
    const response = await fetch(
      `${this.apiBaseUrl}/applications/${applicationId}`,
      {
        method: "DELETE",
        headers: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          "PRIVATE-TOKEN": this.personalAccessToken,
        },
      },
    );

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(
        `Failed to delete OAuth application: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
  }
}
