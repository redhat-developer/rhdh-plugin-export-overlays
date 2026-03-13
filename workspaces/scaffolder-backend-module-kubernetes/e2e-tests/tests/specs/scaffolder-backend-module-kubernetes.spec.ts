import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { KubeClient } from "../../support/utils/kube-client";

test.describe("Test Kubernetes Actions plugin", () => {
  let kubeClient: KubeClient;
  let namespace: string;

  test.beforeAll(async ({ rhdh }) => {
    kubeClient = new KubeClient();

    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh.yaml",
      secrets: "tests/config/rhdh-secrets.yaml",
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ page, uiHelper, loginHelper }, testInfo) => {
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.goToPageUrl("/create");

    // Add cool-down period before retries (except on first attempt)
    if (testInfo.retry > 0) {
      const coolDownMs = 2000;
      console.log(
        `Attempt ${testInfo.retry + 1} failed, waiting ${coolDownMs}ms before retry...`,
      );
      await page.waitForTimeout(coolDownMs);
    }
  });

  test.afterEach(async () => {
    await kubeClient.deleteNamespace(namespace);
  });

  test("Creates kubernetes namespace", async ({ page, uiHelper }) => {
    namespace = `test-kubernetes-actions-${Date.now()}`;
    await uiHelper.verifyHeading("Self-service");
    await uiHelper.clickBtnInCard("Create a kubernetes namespace", "Choose");
    await uiHelper.waitForTitle("Create a kubernetes namespace", 2);

    await uiHelper.fillTextInputByLabel("Namespace name", namespace);
    await uiHelper.checkCheckbox("Skip TLS verification");
    await expect(page.getByRole("button", { name: "Review" })).toBeEnabled();
    await uiHelper.clickButton("Review");
    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeVisible();
    await uiHelper.clickButton("Create");
    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeHidden();
    // Wait for creation process to complete (progressbar reaches 100%)
    await expect(
      page.getByRole("article").getByRole("progressbar").first(),
    ).toHaveAttribute("aria-valuenow", "100", { timeout: 5000 });
    await expect(page.getByText("second")).toBeVisible();
    // Verify no error occurred during creation
    await expect(page.getByRole("article").getByRole("alert")).toHaveCount(0);

    console.log(`Verifying namespace ${namespace} exists in Kubernetes API`);
    await expect
      .poll(() => kubeClient.getNamespaceByName({ name: namespace }), {
        timeout: 5000,
      })
      .toBeTruthy();
    console.log(`Namespace ${namespace} verified successfully`);
  });
});
