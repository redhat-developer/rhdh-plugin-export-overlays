import { test } from "@red-hat-developer-hub/e2e-test-utils/test";

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

  test("Verify ACR Images are visible", async ({ uiHelper, rhdh }) => {
    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("acr-test-entity");
    // Legacy uses the shared Image Registry tab; NFS uses the plugin entity-content title.
    const tabName = rhdh.deploymentConfig.namespace.endsWith("-app-next")
      ? "ACR IMAGES"
      : "Image Registry";
    await uiHelper.clickTab(tabName);
    await uiHelper.verifyHeading(
      "Azure Container Registry Repository: hello-world",
    );
    await uiHelper.verifyRowInTableByUniqueText("latest", [dateRegex]);
    await uiHelper.verifyRowInTableByUniqueText("v1", [dateRegex]);
    await uiHelper.verifyRowsInTable(["v2", "v3"]);
  });
});
