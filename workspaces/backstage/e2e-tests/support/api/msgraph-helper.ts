import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";

interface AzureApplicationWeb {
  redirectUris?: string[];
}

interface AzureApplicationResponse {
  web?: AzureApplicationWeb;
}

function isAzureApplicationResponse(
  value: unknown,
): value is AzureApplicationResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (!("web" in value) ||
      typeof (value as Record<string, unknown>).web === "object")
  );
}

/**
 * Microsoft Graph client for Azure App Registration redirect URI management.
 * Ported from RHDH core e2e (msgraph-helper) — redirect URL methods only.
 */
export class MSClient {
  private clientSecretCredential: ClientSecretCredential | undefined;
  private appClient: Client | undefined;
  private readonly clientId: string;
  private readonly tenantId: string;
  private readonly clientSecret: string;

  constructor(clientId: string, clientSecret: string, tenantId: string) {
    if (!clientId || !tenantId || !clientSecret) {
      throw new Error("Client ID, Tenant ID, and Client Secret are required");
    }
    this.clientId = clientId;
    this.tenantId = tenantId;
    this.clientSecret = clientSecret;
  }

  private getAppClient(): Client {
    this.clientSecretCredential ??= new ClientSecretCredential(
      this.tenantId,
      this.clientId,
      this.clientSecret,
    );

    if (!this.appClient) {
      const authProvider = new TokenCredentialAuthenticationProvider(
        this.clientSecretCredential,
        { scopes: ["https://graph.microsoft.com/.default"] },
      );
      this.appClient = Client.initWithMiddleware({ authProvider });
    }
    return this.appClient;
  }

  async getAppRedirectUrlsAsync(): Promise<string[]> {
    const app: unknown = await this.getAppClient()
      .api(`/applications(appId='{${this.clientId}}')`)
      .get();
    if (!isAzureApplicationResponse(app)) {
      throw new Error(
        "Microsoft Graph application response missing expected web.redirectUris shape",
      );
    }
    return app.web?.redirectUris ?? [];
  }

  async addAppRedirectUrlsAsync(redirectUrls: string[]): Promise<void> {
    const currentUrls = await this.getAppRedirectUrlsAsync();
    const newUrls = [...new Set([...currentUrls, ...redirectUrls])];
    await this.getAppClient()
      .api(`/applications(appId='{${this.clientId}}')`)
      .update({ web: { redirectUris: newUrls } });
  }

  async removeAppRedirectUrlsAsync(redirectUrls: string[]): Promise<void> {
    const currentUrls = await this.getAppRedirectUrlsAsync();
    const newUrls = currentUrls.filter((url) => !redirectUrls.includes(url));
    await this.getAppClient()
      .api(`/applications(appId='{${this.clientId}}')`)
      .update({ web: { redirectUris: newUrls } });
  }
}
