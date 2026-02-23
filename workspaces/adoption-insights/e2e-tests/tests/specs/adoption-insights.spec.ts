import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { TestHelper } from "e2e-tests/playwright/support/pages/adoption-insights";

test.describe.serial("Test Adoption Insights", () => {
  test.beforeAll(async ({ rhdh }) => {
    test.info().annotations.push({
      type: "component",
      description: "plugins",
    });
    await rhdh.configure({ auth: "keycloak" });
    await rhdh.deploy();
  });

  test.describe.serial(
    "Test Adoption Insights plugin: load permission policies and conditions from files",
    () => {
      let initialSearchCount: number;
      let templatesFirstEntry: string[] = [];
      let catalogEntitiesFirstEntry: string[] = [];
      let techdocsFirstEntry: string[] = [];

      test.beforeEach(async ({ loginHelper, page, uiHelper }) => {
        await loginHelper.loginAsKeycloakUser();
        await uiHelper.goToPageUrl("/", "Welcome back!");
      });

      test("Check UI navigation by nav bar when adoption-insights is enabled", async ({
        page,
        uiHelper,
      }) => {
        const testHelper = new TestHelper(page);
        await uiHelper.openSidebarButton("Administration");
        await uiHelper.clickLink("Adoption Insights");

        await testHelper.waitForPanelApiCalls(page);

        await uiHelper.verifyHeading("Adoption Insights");
        expect(page.url()).toContain("adoption-insights");
      });

      test("Select date range", async ({ page, uiHelper }) => {
        const testHelper = new TestHelper(page);
        await uiHelper.openSidebarButton("Administration");
        await uiHelper.clickLink("Adoption Insights");
        await testHelper.waitForPanelApiCalls(page);

        const dateRanges = ["Today", "Last week", "Last month", "Last year"];
        await testHelper.clickByText("Last 28 days");
        for (const range of dateRanges) {
          await expect(page.getByRole("option", { name: range })).toBeVisible();
        }

        await testHelper.selectOption("Date range...");
        const datePicker = page.locator(".v5-MuiPaper-root", {
          hasText: "Start date",
        });
        await expect(datePicker).toBeVisible();
        await datePicker.getByRole("button", { name: "Cancel" }).click();
        await expect(datePicker).toBeHidden();

        await Promise.all([
          testHelper.waitForPanelApiCalls(page),
          testHelper.selectOption("Today"),
        ]);
      });

      test("Active users panel shows the visitor", async ({
        page,
        uiHelper,
      }) => {
        const testHelper = new TestHelper(page);
        await uiHelper.openSidebarButton("Administration");
        await uiHelper.clickLink("Adoption Insights");
        await testHelper.waitForPanelApiCalls(page);
        await testHelper.clickByText("Last 28 days");
        await Promise.all([
          testHelper.waitForPanelApiCalls(page),
          testHelper.selectOption("Today"),
        ]);

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
        const testHelper = new TestHelper(page);
        await uiHelper.openSidebarButton("Administration");
        await uiHelper.clickLink("Adoption Insights");
        await testHelper.waitForPanelApiCalls(page);
        await testHelper.clickByText("Last 28 days");
        await Promise.all([
          testHelper.waitForPanelApiCalls(page),
          testHelper.selectOption("Today"),
        ]);

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
        const testHelper = new TestHelper(page);
        await uiHelper.openSidebarButton("Administration");
        await uiHelper.clickLink("Adoption Insights");
        await testHelper.waitForPanelApiCalls(page);
        await testHelper.clickByText("Last 28 days");
        await Promise.all([
          testHelper.waitForPanelApiCalls(page),
          testHelper.selectOption("Today"),
        ]);
        await testHelper.expectTopEntriesToBePresent("plugins");
      });

      test("Rest of the panels are visible", async ({
        page,
        uiHelper,
      }) => {
        const testHelper = new TestHelper(page);
        await uiHelper.openSidebarButton("Administration");
        await uiHelper.clickLink("Adoption Insights");
        await testHelper.waitForPanelApiCalls(page);
        await testHelper.clickByText("Last 28 days");
        await Promise.all([
          testHelper.waitForPanelApiCalls(page),
          testHelper.selectOption("Today"),
        ]);

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

      test.describe("Interaction-based tracking tests", () => {
        test("Visited component shows up in top catalog entities", async ({
          page,
          uiHelper,
        }) => {
          const testHelper = new TestHelper(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.waitForPanelApiCalls(page);
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);
          await testHelper.populateMissingPanelData(
            page,
            uiHelper,
            templatesFirstEntry,
            catalogEntitiesFirstEntry,
            techdocsFirstEntry,
          );
          await page.getByPlaceholder("Search...").fill("Dummy search");
          await testHelper.waitUntilApiCallSucceeds(page);
          await expect(page.getByText("No results found")).toBeVisible();
          await uiHelper.clickLink("Catalog");
          await page.reload();
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);

          await testHelper.expectTopEntriesToBePresent("catalog entities");
        });

        test("Visited techdoc shows up in top techdocs", async ({
          page,
          uiHelper,
        }) => {
          const testHelper = new TestHelper(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.waitForPanelApiCalls(page);
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);
          await testHelper.populateMissingPanelData(
            page,
            uiHelper,
            templatesFirstEntry,
            catalogEntitiesFirstEntry,
            techdocsFirstEntry,
          );
          await page.getByPlaceholder("Search...").fill("Dummy search");
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.clickLink("Catalog");
          await page.reload();
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);

          await testHelper.expectTopEntriesToBePresent("techdocs");
        });

        test("Visited templates shows in top templates", async ({
          page,
          uiHelper,
        }) => {
          const testHelper = new TestHelper(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.waitForPanelApiCalls(page);
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);
          await testHelper.populateMissingPanelData(
            page,
            uiHelper,
            templatesFirstEntry,
            catalogEntitiesFirstEntry,
            techdocsFirstEntry,
          );
          await page.getByPlaceholder("Search...").fill("Dummy search");
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.clickLink("Catalog");
          await page.reload();
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);

          await testHelper.expectTopEntriesToBePresent("templates");
        });

        test("Changes are Reflecting in panels", async ({
          page,
          uiHelper,
        }) => {
          const testHelper = new TestHelper(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.waitForPanelApiCalls(page);
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);
          await testHelper.populateMissingPanelData(
            page,
            uiHelper,
            templatesFirstEntry,
            catalogEntitiesFirstEntry,
            techdocsFirstEntry,
          );
          await page.getByPlaceholder("Search...").fill("Dummy search");
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.clickLink("Catalog");
          await page.reload();
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);

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
              if (headerTxt === "docs") {
                headerTxt = "Documentation";
              }
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
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);
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

        test("New data shows in searches", async ({
          page,
          uiHelper,
        }) => {
          const testHelper = new TestHelper(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.waitForPanelApiCalls(page);
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);
          await testHelper.populateMissingPanelData(
            page,
            uiHelper,
            templatesFirstEntry,
            catalogEntitiesFirstEntry,
            techdocsFirstEntry,
          );
          await page.getByPlaceholder("Search...").fill("Dummy search");
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.clickLink("Catalog");
          await page.reload();
          await testHelper.waitUntilApiCallSucceeds(page);
          await uiHelper.openSidebarButton("Administration");
          await uiHelper.clickLink("Adoption Insights");
          await testHelper.clickByText("Last 28 days");
          await Promise.all([
            testHelper.waitForPanelApiCalls(page),
            testHelper.selectOption("Today"),
          ]);

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
