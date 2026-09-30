import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("Test ACR plugin", () => {
  const dateRegex =
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4}/gm;

  test.beforeAll(async ({ rhdh }) => {
    // Community plugins publish to ghcr.io; nightly mode resolves {{inherit}} to RHEC by default.
    const ghcrRegistry = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays";
    process.env.NIGHTLY_DPDY_OCI_REGISTRY_MAP = JSON.stringify({
      [ghcrRegistry]: ["@backstage-community/plugin-acr"],
    });
    await rhdh.configure({ auth: "guest" });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsGuest();
  });

  test("Verify ACR Images are visible", async ({ uiHelper, page }) => {
    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("acr-test-entity");
    const acrImagesLink = page.getByRole("link", { name: "ACR images" });
    await expect(acrImagesLink).toBeVisible();
    await acrImagesLink.click();
    await uiHelper.verifyHeading(
      "Azure Container Registry Repository: hello-world",
    );
    await uiHelper.verifyRowInTableByUniqueText("latest", [dateRegex]);
    await uiHelper.verifyRowInTableByUniqueText("v1", [dateRegex]);
    await uiHelper.verifyRowsInTable(["v2", "v3"]);
  });
});
