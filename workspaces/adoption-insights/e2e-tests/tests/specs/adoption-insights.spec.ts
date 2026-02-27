import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  goToAdoptionInsights,
  goToAdoptionInsightsWithToday,
  waitForPanelApiCalls,
  runInteractionTrackingSetup,
  TestHelper,
  type AdoptionInsightsUiHelperForPanel,
} from "../utils/adoption-insights";

test.describe.serial("Test Adoption Insights", () => {
  test.beforeAll(async ({ rhdh }) => {
    test.info().annotations.push({
      type: "component",
      description: "plugins",
    });
    await rhdh.configure({ auth: "keycloak" });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test.describe.serial(
    "Test Adoption Insights plugin: load permission policies and conditions from files",
    () => {
      let initialSearchCount: number;
      let templatesFirstEntry: string[] = [];
      let catalogEntitiesFirstEntry: string[] = [];
      let techdocsFirstEntry: string[] = [];

      test("Check UI navigation by nav bar when adoption-insights is enabled", async ({
        page,
        uiHelper,
      }) => {
        await goToAdoptionInsights(uiHelper, page);
        await uiHelper.verifyHeading("Adoption Insights");
        expect(page.url()).toContain("adoption-insights");
      });

      test("Select date range", async ({ page, uiHelper }) => {
        await goToAdoptionInsights(uiHelper, page);

        const helper = new TestHelper(page);
        await helper.clickByText("Last 28 days");
        const dateRanges = ["Today", "Last week", "Last month", "Last year"];
        for (const range of dateRanges) {
          await expect(page.getByRole("option", { name: range })).toBeVisible();
        }
        await helper.selectOption("Date range...");
        const datePicker = page.locator(".v5-MuiPaper-root", {
          hasText: "Start date",
        });
        await expect(datePicker).toBeVisible();
        await datePicker.getByRole("button", { name: "Cancel" }).click();
        await expect(datePicker).toBeHidden();

        await helper.clickByText("Last 28 days");
        await Promise.all([
          waitForPanelApiCalls(page),
          helper.selectOption("Today"),
        ]);
      });

      test("Active users panel shows the visitor", async ({
        page,
        uiHelper,
      }) => {
        await goToAdoptionInsightsWithToday(uiHelper, page);

        const panel = page.locator(".v5-MuiPaper-root", {
          hasText: "Active users",
        });
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

      test("Total number of users panel shows visitor of 100", async ({
        page,
        uiHelper,
      }) => {
        await goToAdoptionInsightsWithToday(uiHelper, page);

        const panel = page.locator(".v5-MuiPaper-root", {
          hasText: "Total number of users",
        });
        await expect(panel.locator(".recharts-surface")).toBeVisible();
        await expect(panel.getByText(/^\d+of 100$/)).toBeVisible();
        await expect(panel.getByText(/^\d+%have logged in$/)).toBeVisible();
      });

      test("Data shows in Top plugins Entity", async ({
        page,
        uiHelper,
      }) => {
        await goToAdoptionInsightsWithToday(uiHelper, page);

        const testHelper = new TestHelper(page);
        await testHelper.expectTopEntriesToBePresent("plugins");
      });

      test("Rest of the panels are visible", async ({
        page,
        uiHelper,
      }) => {
        await goToAdoptionInsightsWithToday(uiHelper, page);

        const testHelper = new TestHelper(page);
        const titles = ["templates", "catalog entities", "techdocs", "Searches"];

        for (const title of titles) {
          const panel = page
            .locator(".v5-MuiPaper-root", { hasText: title })
            .last();
          await expect(panel).toBeVisible();

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

          if (title === "Searches") {
            const count = await testHelper.getCountFromPanel(panel);
            initialSearchCount = count || 0;
          }
        }
      });

      test("Interaction-based tracking tests", async ({
        page,
        uiHelper,
      }) => {
        const testHelper = await runInteractionTrackingSetup(
          page,
          uiHelper as AdoptionInsightsUiHelperForPanel,
          templatesFirstEntry,
          catalogEntitiesFirstEntry,
          techdocsFirstEntry,
        );

        await test.step("Visited component shows up in top catalog entities", async () => {
          await testHelper.expectTopEntriesToBePresent("catalog entities");
        });
        await test.step("Visited techdoc shows up in top techdocs", async () => {
          await testHelper.expectTopEntriesToBePresent("techdocs");
        });
        await test.step("Visited templates shows in top templates", async () => {
          await testHelper.expectTopEntriesToBePresent("templates");
        });

        await test.step("Changes are Reflecting in panels", async () => {
          const titles = ["catalog entities", "techdocs"];
          interface PanelState {
            firstRow?: string[];
            initialViewsCount?: number;
          }
          const state: Record<string, PanelState> = {
            "catalog entities": {},
            techdocs: {},
          };

          for (const title of titles) {
            const panel = page
              .locator(".v5-MuiPaper-root", { hasText: title })
              .last();
            if (
              title === "catalog entities" ||
              title === "techdocs" ||
              title === "templates"
            ) {
              state[title].firstRow =
                await testHelper.getVisibleFirstRowText(panel);
              if (title === "catalog entities")
                catalogEntitiesFirstEntry = state[title].firstRow ?? [];
              else if (title === "techdocs")
                techdocsFirstEntry = state[title].firstRow ?? [];
            }
            const firstRow = panel
              .locator("table.v5-MuiTable-root tbody tr")
              .first();
            const firstEntry = firstRow.locator("td").first();
            let headerTxt: string;
            if (title === "techdocs") {
              headerTxt = techdocsFirstEntry[0];
              state[title].initialViewsCount = Number(techdocsFirstEntry[1]);
              if (headerTxt === "docs") headerTxt = "Documentation";
              await testHelper.clickAndVerifyText(firstEntry, headerTxt);
            } else if (title === "catalog entities") {
              headerTxt = catalogEntitiesFirstEntry[0];
              state[title].initialViewsCount = Number(
                catalogEntitiesFirstEntry[1],
              );
              await testHelper.clickAndVerifyText(firstEntry, headerTxt);
            }
          }
          await page.reload();
          await testHelper.waitUntilApiCallSucceeds(page);
          await goToAdoptionInsightsWithToday(uiHelper, page);
          await testHelper.waitUntilApiCallSucceeds(page);
          for (const title of titles) {
            const panel = page
              .locator(".v5-MuiPaper-root", { hasText: title })
              .last();
            const firstRow = panel
              .locator("table.v5-MuiTable-root tbody tr")
              .first();
            const finalViews = firstRow.locator("td").last();
            await firstRow.waitFor({ state: "visible" });
            const finalViewsCount = await finalViews.textContent();
            expect(Number(finalViewsCount)).toBeGreaterThan(
              state[title].initialViewsCount ?? 0,
            );
          }
        });

        await test.step("New data shows in searches", async () => {
          const panel = page.locator(".v5-MuiPaper-root", {
            hasText: "searches",
          });
          await expect(panel.locator(".recharts-surface")).toBeVisible();
          await expect(panel).toContainText(
            /Average search count was \d+ per \w+ for this period\./,
          );
          const recount = await testHelper.getCountFromPanel(panel);
          expect(recount).toBeGreaterThan(initialSearchCount);
        });
      });
    },
  );
});
