import { expect, request } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

/**
 * Helper class for making API calls to Catalog
 */
export class CatalogApiHelper {
  /**
   * Get a catalog entity by kind and name.
   */
  static async getEntity(
    baseUrl: string,
    token: string,
    kind: string,
    name: string,
    namespace = "default",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const context = await request.newContext({
      ignoreHTTPSErrors: true,
    });

    const url = `${baseUrl}/api/catalog/entities/by-name/${kind.toLowerCase()}/${namespace}/${name}`;
    const response = await context.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok()) {
      await context.dispose();
      throw new Error(
        `Failed to get ${kind} entity "${name}": ${response.status()} ${response.statusText()}`,
      );
    }

    const result = await response.json();
    await context.dispose();
    return result;
  }

  /**
   * Check whether an entity exists in the catalog.
   */
  static async entityExists(
    baseUrl: string,
    token: string,
    kind: string,
    name: string,
    namespace = "default",
  ): Promise<boolean> {
    try {
      await CatalogApiHelper.getEntity(baseUrl, token, kind, name, namespace);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get the description of a catalog entity.
   */
  static async getEntityDescription(
    baseUrl: string,
    token: string,
    kind: string,
    name: string,
    namespace = "default",
  ): Promise<string | undefined> {
    const entity = await CatalogApiHelper.getEntity(
      baseUrl,
      token,
      kind,
      name,
      namespace,
    );
    return entity.metadata?.description;
  }

  /**
   * Get a group entity from the RHDH catalog API
   */
  static async getGroupEntity(
    baseUrl: string,
    token: string,
    groupName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return CatalogApiHelper.getEntity(baseUrl, token, "group", groupName);
  }

  /**
   * Extract group members from a group entity
   */
  static async getGroupMembers(
    baseUrl: string,
    token: string,
    groupName: string,
  ): Promise<string[]> {
    const groupEntity = await CatalogApiHelper.getGroupEntity(
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
}

/**
 * Obtain a bearer token from the logged-in browser session.
 * Local implementation matching the shared package's getSessionAuthToken.
 */
export async function getSessionAuthToken(
  page: Page,
  uiHelper: UIhelper,
  baseUrl: string,
): Promise<string> {
  const authApiHelper = new AuthApiHelper(page);

  const readToken = async (): Promise<string | undefined> => {
    try {
      const value = await authApiHelper.getToken();
      return value?.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const existingToken = await readToken();
  if (existingToken) {
    return existingToken;
  }

  await page.goto(baseUrl);
  await uiHelper.waitForLoad();

  let token = "";
  await expect
    .poll(
      async () => {
        const value = await readToken();
        if (value) {
          token = value;
          return true;
        }
        return false;
      },
      {
        message: "Token should be retrieved after session is established",
        timeout: 30_000,
        intervals: [2_000],
      },
    )
    .toBe(true);

  return token;
}
