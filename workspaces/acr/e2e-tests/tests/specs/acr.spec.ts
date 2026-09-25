import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("Test ACR plugin", () => {
  test.skip(
    !!process.env.E2E_NIGHTLY_MODE,
    "lightspeed-core sidecar crashes with unrecognized --synthesized-config-output argument (Helm chart 2.0-91-CI)",
  );

  const dateRegex =
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s\d{1,2},\s\d{4}/gm;

  test.beforeAll(async ({ rhdh }) => {
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
