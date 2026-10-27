import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  CONFIG_DIR,
  gitlabHttpCodeFromHub,
  waitForGitlabDiscoveryScan,
} from "../config/gitlab-pqc/fixture.js";

/**
 * Control: same GitLab plugin config as the forced-ML-KEM suite, but without
 * OPENSSL_CONF. Proves discovery can scan and hub→GitLab TLS works when not
 * restricted to ML-KEM.
 */
test.describe("GitLab PQC baseline (no forced ML-KEM)", () => {
  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);

    requireEnv(
      "VAULT_GITLAB_HOST",
      "VAULT_PQC_GITLAB_ACCESS_TOKEN",
      "VAULT_PQC_GITLAB_USER",
    );

    await rhdh.configure({
      auth: "guest",
      appConfig: `${CONFIG_DIR}/app-config-rhdh.yaml`,
      secrets: `${CONFIG_DIR}/rhdh-secrets.yaml`,
      dynamicPlugins: `${CONFIG_DIR}/dynamic-plugins.yaml`,
    });

    await rhdh.deploy();
  });

  test("hub reaches GitLab without forced ML-KEM", async ({ rhdh }) => {
    test.setTimeout(180_000);

    const namespace = rhdh.deploymentConfig.namespace;

    const logs = await waitForGitlabDiscoveryScan(namespace);
    expect(logs).toMatch(/Processed \d+ from scanned \d+ projects/);

    const httpCode = await gitlabHttpCodeFromHub(namespace);
    expect(
      httpCode,
      `expected hub to GitLab TLS/HTTP success, got HTTP ${httpCode}`,
    ).toMatch(/^2\d\d$/);
  });
});
