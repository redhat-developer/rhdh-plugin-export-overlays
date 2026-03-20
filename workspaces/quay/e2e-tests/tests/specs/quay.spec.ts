import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { ImageRegistry } from "../utils/image-registry";
import { QuayClient } from "../utils/quay-client";

test.describe("Test Quay.io plugin", () => {
  const quayRepository = "rhdh-community/rhdh";

  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "guest" });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsGuest();
  });

  test.describe("Image Reqistry tab", () => {
    test.beforeEach(async ({ uiHelper }) => {
      await uiHelper.openCatalogSidebar("Component");
      await uiHelper.searchInputPlaceholder("Developer Hub");
      await uiHelper.clickLink("Red Hat Developer Hub");
      await uiHelper.clickTab("Image Registry");
    });

    test("Check if Image Registry is present", async ({ page, uiHelper }) => {
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
      await uiHelper.clickLink({
        ariaLabel: "Self-service",
      });
      await uiHelper.verifyHeading("Self-service");
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
      await uiHelper.clickBtnInCard("Create a Quay repository", "Choose");
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
      await uiHelper.clickButton("Review");
      await uiHelper.clickButton("Create");
      await expect(
        page.getByRole("link", { name: "Quay repository link" }),
      ).toBeVisible();
      await uiHelper.clickLink("Quay repository link");
    });
  });
});
