import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";
import type { BrowserContext, Page } from "@playwright/test";
import {
  HomepagePo,
  AVAILABLE_WIDGETS,
  DEFAULT_WIDGETS,
  HOMEPAGE_ADMIN,
  setupKeycloakGroups,
} from "../utils/homepage";

const HOMEPAGE_WRAPPER_DIST_NAMES: string[] = [
  "red-hat-developer-hub-backstage-plugin-homepage",
];

/* eslint-disable playwright/expect-expect -- assertions in HomepagePo */
test.describe.serial("Homepage customization", () => {
  let context: BrowserContext | undefined;
  let page: Page;
  let uiHelper: UIhelper;
  let homepage: HomepagePo;
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
        disableWrappers: HOMEPAGE_WRAPPER_DIST_NAMES,
      });
      await rhdh.deploy();
    });
    baseURL = rhdh.rhdhUrl;
    context = await browser.newContext({ baseURL });
    page = await context.newPage();
    uiHelper = new UIhelper(page);
    homepage = new HomepagePo(page, uiHelper);
    homepage.setBaseURL(baseURL);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("Verify default widgets from server config on first load", async () => {
    await new LoginHelper(page).loginAsKeycloakUser();
    await homepage.resetToDefaults();
    await homepage.verifyHomePageLoaded();
    await homepage.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.developer);
  });

  test("Verify cards display after seeding widgets", async () => {
    await homepage.seedHomePageWidgets();
    await homepage.verifyHomePageLoaded();
    await homepage.verifyAllCardsDisplayed();
    await homepage.verifyEditButtonVisible();
  });

  test("Verify cards can be individually deleted in edit mode", async () => {
    await homepage.enterEditMode();
    await homepage.deleteAllCards();
    await homepage.verifyCardsDeleted();
  });

  test("Verify cards can be resized in edit mode", async () => {
    await homepage.addWidget("Entity Section");
    await homepage.resizeFirstCard();
    await homepage.exitEditMode();
  });

  // eslint-disable-next-line playwright/no-skipped-test -- re-enable when https://issues.redhat.com/browse/RHDHBUGS-2906 is fixed
  test.skip("Verify restore default cards and deleted with Clear all button", async () => {
    await homepage.restoreDefaultCards();
    await homepage.verifyCardsRestored();
    await homepage.enterEditMode();
    await homepage.clearAllCardsWithButton();
    await homepage.verifyCardsDeleted();
  });

  test.describe("Plugin management", () => {
    test("Add widget dialog lists all available plugins", async () => {
      await homepage.enterEditMode();
      await homepage.clearAllCardsWithButton();
      await homepage.verifyAllWidgetsAvailableInDialog();
    });

    test("Each widget type can be added individually", async () => {
      for (const widget of AVAILABLE_WIDGETS) {
        await homepage.addWidget(widget);
      }
      await homepage.verifyAllCardsDisplayed();
    });

    test("Widgets can be removed and re-added in a single edit session", async () => {
      await homepage.clearAllCardsWithButton();
      await homepage.verifyCardsDeleted();

      await homepage.addWidget("Entity Section");
      await homepage.addWidget("Recently visited");
      await homepage.exitEditMode();

      await homepage.verifySpecificCardsDisplayed([
        "Explore Your Software Catalog",
        "Recently Visited",
      ]);
      await homepage.verifyCardNotDisplayed("Top Visited");
    });

    test("Multiple widgets of the same type produce distinct cards", async () => {
      await homepage.enterEditMode();
      await homepage.clearAllCardsWithButton();
      await homepage.verifyCardsDeleted();
      await homepage.addWidget("Entity Section");
      await homepage.addWidget("Entity Section");
      await homepage.exitEditMode();

      const cardCount = await homepage.getVisibleCardCount();
      expect(cardCount).toBe(2);
    });

    test("Widget layout survives edit mode toggle", async () => {
      await homepage.enterEditMode();
      await homepage.clearAllCardsWithButton();
      await homepage.addWidget("Entity Section");
      await homepage.addWidget("Onboarding Section");
      await homepage.exitEditMode();

      const countAfterSave = await homepage.getVisibleCardCount();

      await homepage.enterEditMode();
      await homepage.exitEditMode();

      const countAfterToggle = await homepage.getVisibleCardCount();
      expect(countAfterToggle).toBe(countAfterSave);
    });
  });

  test.describe("Persistent storage", () => {
    test("Customizations persist across page reload", async () => {
      await homepage.seedHomePageWidgets();

      const countBeforeReload = await homepage.getVisibleCardCount();
      expect(countBeforeReload).toBeGreaterThan(0);

      await page.reload();
      await homepage.verifyHomePageLoaded();

      const countAfterReload = await homepage.getVisibleCardCount();
      expect(countAfterReload).toBe(countBeforeReload);
      await homepage.verifyAllCardsDisplayed();
    });

    test("Customizations persist across logout and re-login", async () => {
      const countBeforeLogout = await homepage.getVisibleCardCount();
      expect(countBeforeLogout).toBeGreaterThan(0);

      await homepage.reloginAsKeycloakUser();
      await homepage.verifyHomePageLoaded();

      const countAfterRelogin = await homepage.getVisibleCardCount();
      expect(countAfterRelogin).toBe(countBeforeLogout);
    });

    test("Resized layout persists after reload", async () => {
      await homepage.enterEditMode();
      await homepage.clearAllCardsWithButton();
      await homepage.addWidget("Entity Section");
      await homepage.resizeFirstCard();
      await homepage.exitEditMode();
      const panel = page.locator('[class*="react-grid-item"]').first();
      const sizeBeforeReload = await panel.boundingBox();
      expect(sizeBeforeReload).not.toBeNull();
      await page.reload();
      await homepage.verifyHomePageLoaded();

      const panelAfterReload = page
        .locator('[class*="react-grid-item"]')
        .first();
      const sizeAfterReload = await panelAfterReload.boundingBox();
      expect(sizeAfterReload).not.toBeNull();

      expect(sizeAfterReload!.width).toBeCloseTo(sizeBeforeReload!.width, 0);
      expect(sizeAfterReload!.height).toBeCloseTo(sizeBeforeReload!.height, 0);
    });

    test("Per-user isolation: test2 sees defaults", async () => {
      await homepage.reloginAsKeycloakUser();
      await homepage.verifyHomePageLoaded();
      await homepage.seedHomePageWidgets();
      test1Count = await homepage.getVisibleCardCount();
      expect(test1Count).toBe(AVAILABLE_WIDGETS.length);
      await homepage.reloginAsKeycloakUser("test2", "test2@123");
      await homepage.verifyHomePageLoaded();
      await homepage.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.developer);
    });

    test("test2 customization does not affect test1 layout", async () => {
      await homepage.reloginAsKeycloakUser("test2", "test2@123");
      await homepage.verifyHomePageLoaded();
      await homepage.enterEditMode();
      await homepage.clearAllCardsWithButton();
      await homepage.verifyCardsDeleted();
      await homepage.reloginAsKeycloakUser();
      await homepage.verifyHomePageLoaded();
      const test1CountAfter = await homepage.getVisibleCardCount();
      expect(test1CountAfter).toBe(test1Count);
    });
  });

  test.describe("Persona-based homepages", () => {
    test("Admin sees all group widgets", async () => {
      await homepage.reloginAsKeycloakUser(
        HOMEPAGE_ADMIN.username,
        HOMEPAGE_ADMIN.password,
      );
      await homepage.verifyHomePageLoaded();
      await homepage.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.admin);
    });

    test("Developer sees developer widgets only", async () => {
      await homepage.reloginAsKeycloakUser("test2", "test2@123");
      await homepage.verifyHomePageLoaded();
      await homepage.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.developer);
      for (const widget of DEFAULT_WIDGETS.adminOnly) {
        await homepage.verifyCardNotDisplayed(widget);
      }
    });

    test("Non-group user sees only common widgets", async () => {
      await homepage.reloginAsNonGroupUser();
      await homepage.verifyHomePageLoaded();
      await homepage.verifyDefaultWidgetsFromConfig(DEFAULT_WIDGETS.guest);
      for (const widget of [
        ...DEFAULT_WIDGETS.adminOnly,
        ...DEFAULT_WIDGETS.developerOnly,
      ]) {
        await homepage.verifyCardNotDisplayed(widget);
      }
    });

    test("Non-group user can add widgets to personalize their view", async () => {
      await homepage.enterEditMode();
      await homepage.addWidget("Entity section");
      await homepage.exitEditMode();
      await homepage.verifySpecificCardsDisplayed([
        "Explore Your Software Catalog",
      ]);
    });
  });
});
