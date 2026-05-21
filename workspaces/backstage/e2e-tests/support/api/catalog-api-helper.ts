import { request } from "@playwright/test";

/**
 * Helper class for making API calls to Catalog
 */
export class CatalogApiHelper {
  /**
   * Check if an entity exists in the RHDH catalog API
   */
  static async entityExists(
    baseUrl: string,
    token: string,
    kind: string,
    name: string,
    namespace = "default",
  ): Promise<boolean> {
    try {
      await this.getEntity(baseUrl, token, kind, name, namespace);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get an entity from the RHDH catalog API
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
      throw new Error(
        `Failed to get ${kind} entity "${name}": ${response.status()} ${response.statusText()}`,
      );
    }

    return await response.json();
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
