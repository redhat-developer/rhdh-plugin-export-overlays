import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  WorkspacePaths,
  requireEnv,
} from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  checkUserDisplayNamesInCatalog,
} from "../../support/api/catalog-query-helpers.js";
import {
  CONFIG_DIR,
  GITLAB_AUTH_CATALOG_TOKEN,
  GITLAB_INGESTED_USERS,
  OPENSSL_CNF_KEY,
  OPENSSL_CONFIGMAP_NAME,
} from "../config/gitlab-pqc/fixture.js";

/**
 * Force OpenSSL Groups=X25519MLKEM768 on the hub. Until GitLab supports that
 * group, org catalog ingestion (same seed as gitlab-auth) must not succeed.
 */
test.describe("GitLab PQC (forced ML-KEM)", () => {
  let baseUrl: string;

  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);

    requireEnv(
      "VAULT_AUTH_PROVIDERS_GITLAB_HOST",
      "VAULT_AUTH_PROVIDERS_GITLAB_TOKEN",
      "VAULT_AUTH_PROVIDERS_GITLAB_PARENT_ORG",
    );

    const namespace = rhdh.deploymentConfig.namespace;
    await rhdh.k8sClient.createNamespaceIfNotExists(namespace);
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

  test("should sync catalog when ML-KEM algorithms are forced in OpenSSL", async () => {
    test.setTimeout(180_000);

    // Temporary until the GitLab is upgraded (assert users are absent).
    await expect(async () => {
      const usersPresent = await checkUserDisplayNamesInCatalog(
        baseUrl,
        GITLAB_AUTH_CATALOG_TOKEN,
        [...GITLAB_INGESTED_USERS],
      );
      expect(usersPresent).toBe(false);
    }).toPass({ timeout: 120_000, intervals: [3_000] });
  });
});
