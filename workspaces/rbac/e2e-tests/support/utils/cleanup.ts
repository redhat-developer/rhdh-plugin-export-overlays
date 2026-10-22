import { APIResponse } from "@playwright/test";
import { RbacRef } from "../constants/roles";
import {
  PermissionAction,
  RoleConditionalPolicyDecision,
} from "@backstage-community/plugin-rbac-common";
import {
  RbacApiHelper,
  Policy,
  Response,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

// Roles that cannot be deleted and will throw a 403 — skip to avoid noise
const SKIPPABLE_ROLES: Set<string> = new Set([
  "rbac_admin",
  "guests",
  "default-role",
]);

async function deletePoliciesForRole(
  rbacApi: RbacApiHelper,
  roleName: string,
  policiesResponse: APIResponse,
): Promise<void> {
  if (!policiesResponse.ok()) return;
  const policies = await Response.removeMetadataFromResponse(policiesResponse);
  if (Array.isArray(policies) && policies.length > 0) {
    await rbacApi.deletePolicy(roleName, policies as Policy[]);
  }
}

async function deleteConditionsForRole(
  rbacApi: RbacApiHelper,
  conditionResponse: APIResponse,
  remainingConditions: RoleConditionalPolicyDecision<PermissionAction>[],
): Promise<void> {
  if (!conditionResponse.ok()) return;
  for (const condition of remainingConditions) {
    await rbacApi.deleteCondition(condition.id);
  }
}

async function cleanupRole(
  rbacApi: RbacApiHelper,
  role: RbacRef,
): Promise<void> {
  const policiesResponse = await rbacApi.getPoliciesByRole(role.name);
  const conditionResponse = await rbacApi.getConditions();
  const remainingConditions = await rbacApi.getConditionsByRole(
    role.ref,
    await conditionResponse.json(),
  );

  if (policiesResponse.status() === 404 && remainingConditions.length === 0) {
    return;
  }

  await deletePoliciesForRole(rbacApi, role.name, policiesResponse);
  await deleteConditionsForRole(
    rbacApi,
    conditionResponse,
    remainingConditions,
  );

  const deleteRoleResponse = await rbacApi.deleteRole(role.name);
  if (!deleteRoleResponse.ok() && deleteRoleResponse.status() !== 404) {
    console.error(
      `Unexpected error deleting role ${role.name}: ${deleteRoleResponse.status()}`,
    );
  }
}

export async function cleanupRoles(
  roles: Record<string, RbacRef>,
  apiToken: string,
): Promise<void> {
  const rbacApi = await RbacApiHelper.build(apiToken);

  for (const role of Object.values(roles)) {
    if (SKIPPABLE_ROLES.has(role.name)) continue;
    try {
      await cleanupRole(rbacApi, role);
    } catch (error) {
      console.error(`Error during cleanup for role ${role.name}:`, error);
    }
  }
}
