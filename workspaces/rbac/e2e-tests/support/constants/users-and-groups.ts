export type RbacUser = {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  groups: string[];
};

export type RBACGroup = {
  name: string;
  keycloak?: boolean;
};

/**
 * Users created in Keycloak for RBAC e2e tests.
 * Each key describes the scenario the user serves.
 *
 * - rbacAdmin:             RBAC plugin admin; configured as admin in app-config.
 * - noAccess:              No permissions; verifies RBAC sidebar hidden and direct nav blocked.
 * - tara:                  Fixture member used when constructing roles via the UI.
 * - jonathon:              Fixture member used when editing role membership via the UI.
 * - currentUserOwner:      Member of rhdh-qe-2-team. Tests $currentUser: can unregister own
 *                          components but not group-owned ones.
 * - conditionalManager:    Gets conditional RBAC manage permission via rbac-ownership-role
 *                          Used in the serial IsOwner suite.
 * - allowAllowUser:        catalog_reader. Both static allow AND conditional IS_ENTITY_OWNER
 *                          allow read — tests policyDecisionPrecedence allow+allow case.
 * - conditionalAllowUser:  Has static deny (all_resource_denier) but conditional policy allows
 *                          read — tests conditional overrides deny.
 * - conditionalDenyUser:   Has static allow but conditional deny wins — sees empty catalog.
 * - conditionalDenier:     all_resource_reader + conditional_denier roles — conditional deny
 *                          overrides static allow.
 * - childGroupMember:      Member of rhdh-qe-child-team. Tests transitive $ownerRefs: can read
 *                          components owned by the parent group rhdh-qe-parent-team.
 * - subChildGroupMember:   Member of rhdh-qe-sub-child-team. Tests deep transitive $ownerRefs:
 *                          can read components owned by parent and grandparent groups.
 *
 * Passwords are generated at module-load time using `crypto.randomUUID()` trimmed
 * to 21 characters with hyphens replaced by zeros.  This satisfies typical minimum
 * length and complexity requirements while staying fully random per test run.
 * The rbacAdmin password can be overridden via the `RBAC_ADMIN_PASSWORD` env var
 * so that a stable value can be used in CI where needed.
 */
export const RBAC_DESCRIPTIVE_USERS: Record<string, RbacUser> = {
  rbacAdmin: {
    username: "rbac-admin",
    firstName: "RBAC",
    lastName: "Admin",
    email: "rbac-admin@example.com",
    password:
      process.env.RBAC_ADMIN_PASSWORD ??
      crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  noAccess: {
    username: "no-access",
    firstName: "No",
    lastName: "Access",
    email: "no-access@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  tara: {
    username: "tara",
    firstName: "Tara",
    lastName: "MacGovern",
    email: "tara@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  jonathon: {
    username: "jonathon",
    firstName: "Jonathon",
    lastName: "Page",
    email: "jonathon@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  currentUserOwner: {
    username: "current-user-owner",
    firstName: "Current",
    lastName: "User-Owner",
    email: "current-user-owner@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: ["rhdh-qe-2-team"],
  },
  conditionalManager: {
    username: "conditional-manager",
    firstName: "Conditional",
    lastName: "Manager",
    email: "conditional-manager@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  allowAllowUser: {
    username: "allow-allow-user",
    firstName: "Allow",
    lastName: "Allow-User",
    email: "allow-allow-user@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  conditionalAllowUser: {
    username: "conditional-allow-user",
    firstName: "Conditional",
    lastName: "Allow-User",
    email: "conditional-allow-user@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  conditionalDenyUser: {
    username: "conditional-deny-user",
    firstName: "Conditional",
    lastName: "Deny-User",
    email: "conditional-deny-user@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  childGroupMember: {
    username: "child-group-member",
    firstName: "Child",
    lastName: "Group-Member",
    email: "child-group-member@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
  subChildGroupMember: {
    username: "sub-child-group-member",
    firstName: "Sub-Child",
    lastName: "Group-Member",
    email: "sub-child-group-member@example.com",
    password: crypto.randomUUID().substring(0, 21).replaceAll("-", "0"),
    groups: [],
  },
};

/**
 * Groups created in Keycloak for RBAC e2e tests.
 * The transitive parent/child/sub-child groups are not created via Keycloak
 * (configureForRHDH does not support sub-group membership); they are managed
 * separately in the catalog config.
 */
export const RBAC_GROUPS: Record<string, RBACGroup> = {
  backstage: { name: "backstage", keycloak: true },
  currentUserOwnerTeam: { name: "rhdh-qe-2-team", keycloak: true },
  rhdhParentTeam: { name: "rhdh-qe-parent-team" },
  rhdhChildTeam: { name: "rhdh-qe-child-team" },
  rhdhSubChildTeam: { name: "rhdh-qe-sub-child-team" },
};

/**
 * Returns the UI display name for a user in RBAC_DESCRIPTIVE_USERS.
 * Used when selecting members from the role creation/edit form dropdowns.
 */
export const displayName = (key: keyof typeof RBAC_DESCRIPTIVE_USERS): string =>
  `${RBAC_DESCRIPTIVE_USERS[key].firstName} ${RBAC_DESCRIPTIVE_USERS[key].lastName}`;

/** Returns the Backstage entity reference string for a given user, e.g. `user:default/rbac-admin`. */
export const userEntityRef = (user: RbacUser): string =>
  `user:default/${user.username}`;
