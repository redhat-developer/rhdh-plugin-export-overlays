/**
 * Shared constants for the GitLab PQC (forced ML-KEM) suite.
 *
 * Org catalog sanity reuses the auth-providers GitLab seed (same users/groups
 * as gitlab-auth). Under forced ML-KEM those entities must still ingest.
 */
export const CONFIG_DIR = "tests/config/gitlab-pqc";
export const OPENSSL_CONFIGMAP_NAME = "openssl-pq";
export const OPENSSL_CNF_KEY = "openssl-pq.cnf";

export {
  GITLAB_AUTH_CATALOG_TOKEN,
  GITLAB_INGESTED_GROUPS,
  GITLAB_INGESTED_USERS,
} from "../../../support/constants/gitlab-auth.js";
