import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { KUBERNETES_COMPONENTS } from "../../support/pages/kubernetes-po";
import { KubernetesPage } from "../../support/pages/kubernetes";
import { RbacKeycloakHelper } from "../../support/api/rbac-keycloak-helper";
import { KUBERNETES_USERS } from "../../support/constants/kubernetes/users";

const rbacConfigsPath = path.resolve(
  process.cwd(),
  "tests/config/kubernetes/rbac/",
);

const resourcesConfigsPath = path.resolve(
  process.cwd(),
  "tests/config/kubernetes/resources/",
);

test.describe("Kubernetes", () => {
  let kubernetesPage: KubernetesPage;
  let clusterName: string;

  test.beforeAll(async ({ rhdh }) => {
    const namespace = rhdh.deploymentConfig.namespace;

    // Setup Cluster Service Account
    await $`kubectl apply -f ${rbacConfigsPath}/service-account.yaml -n ${namespace}`;
    await $`kubectl apply -f ${rbacConfigsPath}/service-account-secret.yaml -n ${namespace}`;

    // Setup ClusterRoles and ClusterRoleBindings
    await $`kubectl apply -f ${rbacConfigsPath}/cluster-role-k8s.yaml -n ${namespace}`;
    await $`kubectl apply -f ${rbacConfigsPath}/cluster-role-binding-k8s.yaml -n ${namespace}`;

    // Setup Kubernetes test resources
    await $`kubectl apply -f ${resourcesConfigsPath}/kubernetes-test.yaml -n ${namespace}`;
    await $`kubectl apply -f ${resourcesConfigsPath}/kubernetes-test-ingress.yaml -n ${namespace}`;

    // Setup variables
    const clusterUrl = execSync(
      "kubectl config view --minify -o jsonpath={.clusters[0].cluster.server}",
      { encoding: "utf8" },
    ).trim();
    const tokenB64 = execSync(
      `kubectl -n ${namespace} get secret rhdh-k8s-plugin-secret -o jsonpath={.data.token}`,
      { encoding: "utf8" },
    ).trim();
    process.env.K8S_CLUSTER_URL = clusterUrl;
    process.env.K8S_CLUSTER_NAME ??= "test-cluster";
    clusterName = process.env.K8S_CLUSTER_NAME;
    process.env.K8S_CLUSTER_TOKEN = Buffer.from(tokenB64, "base64")
      .toString("utf8")
      .trim();

    // Setup users
    const keycloak = new RbacKeycloakHelper();
    await keycloak.createUsers(Object.values(KUBERNETES_USERS));
    // Setup RHDH RBAC permissions
    await $`kubectl apply -f ${rbacConfigsPath}/rbac-configmap.yaml -n ${namespace}`;

    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/kubernetes/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/kubernetes/dynamic-plugins.yaml",
      secrets: "tests/config/kubernetes/rhdh-secrets.yaml",
      valueFile: "tests/config/kubernetes/value_file.yaml",
    });

    await rhdh.deploy();
  });

  test.beforeEach(async ({ page }) => {
    kubernetesPage = new KubernetesPage(page);
  });

  test.describe("Verify that a user with permissions is able to access the Kubernetes plugin", () => {
    test.beforeEach(async ({ page, loginHelper }) => {
      await loginHelper.loginAsKeycloakUser(
        KUBERNETES_USERS.kubernetesLogsReader.username,
        KUBERNETES_USERS.kubernetesLogsReader.password,
      );
      await kubernetesPage.navigateToTabForComponent("Red Hat Developer Hub");

      await page
        .locator(KUBERNETES_COMPONENTS.MuiAccordion)
        .getByRole("button", { name: `${clusterName} Cluster` })
        .click();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify pods visibility in the Kubernetes tab", async () => {
      await kubernetesPage.verifyDeployment("kubernetes-test");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify pod logs visibility in the Kubernetes tab", async () => {
      await kubernetesPage.verifyPodLogs(
        "kubernetes-test",
        "kubernetes-test",
        true,
      );
    });
  });

  test.describe("Verify that a user without permissions is not able to access parts of the Kubernetes plugin", () => {
    // User is able to read from the catalog
    // User is unable to read kubernetes resources / clusters and use kubernetes proxy (needed for pod logs)
    test("Verify pods are not visible in the Kubernetes tab", async ({
      page,
      loginHelper,
    }) => {
      await loginHelper.loginAsKeycloakUser(
        KUBERNETES_USERS.noKubernetesAccess.username,
        KUBERNETES_USERS.noKubernetesAccess.password,
      );
      await kubernetesPage.navigateToTabForComponent("Red Hat Developer Hub");

      await expect(
        page.locator("h6").filter({ hasText: "Warning: Permission required" }),
      ).toBeVisible();
    });

    // User is able to read from the catalog and read kubernetes resources and kubernetes clusters
    // User is unable to use kubernetes proxy (needed for pod logs)
    // eslint-disable-next-line playwright/expect-expect
    test("Verify pod logs are not visible in the Kubernetes tab", async ({
      page,
      loginHelper,
    }) => {
      await loginHelper.loginAsKeycloakUser(
        KUBERNETES_USERS.kubernetesReader.username,
        KUBERNETES_USERS.kubernetesReader.password,
      );
      await kubernetesPage.navigateToTabForComponent("Red Hat Developer Hub");

      await page
        .locator(KUBERNETES_COMPONENTS.MuiAccordion)
        .getByRole("button", { name: `${clusterName} Cluster` })
        .click();
      await kubernetesPage.verifyPodLogs("kubernetes-test", "kubernetes-test");
    });
  });
});
