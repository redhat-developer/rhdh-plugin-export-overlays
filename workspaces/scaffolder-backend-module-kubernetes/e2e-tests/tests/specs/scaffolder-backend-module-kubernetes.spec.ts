import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { KubeClient } from "../../support/utils/kube-client";

test.describe("Test Kubernetes Actions plugin", () => {
  let kubeClient: KubeClient;
  let namespace: string | undefined;

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
    await uiHelper.dismissQuickstartIfVisible();

    // Add cool-down period before retries (except on first attempt)
    if (testInfo.retry > 0) {
      const coolDownMs = 2000;
      // eslint-disable-next-line playwright/no-wait-for-timeout -- deliberate cool-down between flaky-retry attempts
      await page.waitForTimeout(coolDownMs);
    }
  });

  test.afterEach(async () => {
    if (namespace) {
      await kubeClient.deleteNamespace(namespace);
      namespace = undefined;
    }
  });

  test("Creates kubernetes namespace", async ({ page, uiHelper }, testInfo) => {
    // Keep the name unique per project/worker/retry so parallel lanes (legacy +
    // app-next) never collide, while staying within the 63-char RFC 1123 limit.
    namespace =
      `tka-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`.slice(
        0,
        63,
      );
    // NFS app uses the scaffolder's default heading ("Create").
    await uiHelper.verifyHeading("Create");
    // Wait for the specific template card title to be visible (more specific than article,
    // avoids matching sidebar navigation which also contains template names)
    await page
      .getByRole("heading", { name: "Create a kubernetes namespace" })
      .waitFor({ state: "visible", timeout: 30000 });
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
    ).toBeHidden({ timeout: 120_000 });
    // Wait for creation process to complete (progressbar reaches 100%)
    await expect(
      page.getByRole("article").getByRole("progressbar").first(),
    ).toHaveAttribute("aria-valuenow", "100", { timeout: 120_000 });
    // Verify no error occurred during creation
    await expect(page.getByRole("article").getByRole("alert")).toHaveCount(0);

    await expect
      .poll(() => kubeClient.getNamespaceByName({ name: namespace! }), {
        timeout: 30_000,
      })
      .toBeTruthy();
  });
});
