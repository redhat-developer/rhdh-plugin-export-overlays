import { test } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("Test ACR plugin", () => {
  test.skip(
    !!process.env.E2E_NIGHTLY_MODE,
    "RHDH init container crashes -- missing OCI tag quay.io/rhdh/backstage-plugin-org:2.1.0--0.7.8 in catalog-index default plugins",
  );

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

    // Same pattern as argocd #3478 e2e fix (group button + menuitemradio).
    // ACR NFS alpha registers title "ACR images", group development.
    await uiHelper.clickButtonByLabel("Development");
    await page.getByRole("menuitemradio", { name: "ACR images" }).click();

    await uiHelper.verifyHeading(
      "Azure Container Registry Repository: hello-world",
    );
    await uiHelper.verifyRowInTableByUniqueText("latest", [dateRegex]);
    await uiHelper.verifyRowInTableByUniqueText("v1", [dateRegex]);
    await uiHelper.verifyRowsInTable(["v2", "v3"]);
  });
});
