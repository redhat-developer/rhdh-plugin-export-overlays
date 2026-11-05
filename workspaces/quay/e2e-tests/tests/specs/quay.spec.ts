import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { ImageRegistry } from "../utils/image-registry";
import { QuayClient } from "../utils/quay-client";

/** NFS places Quay under the Development entity-content group (title "Quay"). */
async function openQuayEntityTab(
  page: Page,
  uiHelper: UIhelper,
): Promise<void> {
  await uiHelper.openCatalogSidebar("Component");
  await uiHelper.searchInputPlaceholder("Developer Hub");
  await uiHelper.clickLink("Red Hat Developer Hub");
  // Same pattern as argocd #3478 e2e fix (group button + menuitemradio).
  await uiHelper.clickButtonByLabel("Development");
  await page.getByRole("menuitemradio", { name: "Quay" }).click();
}

test.describe("Test Quay.io plugin", () => {
  const quayRepository = "rhdh-community/rhdh";

  test.beforeAll(async ({ rhdh }) => {
    // Community plugins publish to ghcr.io; nightly mode resolves {{inherit}} to RHEC by default.
    // Remove when these community packages are no longer in default.packages.yaml in the rhdh repo.
    const ghcrRegistry = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays";
    process.env.NIGHTLY_DPDY_OCI_REGISTRY_MAP = JSON.stringify({
      [ghcrRegistry]: [
        "@backstage-community/plugin-quay",
        "@backstage-community/plugin-quay-backend",
        "@backstage-community/plugin-scaffolder-backend-module-quay",
      ],
    });
    await rhdh.configure({ auth: "guest" });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsGuest();
  });

  test.describe("Quay entity tab", () => {
    test.beforeEach(async ({ page, uiHelper }) => {
      await openQuayEntityTab(page, uiHelper);
    });

    test("Check if Quay tab is present", async ({ page, uiHelper }) => {
      await uiHelper.verifyHeading(quayRepository);

      const allGridColumnsText = ImageRegistry.getAllGridColumnsText();

      // Verify Headers
      for (const column of allGridColumnsText) {
        const columnLocator = page
          .getByRole("columnheader")
          .filter({ hasText: column });
        await expect(columnLocator).toBeVisible();
      }

      await page.getByTestId("quay-repo-table").waitFor({ state: "visible" });
      // Verify cells with the adjusted selector
      const allCellsIdentifier = ImageRegistry.getAllCellsIdentifier();
      await uiHelper.verifyCellsInTable(allCellsIdentifier);
    });

    test("Check Security Scan details", async ({ page }) => {
      const cell = await ImageRegistry.getScanCell(page);
      await expect(cell).toBeVisible();
    });
  });

  test.describe("Quay Actions", () => {
    let repository: string;
    const quayClient = new QuayClient();

    test.beforeEach(async ({ uiHelper }) => {
      // Prefer /create — Self-service was renamed to Create (RHDHBUGS-3676);
      // clickButton("Self-service") looks for a button, but the control is a link.
      await uiHelper.goToPageUrl("/create");
      await uiHelper.verifyHeading(/^(Create|Templates|Self-service)$/);
    });

    test.afterEach(async () => {
      await quayClient.deleteRepository(
        process.env.VAULT_QUAY_NAMESPACE!,
        repository,
      );
    });

    test("Creates Quay repository", async ({ page, uiHelper }) => {
      repository = `quay-actions-create-${Date.now()}`;
      const description =
        "This is just a test repository to test the 'quay:create-repository' template action";
      // clickBtnInCard can detach under NFS re-renders; click Choose directly.
      const chooseButton = page
        .locator('[class*="MuiCard-root"]')
        .filter({ hasText: "Create a Quay repository" })
        .getByRole("button", { name: /Choose/i })
        .first();
      await expect(chooseButton).toBeVisible({ timeout: 30_000 });
      await chooseButton.click();
      await uiHelper.waitForTitle("Create a Quay repository", 2);

      await uiHelper.fillTextInputByLabel("Repository name", repository);
      await uiHelper.fillTextInputByLabel(
        "Token",
        process.env.VAULT_QUAY_TOKEN!,
      );
      await uiHelper.fillTextInputByLabel(
        "namespace",
        process.env.VAULT_QUAY_NAMESPACE!,
      );
      await page.getByRole("button", { name: "Visibility​" }).click();
      await page.getByRole("option", { name: "public" }).click();
      await uiHelper.fillTextInputByLabel("Description", description);
      await page.getByRole("button", { name: "Review" }).click();
      await page.getByRole("button", { name: "Create" }).click();
      await expect(
        page.getByRole("link", { name: "Quay repository link" }),
      ).toBeVisible();
      await uiHelper.clickLink("Quay repository link");
    });
  });
});
