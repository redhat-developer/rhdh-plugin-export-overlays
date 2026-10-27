import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  $,
  WorkspacePaths,
  requireEnv,
} from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  CONFIG_DIR,
  gitlabHttpCodeFromHub,
  hubEnvVar,
  waitForGitlabDiscoveryScan,
} from "../config/gitlab-pqc/fixture.js";

/**
 * Experiment: force OpenSSL Groups=X25519MLKEM768 on the hub. Against a GitLab
 * that does not offer that group, hub→GitLab TLS must fail (contrast with
 * gitlab-pqc-baseline.spec.ts).
 */
test.describe("GitLab PQC (forced ML-KEM)", () => {
  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);

    requireEnv(
      "VAULT_GITLAB_HOST",
      "VAULT_PQC_GITLAB_ACCESS_TOKEN",
      "VAULT_PQC_GITLAB_USER",
    );

    const namespace = rhdh.deploymentConfig.namespace;
    const opensslConfigmapPath = WorkspacePaths.resolve(
      `${CONFIG_DIR}/openssl-pq-configmap.yaml`,
    );
    await $`kubectl apply -f ${opensslConfigmapPath} -n ${namespace}`;

    await rhdh.configure({
      auth: "guest",
      appConfig: `${CONFIG_DIR}/app-config-rhdh.yaml`,
      secrets: `${CONFIG_DIR}/rhdh-secrets.yaml`,
      dynamicPlugins: `${CONFIG_DIR}/dynamic-plugins.yaml`,
      valueFile: `${CONFIG_DIR}/values.yaml`,
      subscription: `${CONFIG_DIR}/subscription.yaml`,
    });

    await rhdh.deploy();
  });

  test("forced ML-KEM blocks hub→GitLab TLS", async ({ rhdh }) => {
    test.setTimeout(180_000);

    const namespace = rhdh.deploymentConfig.namespace;

    const conf = await hubEnvVar(namespace, "OPENSSL_CONF");
    expect(conf).toContain("openssl-pq.cnf");

    const logs = await waitForGitlabDiscoveryScan(namespace);
    expect(logs).toMatch(/Processed \d+ from scanned \d+ projects/);

    const tlsCode = await gitlabHttpCodeFromHub(namespace);
    expect(
      tlsCode,
      `expected GitLab TLS failure under forced ML-KEM, got HTTP ${tlsCode}`,
    ).toBe("000");
  });
});
