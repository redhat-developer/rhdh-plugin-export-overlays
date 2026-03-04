import { APIRequestContext, APIResponse, request } from "@playwright/test";

export interface Policy {
  entityReference: string;
  permission: string;
  policy: string;
  effect: string;
}

export default class RhdhRbacApi {
  private readonly apiUrl = process.env.RHDH_BASE_URL + "/api/permission/";
  private readonly authHeader: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Accept: "application/json";
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Authorization: string;
  };
  private myContext!: APIRequestContext;

  private constructor(private readonly token: string) {
    this.authHeader = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
  }

  public static async build(token: string): Promise<RhdhRbacApi> {
    const instance = new RhdhRbacApi(token);
    instance.myContext = await request.newContext({
      baseURL: instance.apiUrl,
      extraHTTPHeaders: instance.authHeader,
    });
    return instance;
  }

  // Used during the afterAll to ensure we clean up any policies that are left over due to failing tests
  public async getPoliciesByRole(policy: string): Promise<APIResponse> {
    return await this.myContext.get(`policies/role/default/${policy}`);
  }

  // Used during the afterAll to ensure we clean up any roles that are left over due to failing tests
  public async deleteRole(role: string): Promise<APIResponse> {
    return await this.myContext.delete(`roles/role/default/${role}`);
  }

  // Used during the afterAll to ensure we clean up any policies that are left over due to failing tests
  public async deletePolicy(policy: string, policies: Policy[]) {
    return await this.myContext.delete(`policies/role/default/${policy}`, {
      data: policies,
    });
  }
}

export class Response {
  static async removeMetadataFromResponse(
    response: APIResponse,
  ): Promise<unknown[]> {
    try {
      const responseJson = await response.json();

      // Validate that the response is an array
      if (!Array.isArray(responseJson)) {
        console.warn(
          `Expected an array but received: ${JSON.stringify(responseJson)}`,
        );
        return []; // Return an empty array as a fallback
      }

      // Clean metadata from the response
      const responseClean = responseJson.map((item: { metadata: unknown }) => {
        if (item.metadata) {
          delete item.metadata;
        }
        return item;
      });

      return responseClean;
    } catch (error) {
      console.error("Error processing API response:", error);
      throw new Error("Failed to process the API response");
    }
  }
}
