import RhdhRbacApi, { Policy, Response } from "../../support/api/rbac-api";
import { RbacRef } from "../constants/roles";

export async function cleanupRoles(
  roles: Record<string, RbacRef>,
  apiToken: string,
): Promise<void> {
  const rbacApi = await RhdhRbacApi.build(apiToken);

  for (const role of Object.values(roles)) {
    try {
      // Step 1: check if role exists at all — if not, nothing to do
      const remainingPoliciesResponse = await rbacApi.getPoliciesByRole(
        role.name,
      );
      if (remainingPoliciesResponse.status() === 404) continue;

      // Step 2: only attempt policy deletion if there are policies to delete
      if (remainingPoliciesResponse.ok()) {
        const remainingPolicies = await Response.removeMetadataFromResponse(
          remainingPoliciesResponse,
        );
        if (Array.isArray(remainingPolicies) && remainingPolicies.length > 0) {
          await rbacApi.deletePolicy(role.name, remainingPolicies as Policy[]);
        }
      }

      // Step 3: delete the role itself — ignore 404 in case it was already gone
      const deleteRoleResponse = await rbacApi.deleteRole(role.name);
      if (!deleteRoleResponse.ok() && deleteRoleResponse.status() !== 404) {
        console.error(
          `Unexpected error deleting role ${role}: ${deleteRoleResponse.status()}`,
        );
      }
    } catch (error) {
      console.error(`Error during cleanup for role ${role}:`, error);
    }
  }
}
