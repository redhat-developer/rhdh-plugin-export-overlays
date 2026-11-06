/**
 * Shared constants for the GitLab PQC (hybrid fallback) suite.
 *
 * Prefers X25519MLKEM768 with classical X25519 fallback. Org catalog sanity
 * reuses the auth-providers GitLab seed (same users/groups as gitlab-auth).
 * Against GitLab without hybrid support, entities must still ingest via X25519.
 */
export const CONFIG_DIR = "tests/config/gitlab-pqc-hybrid-fallback";
export const OPENSSL_CONFIGMAP_NAME = "openssl-pq";
export const OPENSSL_CNF_KEY = "openssl-pq.cnf";

export {
  GITLAB_AUTH_CATALOG_TOKEN,
  GITLAB_INGESTED_GROUPS,
  GITLAB_INGESTED_USERS,
} from "../../../support/constants/gitlab-auth.js";
