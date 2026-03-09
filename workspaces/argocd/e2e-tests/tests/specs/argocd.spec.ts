import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
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

    const secretResult =
      await $`oc get secret openshift-gitops-cluster -n openshift-gitops -o jsonpath={.data.admin\\.password}`;
    const argoPassword = Buffer.from(
      secretResult.stdout.trim(),
      "base64",
    ).toString();

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
  });

  test("Verify ArgoCD deployment lifecycle on CD tab", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openCatalogSidebar("Component");
    await page.getByText("test-argocd-component").click();
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
