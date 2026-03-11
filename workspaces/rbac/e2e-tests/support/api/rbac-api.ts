import {
  PermissionAction,
  RoleConditionalPolicyDecision,
} from "@backstage-community/plugin-rbac-common";
import { APIRequestContext, APIResponse, request } from "@playwright/test";

export interface Policy {
  entityReference: string;
  permission: string;
  policy: string;
  effect: string;
}

/**
 * Thin HTTP client for the RHDH RBAC permission API.
 * Uses a static factory (`build`) because the Playwright `APIRequestContext`
 * must be created asynchronously — a constructor cannot await it.
 */
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

  /** Creates a fully-initialised instance with a live Playwright request context. */
  public static async build(token: string): Promise<RhdhRbacApi> {
    const instance = new RhdhRbacApi(token);
    instance.myContext = await request.newContext({
      baseURL: instance.apiUrl,
      extraHTTPHeaders: instance.authHeader,
    });
    return instance;
  }

  public async getPoliciesByRole(policy: string): Promise<APIResponse> {
    return await this.myContext.get(`policies/role/default/${policy}`);
  }

  /** Fetches all conditional policies across all roles. */
  public async getConditions(): Promise<APIResponse> {
    return await this.myContext.get(`roles/conditions`);
  }

  /** Filters a full conditions list down to those belonging to a specific role entity ref. */
  public async getConditionsByRole(
    role: string,
    remainingConditions: RoleConditionalPolicyDecision<PermissionAction>[],
  ): Promise<RoleConditionalPolicyDecision<PermissionAction>[]> {
    return remainingConditions.filter(
      (condition) => condition.roleEntityRef === role,
    );
  }

  public async deleteRole(role: string): Promise<APIResponse> {
    return await this.myContext.delete(`roles/role/default/${role}`);
  }

  public async deletePolicy(policy: string, policies: Policy[]) {
    return await this.myContext.delete(`policies/role/default/${policy}`, {
      data: policies,
    });
  }

  /** `id` comes from the `RoleConditionalPolicyDecision.id` field returned by the API. */
  public async deleteCondition(id: string): Promise<APIResponse> {
    return await this.myContext.delete(`roles/conditions/${id}`);
  }
}

export class Response {
  static async removeMetadataFromResponse(
    response: APIResponse,
  ): Promise<unknown[]> {
    const responseJson = await response.json();

    if (!Array.isArray(responseJson)) {
      throw new TypeError(
        `Expected an array from policy response but received: ${JSON.stringify(responseJson)}`,
      );
    }

    return responseJson.map((item: { metadata?: unknown }) => {
      delete item.metadata;
      return item;
    });
  }
}
