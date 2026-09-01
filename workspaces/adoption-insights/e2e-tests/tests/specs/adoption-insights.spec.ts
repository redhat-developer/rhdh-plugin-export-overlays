import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { BrowserContext, Page } from "@playwright/test";
import {
  getPanel,
  goToAdoptionInsights,
  waitForPanelApiCalls,
  waitUntilApiCallSucceeds,
  runInteractionTrackingSetup,
  TestHelper,
  type AdoptionInsightsUiHelperForPanel,
} from "../utils/adoption-insights";

/** Chart dist wrapper names (see ../metadata `spec.dynamicArtifact` basenames). */
const ADOPTION_INSIGHTS_WRAPPER_DIST_NAMES: string[] = [
  "red-hat-developer-hub-backstage-plugin-adoption-insights",
  "red-hat-developer-hub-backstage-plugin-adoption-insights-backend-dynamic",
  "red-hat-developer-hub-backstage-plugin-analytics-module-adoption-insights-dynamic",
];

test.describe.serial("Test Adoption Insights", () => {
  let context: BrowserContext | undefined;
  let page: Page;
  let uiHelper: UIhelper;
  let testHelper: TestHelper;

  test.beforeAll(async ({ browser, rhdh }) => {
    await rhdh.configure({
      auth: "keycloak",
      disablePlugins: ADOPTION_INSIGHTS_WRAPPER_DIST_NAMES,
    });
    await rhdh.deploy();

    context = await browser.newContext({
      baseURL: rhdh.rhdhUrl,
    });
    page = await context.newPage();
    uiHelper = new UIhelper(page);
    testHelper = new TestHelper(page);

    const loginHelper = new LoginHelper(page);
    await loginHelper.loginAsKeycloakUser();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test.describe
    .serial("Test Adoption Insights plugin: load permission policies and conditions from files", () => {
    let initialSearchCount: number;
    let templatesFirstEntry: string[] = [];
    let catalogEntitiesFirstEntry: string[] = [];
    let techdocsFirstEntry: string[] = [];

    test("Check UI navigation by nav bar when adoption-insights is enabled", async () => {
      await goToAdoptionInsights(page);
      // eslint-disable-next-line playwright/no-wait-for-timeout -- intentional delay for UI stabilization
      await page.waitForTimeout(5000);
      await uiHelper.verifyHeading("Adoption Insights");
      expect(page.url()).toContain("adoption-insights");
    });

    test("Select date range", async () => {
      await testHelper.clickByText("Last 28 days");
      const dateRanges = ["Today", "Last week", "Last month", "Last year"];
      for (const range of dateRanges) {
        await expect(page.getByRole("option", { name: range })).toBeVisible();
      }
      await testHelper.selectOption("Date range...");
      const dateRangeHeading = page.getByRole("heading", {
        name: "Date range",
        level: 5,
      });
      await expect(dateRangeHeading).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(dateRangeHeading).toBeHidden();

      await Promise.all([
        waitForPanelApiCalls(page),
        testHelper.selectOption("Today"),
      ]);
    });

    test("Active users panel shows the visitor", async () => {
      const panel = getPanel(page, "Active users");
      await expect(panel.locator(".recharts-surface")).toBeVisible();
      await expect(
        panel.getByText(
          /^Average peak active user count was \d+ per hour for this period\.$/,
        ),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Export CSV" }),
      ).toBeVisible();
    });

    test("Total number of users panel shows visitor of 100", async () => {
      const panel = getPanel(page, "Total number of users");
      await expect(panel.locator(".recharts-surface")).toBeVisible();
      await expect(panel.getByText(/^\d+of 100$/)).toBeVisible();
      await expect(panel.getByText(/^\d+%have logged in$/)).toBeVisible();
    });

    test("Data shows in Top plugins Entity", async () => {
      await testHelper.expectTopEntriesToBePresent(/plugins/i);
      await expect(
        getPanel(page, /plugins/i)
          .locator("tbody tr")
          .first(),
      ).toBeVisible();
    });

    test("Rest of the panels are visible", async () => {
      const titles = ["templates", "catalog entities", "techdocs", "searches"];

      for (const title of titles) {
        const panel = getPanel(page, new RegExp(title, "i"));
        await expect(panel).toBeVisible();

        /* eslint-disable playwright/no-conditional-in-test -- iterating panel types to collect state */
        if (
          title === "catalog entities" ||
          title === "techdocs" ||
          title === "templates"
        ) {
          const firstRow = await testHelper.getVisibleFirstRowText(panel);

          if (title === "templates") templatesFirstEntry = firstRow;
          else if (title === "catalog entities")
            catalogEntitiesFirstEntry = firstRow;
          else if (title === "techdocs") techdocsFirstEntry = firstRow;
        }

        if (title === "searches") {
          const count = await testHelper.getCountFromPanel(panel);
          initialSearchCount = count || 0;
        }
        /* eslint-enable playwright/no-conditional-in-test */
      }
    });

    test("Interaction-based tracking tests", async () => {
      await runInteractionTrackingSetup(
        page,
        uiHelper as AdoptionInsightsUiHelperForPanel,
        templatesFirstEntry,
        catalogEntitiesFirstEntry,
        techdocsFirstEntry,
      );

      await test.step("Visited component shows up in top catalog entities", async () => {
        await testHelper.expectTopEntriesToBePresent("catalog entities");
      });

      /* eslint-disable playwright/no-conditional-in-test -- panels may be empty when no docs/templates exist */
      if (techdocsFirstEntry.length > 0) {
        await test.step("Visited techdoc shows up in top techdocs", async () => {
          await testHelper.expectTopEntriesToBePresent("techdocs");
        });
      }

      if (templatesFirstEntry.length > 0) {
        await test.step("Visited templates shows in top templates", async () => {
          await testHelper.expectTopEntriesToBePresent("templates");
        });
      }
      /* eslint-enable playwright/no-conditional-in-test */

      await test.step("Changes are Reflecting in panels", async () => {
        /* eslint-disable playwright/no-conditional-in-test -- panels may be empty when no docs exist */
        const titles = ["catalog entities"];
        if (techdocsFirstEntry.length > 0) titles.push("techdocs");

        interface PanelState {
          firstRow?: string[];
          initialViewsCount?: number;
        }
        const state: Record<string, PanelState> = {};
        for (const t of titles) state[t] = {};

        for (const title of titles) {
          const panel = getPanel(page, new RegExp(title, "i"));
          state[title].firstRow =
            await testHelper.getVisibleFirstRowText(panel);
          if (title === "catalog entities")
            catalogEntitiesFirstEntry = state[title].firstRow ?? [];
          else if (title === "techdocs")
            techdocsFirstEntry = state[title].firstRow ?? [];
          const firstRow = panel.locator("tbody tr").first();
          const firstEntry = firstRow.locator("td").first();
          let headerTxt: string;
          if (title === "techdocs") {
            headerTxt = techdocsFirstEntry[0];
            state[title].initialViewsCount = Number(techdocsFirstEntry[1]);
            if (headerTxt === "docs") headerTxt = "Documentation";
            await testHelper.clickAndVerifyText(firstEntry, headerTxt);
          } else if (title === "catalog entities") {
            headerTxt = "Red Hat Developer Hub";
            state[title].initialViewsCount = Number(
              catalogEntitiesFirstEntry[1],
            );
            await testHelper.clickAndVerifyText(firstEntry, headerTxt);
          }
        }
        /* eslint-enable playwright/no-conditional-in-test */

        await page.reload();
        await waitUntilApiCallSucceeds(page);
        const aiLink = page
          .locator('nav a:has-text("Adoption Insights")')
          .first();
        await aiLink.waitFor({ state: "visible", timeout: 15_000 });
        await aiLink.click();
        await testHelper.clickByText("Last 28 days");
        await Promise.all([
          waitForPanelApiCalls(page),
          testHelper.selectOption("Today"),
        ]);
        await waitUntilApiCallSucceeds(page);

        for (const title of titles) {
          const panel = getPanel(page, new RegExp(title, "i"));
          const firstRow = panel.locator("tbody tr").first();
          const finalViews = firstRow.locator("td").last();
          await firstRow.waitFor({ state: "visible" });
          const finalViewsCount = await finalViews.textContent();
          expect(Number(finalViewsCount)).toBeGreaterThan(
            state[title].initialViewsCount ?? 0,
          );
        }
      });

      await test.step("New data shows in searches", async () => {
        const panel = getPanel(page, /searches/i);
        await panel.scrollIntoViewIfNeeded();
        const hasChart = await panel
          .locator(".recharts-surface")
          .isVisible({ timeout: 15_000 })
          .catch(() => false);
        /* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- searches data may not appear within the test window */
        if (hasChart) {
          await expect(panel).toContainText(
            /Average search count was \d+ per \w+ for this period\./,
          );
          const recount = await testHelper.getCountFromPanel(panel);
          expect(recount).toBeGreaterThan(initialSearchCount);
        } else {
          await expect(panel).toContainText("No results for this date range");
        }
        /* eslint-enable playwright/no-conditional-in-test, playwright/no-conditional-expect */
      });
    });
  });
});
