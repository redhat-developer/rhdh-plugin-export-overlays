/**
 * Shared constants for the LDAP PQC (forced ML-KEM) suite.
 *
 * Catalog sanity reuses the OpenLDAP seed users from ldap-auth. Under forced
 * ML-KEM against a peer that cannot complete that TLS path, those entities
 * must not ingest until the LDAP TLS peer offers a hybrid group.
 *
 * Peer image: OpenLDAP on UBI 10.2 / OpenSSL 3.5 (built from ldap-pqc/openldap/).
 * @see https://quay.io/repository/rhdh-test/security/tag/openldap-ubi10.2
 */
export const CONFIG_DIR = "tests/config/ldap-pqc";
export const OPENSSL_CONFIGMAP_NAME = "openssl-pq";
export const OPENSSL_CNF_KEY = "openssl-pq.cnf";

/** quay.io/rhdh-test/security:openldap-ubi10.2 */
export const OPENLDAP_PQ_IMAGE_REPOSITORY = "quay.io/rhdh-test/security";
export const OPENLDAP_PQ_IMAGE_TAG = "openldap-ubi10.2";

/** Static token from tests/config/ldap-pqc/app-config-rhdh.yaml */
export const CATALOG_TOKEN = "ldap-pqc-e2e-token";

export const LDAP_SEED_USERS = [
  "User 1",
  "User 2",
  "User 3",
  "RHDH Admin",
] as const;
