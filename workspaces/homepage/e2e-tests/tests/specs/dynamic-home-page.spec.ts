import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { DynamicHomePagePo } from "../support/dynamic-home-page.po";

/* Assertions live in DynamicHomePagePo (expect/verify*), matching RHDH core structure. */
/* eslint-disable playwright/expect-expect -- see DynamicHomePagePo */
test.describe.serial("Dynamic home page customization", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "keycloak",
      // Default chart tag in registry (avoid "next", which is not always published).
      version: process.env.RHDH_VERSION ?? "1.10",
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper, uiHelper }) => {
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.goToPageUrl("/", "Welcome back!");
  });

  test("Verify cards display after login", async ({ page, uiHelper }) => {
    const home = new DynamicHomePagePo(page, uiHelper);
    await home.seedHomePageWidgets();
    await home.verifyHomePageLoaded();
    await home.verifyAllCardsDisplayed();
    await home.verifyEditButtonVisible();
  });

  test("Verify all cards can be resized in edit mode", async ({
    page,
    uiHelper,
  }) => {
    const home = new DynamicHomePagePo(page, uiHelper);
    await home.enterEditMode();
    await home.resizeAllCards();
    await home.exitEditMode();
  });

  test("Verify cards can be individually deleted in edit mode", async ({
    page,
    uiHelper,
  }) => {
    const home = new DynamicHomePagePo(page, uiHelper);
    await home.enterEditMode();
    await home.deleteAllCards();
    await home.verifyCardsDeleted();
  });

  // restore defaults button is not working as expected in talks with devs
  // eslint-disable-next-line playwright/no-skipped-test -- re-enable when restore-defaults is fixed
  test.skip("Verify restore default cards", async ({ page, uiHelper }) => {
    const home = new DynamicHomePagePo(page, uiHelper);
    await home.restoreDefaultCards();
    await home.verifyCardsRestored();
  });

  test("Verify all cards can be deleted with Clear all button", async ({
    page,
    uiHelper,
  }) => {
    const home = new DynamicHomePagePo(page, uiHelper);
    // Until restore-defaults works, rebuild the grid the same way as the first test.
    await home.seedHomePageWidgets();
    await home.enterEditMode();
    await home.clearAllCardsWithButton();
    await home.verifyCardsDeleted();
  });
});
