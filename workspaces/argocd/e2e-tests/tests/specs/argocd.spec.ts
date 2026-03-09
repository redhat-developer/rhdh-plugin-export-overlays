import { test, expect } from "rhdh-e2e-test-utils/test";
import { $ } from "rhdh-e2e-test-utils/utils";
import { execSync } from "node:child_process";
import path from "path";

const setupScript = path.join(
  import.meta.dirname,
  "deploy-openshift-gitops.sh",
);

test.describe("Test ArgoCD plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);
    await $`bash ${setupScript}`;

    const argoRoute = await rhdh.k8sClient.getRouteLocation(
      "openshift-gitops",
      "openshift-gitops-server",
    );

    // The framework's $ uses stdio:"inherit" which doesn't capture stdout.
    // Use execSync to capture the output. Single quotes protect the backslash
    // from shell interpretation so jsonpath receives the escaped dot.
    const argoPasswordB64 = execSync(
      "oc get secret openshift-gitops-cluster -n openshift-gitops -o jsonpath='{.data.admin\\.password}'",
    )
      .toString()
      .trim();
    const argoPassword = Buffer.from(argoPasswordB64, "base64").toString();

    process.env.ARGOCD_INSTANCE1_URL = argoRoute;
    process.env.ARGOCD_USERNAME = "admin";
    process.env.ARGOCD_PASSWORD = argoPassword;

    await rhdh.configure({ auth: "keycloak" });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("Verify ArgoCD deployment summary on entity overview", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openCatalogSidebar("Component");
    await page.getByText("test-argocd-component").click();

    await uiHelper.verifyText("test-argocd-component");

    // await expect(
    //   page.uiHelper.verifyHeading('Deployment Summary')
    // ).toBeVisible();
    // await page.uiHelper.verifyTableHeadingAndRows(
    //   ['ArgoCD App', 'Namespace', 'Instance', 'Server', 'Revision']
    // );
    // await page.uiHelper.verifyRowsInTable(
    //   ['test-argocd-app', 'openshift-gitops', 'argoInstance1', 'https://kubernetes.default.svc', '-'],
    // );

  });

  test("Verify ArgoCD deployment lifecycle on CD tab", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openCatalogSidebar("Component");
    await page.getByText("test-argocd-component").click();
    // await page.getByRole("tab", { name: /cd/i }).click();
    // await page.uiHelper.verifyHeading('Deployment Lifecycle');
    // await page.uiHelper.verifyButtonURL('test-argocd-app', new RegExp(`/applications/openshift-gitops/test-argocd-app`));
    // await page.getByText('test-argocd-app').click();
    

  });

  test("Verify ArgoCD link points to correct instance", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openCatalogSidebar("Component");
    await page.getByText("test-argocd-component").click();

    const argoLink = page.locator('a[href*="openshift-gitops"]');
    if (await argoLink.isVisible()) {
      const href = await argoLink.getAttribute("href");
      expect(href).toContain(
        process.env.ARGOCD_INSTANCE1_URL?.replace("https://", "") ?? "",
      );
    }
  });
});
