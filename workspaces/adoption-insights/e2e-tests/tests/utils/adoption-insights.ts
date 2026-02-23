import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { TestHelper } from "e2e-tests/playwright/support/pages/adoption-insights";

export interface AdoptionInsightsUiHelper {
  openSidebarButton(name: string): Promise<void>;
  clickLink(name: string): Promise<void>;
}

export async function goToAdoptionInsights(
  page: Page,
  uiHelper: AdoptionInsightsUiHelper,
): Promise<TestHelper> {
  const testHelper = new TestHelper(page);
  await uiHelper.openSidebarButton("Administration");
  await uiHelper.clickLink("Adoption Insights");
  await testHelper.waitForPanelApiCalls(page);
  return testHelper;
}

export async function goToAdoptionInsightsAndSelectToday(
  page: Page,
  uiHelper: AdoptionInsightsUiHelper,
): Promise<TestHelper> {
  const testHelper = await goToAdoptionInsights(page, uiHelper);
  await testHelper.clickByText("Last 28 days");
  await Promise.all([
    testHelper.waitForPanelApiCalls(page),
    testHelper.selectOption("Today"),
  ]);
  return testHelper;
}

export async function runInteractionTrackingSetup(
  page: Page,
  uiHelper: AdoptionInsightsUiHelper,
  templates: string[],
  catalogEntities: string[],
  techdocs: string[],
): Promise<TestHelper> {
  const testHelper = await goToAdoptionInsightsAndSelectToday(page, uiHelper);
  await testHelper.populateMissingPanelData(
    page,
    uiHelper,
    templates,
    catalogEntities,
    techdocs,
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
  return testHelper;
}
