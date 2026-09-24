/** Static catalog token from tests/config/gitlab-auth/value-file.yaml */
export const GITLAB_AUTH_CATALOG_TOKEN = "gitlab-auth-e2e-token";

/** Display names expected after GitLab org ingestion (core auth-providers suite). */
export const GITLAB_INGESTED_USERS = [
  "user1",
  "user2",
  "user3",
  "Administrator",
] as const;

export const GITLAB_INGESTED_GROUPS = [
  "my-org",
  "group1",
  "all",
  "nested",
  "nested_2",
] as const;

export const GITLAB_LOGIN_USER = "user1";
