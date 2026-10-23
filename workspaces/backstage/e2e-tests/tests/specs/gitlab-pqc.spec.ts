import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  $,
  WorkspacePaths,
  requireEnv,
} from "@red-hat-developer-hub/e2e-test-utils/utils";

const CONFIG_DIR = "tests/config/gitlab-pqc";

test.describe("GitLab PQC (forced ML-KEM)", () => {
  test.beforeAll(async ({ rhdh }) => {
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

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsGuest();
  });

  test("RHDH stays up under forced ML-KEM and Catalog is reachable", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.dismissQuickstartIfVisible();
    await expect(
      page.getByRole("textbox", { name: "Search" }),
    ).toBeVisible();
  });
});
