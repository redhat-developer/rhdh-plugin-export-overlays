/** Static catalog token from tests/config/github-auth/value-file.yaml */
export const GITHUB_AUTH_CATALOG_TOKEN = "github-auth-e2e-token";

/** Login failure when sign-in resolver cannot match a catalog User entity. */
export const NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE =
  /Login failed; caused by Error: Failed to sign-in, unable to resolve user identity. Please verify that your catalog contains the expected User entities that would match your configured sign-in resolver./u;

/** Display names expected after GitHub org ingestion (core auth-providers suite). */
export const GITHUB_INGESTED_USERS = [
  "RHDH QE User 1",
  "RHDH QE Admin",
] as const;

export const GITHUB_INGESTED_GROUPS = [
  "test_admins",
  "test_all",
  "test_users",
] as const;

export const GITHUB_LOGIN_USERS = {
  admin: "rhdhqeauthadmin",
  user: "rhdhqeauth1",
} as const;

/** Custom annotation added by the github-org transformer used in core. */
export const GITHUB_CUSTOM_ANNOTATION = "MY_CUSTOM_ANNOTATION";
