import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";

import { checkUserDisplayNamesInCatalog } from "../../support/api/catalog-query-helpers.js";
import {
  CATALOG_TOKEN,
  CONFIG_DIR,
  LDAP_SEED_USERS,
  OPENSSL_CNF_KEY,
  OPENSSL_CONFIGMAP_NAME,
} from "../config/ldap-pqc/fixture.js";

/**
 * Force OpenSSL Groups=X25519MLKEM768 on the hub and point the LDAP catalog
 * client at ldaps:// (app-config target). Peer is quay.io/rhdh-test/security:openldap-ubi10.2
 * (UBI 10.2 / OpenSSL 3.5 slapd). Same seed as ldap-auth; ingest must not
 * succeed until the peer completes that TLS path under forced ML-KEM.
 *
 * Behavioral force check — not a negotiated-group handshake log assert.
 *
 * Temporary: OpenLDAP is not deployed by this suite — provide a Ready Service
 * `openldap` (port 1389, helper-compatible bind/seed) in the project namespace.
 */
test.describe("LDAP PQC (forced ML-KEM)", () => {
  let baseUrl: string;

  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);

    test.info().annotations.push({
      type: "component",
      description: "authentication",
    });

    const namespace = rhdh.deploymentConfig.namespace;
    await rhdh.k8sClient.createNamespaceIfNotExists(namespace);

    // Assumes a manually deployed OpenLDAP (Service name `openldap`, port 1389).
    process.env.LDAP_TARGET_URL = `ldaps://openldap.${namespace}.svc.cluster.local:1389`;
    process.env.LDAP_BIND_DN = "cn=admin,dc=rhdh,dc=test";
    process.env.LDAP_BIND_SECRET = "user1pass";
    process.env.LDAP_USERS_DN = "ou=users,dc=rhdh,dc=test";
    process.env.LDAP_GROUPS_DN = "ou=groups,dc=rhdh,dc=test";
    expect(process.env.LDAP_TARGET_URL).toMatch(/^ldaps:\/\//);

    await rhdh.k8sClient.createOrUpdateConfigMap(
      OPENSSL_CONFIGMAP_NAME,
      namespace,
      WorkspacePaths.resolve(`${CONFIG_DIR}/openssl-pq.cnf`),
      OPENSSL_CNF_KEY,
    );

    await rhdh.configure({
      auth: "guest",
      appConfig: `${CONFIG_DIR}/app-config-rhdh.yaml`,
      secrets: `${CONFIG_DIR}/rhdh-secrets.yaml`,
      dynamicPlugins: `${CONFIG_DIR}/dynamic-plugins.yaml`,
      valueFile: `${CONFIG_DIR}/values.yaml`,
      subscription: `${CONFIG_DIR}/subscription.yaml`,
    });

    await rhdh.deploy();
    baseUrl = rhdh.rhdhUrl;
  });

  test.afterAll(async () => {
    await CatalogApiHelper.dispose();
  });

  test("catalog ingest under forced ML-KEM over ldaps", async () => {
    test.setTimeout(180_000);

    // Temporary until the LDAP TLS peer offers X25519MLKEM768 (assert users absent).
    await expect(async () => {
      const usersPresent = await checkUserDisplayNamesInCatalog(
        baseUrl,
        CATALOG_TOKEN,
        [...LDAP_SEED_USERS],
      );
      expect(usersPresent).toBe(false);
    }).toPass({ timeout: 120_000, intervals: [3_000] });
  });
});
