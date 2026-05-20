/** GitHub org for repos created in e2e (PRs, catalog-info). */
export const GITHUB_ORG = "janus-qe";

/** Env var names for GitHub login (values come from Vault / CI secrets). */
export const GITHUB_CREDENTIAL_ENV_KEYS = [
  "VAULT_GH_USER_ID",
  "VAULT_GH_USER_PASS",
  "GITHUB_USERNAME",
  "GITHUB_PASSWORD",
  "VAULT_GITHUB_USER_TOKEN",
] as const;
