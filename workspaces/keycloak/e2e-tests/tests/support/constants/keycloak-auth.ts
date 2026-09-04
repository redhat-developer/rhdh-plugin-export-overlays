import {
  DEFAULT_GROUPS,
  DEFAULT_USERS,
} from "@red-hat-developer-hub/e2e-test-utils/keycloak";

/** Static token from tests/config/keycloak-auth/value-file.yaml */
export const KEYCLOAK_CATALOG_TOKEN = "keycloak-auth-e2e-token";

function defaultAuthUser(username: string) {
  const seed = DEFAULT_USERS.find((user) => user.username === username);
  if (!seed) {
    throw new Error(`No DEFAULT_USERS entry for ${username}`);
  }
  return {
    username: seed.username,
    password: seed.password,
    email: seed.email,
    firstName: seed.firstName,
    lastName: seed.lastName,
    displayName: `${seed.firstName ?? ""} ${seed.lastName ?? ""}`.trim(),
  };
}

/** Default users from e2e-test-utils Keycloak (configureForRHDH). */
export const KEYCLOAK_AUTH_USERS = {
  test1: defaultAuthUser("test1"),
  test2: defaultAuthUser("test2"),
  /**
   * Username ≠ email local-part so emailLocalPartMatchingUserEntityName fails
   * unless dangerouslyAllowSignInWithoutUserInCatalog is set.
   */
  mismatch: {
    username: "mismatchuser",
    password: "mismatch@123",
    email: "nomatch@example.com",
    firstName: "Mismatch",
    lastName: "User",
    displayName: "Mismatch User",
  },
} as const;

export const KEYCLOAK_AUTH_CONFIG_DIR = "tests/config/keycloak-auth";

/** Sign-in alert when resolver cannot match a catalog User. */
export const NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE =
  /Login failed;\s*caused by Error: Failed to sign-in, unable to resolve user identity/i;

export const KEYCLOAK_REFRESH_COOKIE = "keycloak-refresh-token";

export const KEYCLOAK_DEFAULT_GROUPS = DEFAULT_GROUPS.map(
  (group) => group.name,
);

/** Seeded in beforeAll for sanitize[User/Group]NameTransformer coverage (RHDH oidc.spec.ts). */
export const KEYCLOAK_INGESTION_INVALID = {
  user: {
    // Keycloak rejects spaces; @ is invalid for catalog names and is sanitized on ingest.
    username: "invalid@user",
    firstName: "Invalid",
    lastName: "Username",
    email: "invalid.username@example.com",
    password: "invalid@123",
    displayName: "Invalid Username",
    /** Expected catalog User metadata.name after sanitizeUserNameTransformer. */
    catalogEntityName: "invalid-user",
  },
  group: {
    name: "invalid@groupname",
    /** Expected catalog Group metadata.name after sanitizeGroupNameTransformer. */
    catalogEntityName: "invalid-groupname",
  },
} as const;
