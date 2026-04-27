export type RbacRef = {
  name: string;
  ref: string;
};

/**
 * All roles referenced by the RBAC e2e test suite.
 *
 * Note: `rbacAdmin` and `guest` are system-managed roles (sourced from app-config
 * and a CSV policy file respectively) and cannot be deleted via the API — they are
 * skipped during cleanup in `cleanupRoles`.
 */
export const RBAC_ROLES: Record<string, RbacRef> = {
  rbacOwnership: {
    name: "rbac-ownership-role",
    ref: "role:default/rbac-ownership-role",
  },
  rbacConditional: {
    name: "rbac-conditional-role",
    ref: "role:default/rbac-conditional-role",
  },
  conditionalResource: {
    name: "rbac-conditional-resource-role",
    ref: "role:default/rbac-conditional-resource-role",
  },
  overviewListEdit: {
    name: "rbac-list-edit-role",
    ref: "role:default/rbac-list-edit-role",
  },
  overviewMembers: {
    name: "rbac-overview-members-role",
    ref: "role:default/rbac-overview-members-role",
  },
  overviewPolicies: {
    name: "rbac-overview-policies-role",
    ref: "role:default/rbac-overview-policies-role",
  },
  rbacAdmin: {
    name: "rbac_admin",
    ref: "role:default/rbac_admin",
  },
  guest: {
    name: "guests",
    ref: "role:default/guests",
  },
};
