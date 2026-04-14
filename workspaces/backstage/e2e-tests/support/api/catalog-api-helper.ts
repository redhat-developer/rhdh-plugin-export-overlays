import { request } from "@playwright/test";
/**
 * Helper class for making API calls to Catalog
 */
export class CatalogApiHelper {
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
