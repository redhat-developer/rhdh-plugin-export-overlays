export type RbacRef = {
  name: string;
  ref: string;
};

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
  test2Role: {
    name: "test2-role",
    ref: "role:default/test2-role",
  },
  catalogReader: {
    name: "catalog_reader",
    ref: "role:default/catalog_reader",
  },
};
