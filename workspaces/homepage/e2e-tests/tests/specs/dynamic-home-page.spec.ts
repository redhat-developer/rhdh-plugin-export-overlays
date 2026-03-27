import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { BrowserContext, Page } from "@playwright/test";
import { DynamicHomePagePo } from "../support/dynamic-home-page.po";

/** Chart dist wrapper names (see ../metadata `spec.dynamicArtifact` basenames). */
const DYNAMIC_HOME_PAGE_WRAPPER_DIST_NAMES = [
  "red-hat-developer-hub-backstage-plugin-dynamic-home-page",
] as const;

/* Assertions live in DynamicHomePagePo (expect/verify*), matching RHDH core structure. */
/* eslint-disable playwright/expect-expect -- see DynamicHomePagePo */
test.describe.serial("Dynamic home page customization", () => {
  let context: BrowserContext | undefined;
  let page: Page;
  let uiHelper: UIhelper;

  test.beforeAll(async ({ browser, rhdhDeploymentWorker }) => {
    test.setTimeout(10 * 60 * 1000);

    await rhdhDeploymentWorker.configure({
      auth: "keycloak",
      // Default chart tag in registry (avoid "next", which is not always published).
      version: process.env.RHDH_VERSION ?? "1.10",
      disableWrappers: [...DYNAMIC_HOME_PAGE_WRAPPER_DIST_NAMES],
    });
    await rhdhDeploymentWorker.deploy();

    context = await browser.newContext({
      baseURL: rhdhDeploymentWorker.rhdhUrl,
    });
    page = await context.newPage();
    uiHelper = new UIhelper(page);
  });

  test.beforeEach(async () => {
    const loginHelper = new LoginHelper(page);
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.goToPageUrl("/", "Welcome back!");
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("Verify cards display after login", async () => {
    const home = new DynamicHomePagePo(page, uiHelper);
    await home.seedHomePageWidgets();
    await home.verifyHomePageLoaded();
    await home.verifyAllCardsDisplayed();
    await home.verifyEditButtonVisible();
  });

  test("Verify all cards can be resized in edit mode", async () => {
    const home = new DynamicHomePagePo(page, uiHelper);
    await home.enterEditMode();
    await home.resizeAllCards();
    await home.exitEditMode();
  });

  test("Verify cards can be individually deleted in edit mode", async () => {
    const home = new DynamicHomePagePo(page, uiHelper);
    await home.enterEditMode();
    await home.deleteAllCards();
    await home.verifyCardsDeleted();
  });

  // restore defaults button is not working as expected in talks with devs
  // eslint-disable-next-line playwright/no-skipped-test -- re-enable when restore-defaults is fixed
  test.skip("Verify restore default cards", async () => {
    const home = new DynamicHomePagePo(page, uiHelper);
    await home.restoreDefaultCards();
    await home.verifyCardsRestored();
  });

  test("Verify all cards can be deleted with Clear all button", async () => {
    const home = new DynamicHomePagePo(page, uiHelper);
    // Until restore-defaults works, rebuild the grid the same way as the first test.
    await home.seedHomePageWidgets();
    await home.enterEditMode();
    await home.clearAllCardsWithButton();
    await home.verifyCardsDeleted();
  });
});
