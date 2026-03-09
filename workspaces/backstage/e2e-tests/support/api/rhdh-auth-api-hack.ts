import { Page } from "@playwright/test";

// here, we spy on the request to get the Backstage token to use APIs
export class RhdhAuthApiHack {
  static async getToken(page: Page, provider: "oidc" = "oidc", environment: string = "production") {
    try {
      const response = await page.request.get(
        `/api/auth/${provider}/refresh?optional=&scope=&env=${environment}`,
        {
          headers: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            "x-requested-with": "XMLHttpRequest",
          },
        },
      );

      if (!response.ok()) {
        throw new Error(`HTTP error! Status: ${response.status()}`);
      }

      const body = await response.json();

      if (
        typeof body?.backstageIdentity?.token === "string"
      ) {
        return body.backstageIdentity.token;
      } else {
        throw new TypeError("Token not found in response body");
      }
    } catch (error) {
      console.error("Failed to retrieve the token:", error);

      throw error;
    }
  }
}