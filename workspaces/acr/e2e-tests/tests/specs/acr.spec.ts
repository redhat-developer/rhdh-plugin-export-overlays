import { test } from "@red-hat-developer-hub/e2e-test-utils/test";

// Trigger PR e2e for ACR workspace after #3641 merge.
test.describe("Test ACR plugin", () => {
  const dateRegex =
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4}/gm;

  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "guest" });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsGuest();
  });

  test("Verify ACR Images are visible", async ({ uiHelper, page }, testInfo) => {
    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("acr-test-entity");
    // Legacy uses the shared Image Registry tab; NFS uses an entity nav link.
    if (testInfo.project.name === "acr-app-next") {
      // eslint-disable-next-line playwright/no-conditional-in-test -- NFS nav differs from legacy
      await page.getByRole("link", { name: "ACR images" }).click();
    } else {
      await uiHelper.clickTab("Image Registry");
    }
    await uiHelper.verifyHeading(
      "Azure Container Registry Repository: hello-world",
    );
    await uiHelper.verifyRowInTableByUniqueText("latest", [dateRegex]);
    await uiHelper.verifyRowInTableByUniqueText("v1", [dateRegex]);
    await uiHelper.verifyRowsInTable(["v2", "v3"]);
  });
});
