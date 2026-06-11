import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";
import type { BrowserContext, Page } from "@playwright/test";
import {
  DynamicHomePagePo,
  AVAILABLE_WIDGETS,
  DEFAULT_WIDGETS,
  HOMEPAGE_ADMIN,
  setupKeycloakGroups,
} from "../utils/dynamic-homepage";

const DYNAMIC_HOME_PAGE_WRAPPER_DIST_NAMES: string[] = [
  "red-hat-developer-hub-backstage-plugin-dynamic-home-page",
];

/* eslint-disable playwright/expect-expect -- assertions in DynamicHomePagePo */
test.describe.serial("Dynamic home page customization", () => {
  let context: BrowserContext | undefined;
  let page: Page;
  let uiHelper: UIhelper;
  let home: DynamicHomePagePo;
  let baseURL: string;
  let test1Count: number;

  test.beforeAll(async ({ browser, rhdh }) => {
    test.setTimeout(10 * 60 * 1000);

    await test.runOnce("homepage-setup", async () => {
      await setupKeycloakGroups();

      const rbacConfigmapPath = WorkspacePaths.resolve(
        "tests/config/rbac-configmap.yaml",
      );
      const namespace = rhdh.deploymentConfig.namespace;
      await $`oc apply -f ${rbacConfigmapPath} -n ${namespace}`;

      await rhdh.configure({
        auth: "keycloak",
        disableWrappers: DYNAMIC_HOME_PAGE_WRAPPER_DIST_NAMES,
      });
      await rhdh.deploy();
    });
    baseURL = rhdh.rhdhUrl;
    context = await browser.newContext({ baseURL });
    page = await context.newPage();
    uiHelper = new UIhelper(page);
    home = new DynamicHomePagePo(page, uiHelper);
    home.setBaseURL(baseURL);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("Verify default widgets from server config on first load", async () => {
    await new LoginHelper(page).loginAsKeycloakUser();
    await home.resetToDefaults();
    await home.verifyHomePageLoaded();
    await home.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.developer);
  });

  test("Verify cards display after seeding widgets", async () => {
    await home.seedHomePageWidgets();
    await home.verifyHomePageLoaded();
    await home.verifyAllCardsDisplayed();
    await home.verifyEditButtonVisible();
  });

  test("Verify cards can be individually deleted in edit mode", async () => {
    await home.enterEditMode();
    await home.deleteAllCards();
    await home.verifyCardsDeleted();
  });

  test("Verify cards can be resized in edit mode", async () => {
    await home.addWidget("Entity Section");
    await home.resizeFirstCard();
    await home.exitEditMode();
  });

  // eslint-disable-next-line playwright/no-skipped-test -- re-enable when https://issues.redhat.com/browse/RHDHBUGS-2906 is fixed
  test.skip("Verify restore default cards and deleted with Clear all button", async () => {
    await home.restoreDefaultCards();
    await home.verifyCardsRestored();
    await home.enterEditMode();
    await home.clearAllCardsWithButton();
    await home.verifyCardsDeleted();
  });

  test.describe("Plugin management", () => {
    test("Add widget dialog lists all available plugins", async () => {
      await home.enterEditMode();
      await home.clearAllCardsWithButton();
      await home.verifyAllWidgetsAvailableInDialog();
    });

    test("Each widget type can be added individually", async () => {
      for (const widget of AVAILABLE_WIDGETS) {
        await home.addWidget(widget);
      }
      await home.verifyAllCardsDisplayed();
    });

    test("Widgets can be removed and re-added in a single edit session", async () => {
      await home.clearAllCardsWithButton();
      await home.verifyCardsDeleted();

      await home.addWidget("Entity Section");
      await home.addWidget("Recently visited");
      await home.exitEditMode();

      await home.verifySpecificCardsDisplayed([
        "Explore Your Software Catalog",
        "Recently Visited",
      ]);
      await home.verifyCardNotDisplayed("Top Visited");
    });

    test("Multiple widgets of the same type produce distinct cards", async () => {
      await home.enterEditMode();
      await home.clearAllCardsWithButton();
      await home.verifyCardsDeleted();
      await home.addWidget("Entity Section");
      await home.addWidget("Entity Section");
      await home.exitEditMode();

      const cardCount = await home.getVisibleCardCount();
      expect(cardCount).toBe(2);
    });

    test("Widget layout survives edit mode toggle", async () => {
      await home.enterEditMode();
      await home.clearAllCardsWithButton();
      await home.addWidget("Entity Section");
      await home.addWidget("Onboarding Section");
      await home.exitEditMode();

      const countAfterSave = await home.getVisibleCardCount();

      await home.enterEditMode();
      await home.exitEditMode();

      const countAfterToggle = await home.getVisibleCardCount();
      expect(countAfterToggle).toBe(countAfterSave);
    });
  });

  test.describe("Persistent storage", () => {
    test("Customizations persist across page reload", async () => {
      await home.seedHomePageWidgets();

      const countBeforeReload = await home.getVisibleCardCount();
      expect(countBeforeReload).toBeGreaterThan(0);

      await page.reload();
      await home.verifyHomePageLoaded();

      const countAfterReload = await home.getVisibleCardCount();
      expect(countAfterReload).toBe(countBeforeReload);
      await home.verifyAllCardsDisplayed();
    });

    test("Customizations persist across logout and re-login", async () => {
      const countBeforeLogout = await home.getVisibleCardCount();
      expect(countBeforeLogout).toBeGreaterThan(0);

      await home.reloginAsKeycloakUser();
      await home.verifyHomePageLoaded();

      const countAfterRelogin = await home.getVisibleCardCount();
      expect(countAfterRelogin).toBe(countBeforeLogout);
    });

    test("Resized layout persists after reload", async () => {
      await home.enterEditMode();
      await home.clearAllCardsWithButton();
      await home.addWidget("Entity Section");
      await home.resizeFirstCard();
      await home.exitEditMode();
      const panel = page.locator('[class*="react-grid-item"]').first();
      const sizeBeforeReload = await panel.boundingBox();
      expect(sizeBeforeReload).not.toBeNull();
      await page.reload();
      await home.verifyHomePageLoaded();

      const panelAfterReload = page
        .locator('[class*="react-grid-item"]')
        .first();
      const sizeAfterReload = await panelAfterReload.boundingBox();
      expect(sizeAfterReload).not.toBeNull();

      expect(sizeAfterReload!.width).toBeCloseTo(sizeBeforeReload!.width, 0);
      expect(sizeAfterReload!.height).toBeCloseTo(sizeBeforeReload!.height, 0);
    });

    test("Per-user isolation: test2 sees defaults", async () => {
      await home.reloginAsKeycloakUser();
      await home.verifyHomePageLoaded();
      await home.seedHomePageWidgets();
      test1Count = await home.getVisibleCardCount();
      expect(test1Count).toBe(AVAILABLE_WIDGETS.length);
      await home.reloginAsKeycloakUser("test2", "test2@123");
      await home.verifyHomePageLoaded();
      await home.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.developer);
    });

    test("test2 customization does not affect test1 layout", async () => {
      await home.reloginAsKeycloakUser("test2", "test2@123");
      await home.verifyHomePageLoaded();
      await home.enterEditMode();
      await home.clearAllCardsWithButton();
      await home.verifyCardsDeleted();
      await home.reloginAsKeycloakUser();
      await home.verifyHomePageLoaded();
      const test1CountAfter = await home.getVisibleCardCount();
      expect(test1CountAfter).toBe(test1Count);
    });
  });

  test.describe("Persona-based homepages", () => {
    test("Admin sees all group widgets", async () => {
      await home.reloginAsKeycloakUser(
        HOMEPAGE_ADMIN.username,
        HOMEPAGE_ADMIN.password,
      );
      await home.verifyHomePageLoaded();
      await home.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.admin);
    });

    test("Developer sees developer widgets only", async () => {
      await home.reloginAsKeycloakUser("test2", "test2@123");
      await home.verifyHomePageLoaded();
      await home.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.developer);
      for (const widget of DEFAULT_WIDGETS.adminOnly) {
        await home.verifyCardNotDisplayed(widget);
      }
    });

    test("Non-group user sees only common widgets", async () => {
      await home.reloginAsNonGroupUser();
      await home.verifyHomePageLoaded();
      await home.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.guest);
      for (const widget of [
        ...DEFAULT_WIDGETS.adminOnly,
        ...DEFAULT_WIDGETS.developerOnly,
      ]) {
        await home.verifyCardNotDisplayed(widget);
      }
    });

    test("Non-group user can add widgets to personalize their view", async () => {
      await home.enterEditMode();
      await home.addWidget("Entity section");
      await home.exitEditMode();
      await home.verifySpecificCardsDisplayed([
        "Explore Your Software Catalog",
      ]);
    });
  });
});
