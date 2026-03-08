import RhdhRbacApi, { Policy, Response } from "../../support/api/rbac-api";
import { RbacRef } from "../constants/roles";

export async function cleanupRoles(
  roles: Record<string, RbacRef>,
  apiToken: string,
): Promise<void> {
  // Some of the roles within the constant are not able to be deleted and will throw a
  // 403. We should skip them to avoid the noise
  const skippableRoles = ["rbac_admin", "guests"];
  const rbacApi = await RhdhRbacApi.build(apiToken);

  for (const role of Object.values(roles)) {
    if (skippableRoles.includes(role.name)) continue;
    try {
      // Step 1: check if role exists at all — if not, nothing to do
      const remainingPoliciesResponse = await rbacApi.getPoliciesByRole(
        role.name,
      );

      // Step 2: check if role has any conditional policies
      const conditionResponse = await rbacApi.getConditions();

      const remainingConditions = await rbacApi.getConditionsByRole(
        role.ref,
        await conditionResponse.json(),
      );

      if (
        remainingPoliciesResponse.status() === 404 &&
        remainingConditions.length === 0
      )
        continue;

      // Step 3: only attempt policy deletion if there are policies to delete
      if (remainingPoliciesResponse.ok()) {
        const remainingPolicies = await Response.removeMetadataFromResponse(
          remainingPoliciesResponse,
        );
        if (Array.isArray(remainingPolicies) && remainingPolicies.length > 0) {
          await rbacApi.deletePolicy(role.name, remainingPolicies as Policy[]);
        }
      }

      // Step 4: only attempt condition deletion if there are conditions to delete
      if (conditionResponse.ok()) {
        for (const condition of remainingConditions) {
          await rbacApi.deleteCondition(condition.id);
        }
      }

      // Step 5: delete the role itself — ignore 404 in case it was already gone
      const deleteRoleResponse = await rbacApi.deleteRole(role.name);
      if (!deleteRoleResponse.ok() && deleteRoleResponse.status() !== 404) {
        console.error(
          `Unexpected error deleting role ${role.name}: ${deleteRoleResponse.status()}`,
        );
      }
    } catch (error) {
      console.error(`Error during cleanup for role ${role.name}:`, error);
    }
  }
}
