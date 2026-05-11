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
   * Wait for an entity to exist in the catalog with polling
   */
  static async waitForEntity(
    baseUrl: string,
    token: string,
    kind: string,
    name: string,
    namespace = "default",
    timeoutMs = 60000,
    intervalMs = 2000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const entity = await this.getEntity(
          baseUrl,
          token,
          kind,
          name,
          namespace,
        );
        return entity;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("404"))) {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Timeout: Entity ${kind}:${namespace}/${name} did not appear within ${timeoutMs}ms`,
    );
  }

  /**
   * Wait for an entity to be removed from the catalog with polling
   */
  static async waitForEntityRemoval(
    baseUrl: string,
    token: string,
    kind: string,
    name: string,
    namespace = "default",
    timeoutMs = 60000,
    intervalMs = 2000,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const exists = await this.entityExists(
        baseUrl,
        token,
        kind,
        name,
        namespace,
      );
      if (!exists) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Timeout: Entity ${kind}:${namespace}/${name} was not removed within ${timeoutMs}ms`,
    );
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
