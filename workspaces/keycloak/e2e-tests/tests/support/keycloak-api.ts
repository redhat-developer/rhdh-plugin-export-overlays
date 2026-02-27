/**
 * Keycloak API helper for overlay e2e tests.
 * Uses plain env vars: KEYCLOAK_BASE_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET.
 * Align with deployment secrets (no base64).
 */

export interface KeycloakUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface KeycloakGroup {
  id: string;
  name: string;
  path: string;
}

// OAuth2 / Keycloak API uses snake_case; disable naming-convention for this interface
/* eslint-disable @typescript-eslint/naming-convention */
interface AuthResponse {
  access_token: string;
}
/* eslint-enable @typescript-eslint/naming-convention */

export class KeycloakAPI {
  private readonly baseURL: string;
  private readonly realm: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor() {
    const baseURL = process.env.KEYCLOAK_BASE_URL;
    const realm = process.env.KEYCLOAK_REALM;
    const clientId = process.env.KEYCLOAK_CLIENT_ID;
    const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
    if (!baseURL || !realm || !clientId || !clientSecret) {
      throw new Error(
        "Keycloak API requires KEYCLOAK_BASE_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET",
      );
    }
    this.baseURL = baseURL.replace(/\/$/, "");
    this.realm = realm;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /**
   * Get token via client_credentials.
   * Uses /auth/ path for compatibility with Keycloak instances used by RHDH deployment.
   */
  async getAuthenticationToken(): Promise<string> {
    const url = `${this.baseURL}/auth/realms/${this.realm}/protocol/openid-connect/token`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        /* eslint-disable @typescript-eslint/naming-convention */
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        /* eslint-enable @typescript-eslint/naming-convention */
      }).toString(),
    });

    if (response.status !== 200) {
      const text = await response.text();
      throw new Error(`Failed to authenticate: ${response.status} - ${text}`);
    }
    const data = (await response.json()) as AuthResponse;
    return data.access_token;
  }

  async getUsers(authToken: string): Promise<KeycloakUser[]> {
    const url = `${this.baseURL}/auth/admin/realms/${this.realm}/users`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (response.status !== 200) {
      const errorText = await response.text();
      throw new Error(`Failed to get users: ${response.status} - ${errorText}`);
    }
    const raw = (await response.json()) as Array<{
      id: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
    }>;
    return raw.map((u) => ({
      id: u.id,
      username: u.username ?? "",
      firstName: u.firstName ?? "",
      lastName: u.lastName ?? "",
      email: u.email ?? "",
    }));
  }

  async getGroupsOfUser(
    authToken: string,
    userId: string,
  ): Promise<KeycloakGroup[]> {
    const url = `${this.baseURL}/auth/admin/realms/${this.realm}/users/${userId}/groups`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (response.status !== 200) {
      const errorText = await response.text();
      throw new Error(
        `Failed to get groups of user: ${response.status} - ${errorText}`,
      );
    }
    const raw = (await response.json()) as Array<{
      id: string;
      name?: string;
      path?: string;
    }>;
    return raw.map((g) => ({
      id: g.id,
      name: g.name ?? "",
      path: g.path ?? "",
    }));
  }
}
