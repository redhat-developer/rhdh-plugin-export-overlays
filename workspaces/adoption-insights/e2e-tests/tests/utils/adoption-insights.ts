import { expect, type Page, type Locator } from "@playwright/test";

/** Minimal UI helper interface used by populateMissingPanelData (matches e2e-test-utils fixture). */
export interface AdoptionInsightsUiHelperForPanel {
  openSidebarButton(name: string): Promise<void>;
  clickLink(name: string): Promise<void>;
  fillTextInputByLabel(label: string, text: string): Promise<void>;
  clickButton(
    label: string | RegExp,
    options?: { exact?: boolean },
  ): Promise<unknown>;
}

export class TestHelper {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async selectOption(optionName: string) {
    const option = this.page.getByRole("option", { name: optionName });
    await option.click();
  }

  async clickByText(text: string) {
    const element = this.page.getByText(text);
    await element.waitFor({ state: "visible" });
    await element.click();
  }

  async getCountFromPanel(panel: Locator): Promise<number | null> {
    try {
      const fullText = await panel
        .locator("h5.v5-MuiTypography-root")
        .textContent();
      const match = fullText?.match(/\d+/);

      if (match) {
        return parseInt(match[0], 10);
      }

      return null;
    } catch (error) {
      console.error("Error getting count from panel:", error);
      return null;
    }
  }

  async getVisibleFirstRowText(panel: Locator): Promise<string[]> {
    const firstRow = panel.locator("table.v5-MuiTable-root tbody tr").first();

    if (await firstRow.isVisible()) {
      const cells = firstRow.locator("td");
      const cellCount = await cells.count();
      const texts: string[] = [];

      for (let i = 0; i < cellCount; i++) {
        const cellText = await cells.nth(i).textContent();
        texts.push(cellText?.trim() ?? "");
      }

      return [texts[0], texts[texts.length - 1]];
    }
    return [];
  }

  async populateMissingPanelData(
    page: Page,
    uiHelper: AdoptionInsightsUiHelperForPanel,
    templatesFirstLast: string[],
    catalogEntitiesFirstLast: string[],
    techdocsFirstLast: string[],
  ): Promise<void> {
    if (templatesFirstLast.length === 0) {
      await page.getByRole("link", { name: "Self-service" }).click();
      await page
        .getByText("Templates", { exact: true })
        .waitFor({ state: "visible" });
      const panel = page
        .getByRole("heading", { name: "Create a tekton CI Pipeline" })
        .first();
      const isPanelVisible = await panel
        .isVisible({ timeout: 10000 })
        .catch(() => false);
      if (!isPanelVisible) {
        const sampleTemplate =
          "https://github.com/redhat-developer/red-hat-developer-hub-software-templates/blob/main/templates/github/tekton/template.yaml";
        await page
          .getByRole("button", { name: "Import an existing Git repository" })
          .click();
        await page.getByRole("textbox", { name: "URL" }).fill(sampleTemplate);
        await page.getByRole("button", { name: "Analyze" }).click();
        await page.getByRole("button", { name: "Import" }).click();
        await page.getByRole("button", { name: "Register" }).click();
        await page.getByRole("link", { name: "Self-service" }).click();
      }
      const pipelineCard = panel.locator("..").locator("..");
      await pipelineCard.getByRole("button", { name: "Choose" }).click();

      const inputText = "reallyUniqueName";
      await uiHelper.fillTextInputByLabel("Organization", inputText);
      await uiHelper.fillTextInputByLabel("Repository", inputText);
      await uiHelper.clickButton("Next");
      await uiHelper.fillTextInputByLabel("Image Builder", inputText);
      await uiHelper.fillTextInputByLabel("Image URL", inputText);
      await uiHelper.fillTextInputByLabel("Namespace", inputText);
      await page.getByRole("spinbutton", { name: "Port" }).fill("8080");
      await uiHelper.clickButton("Review");
      await uiHelper.clickButton("Create");
      await page
        .getByText("Run of Create a tekton CI")
        .waitFor({ state: "visible" });
    }

    if (catalogEntitiesFirstLast.length === 0) {
      await uiHelper.clickLink("Catalog");
      await uiHelper.clickLink("Red Hat Developer Hub");
      await expect(page.getByText("Red Hat Developer Hub")).toBeVisible();
    }

    if (techdocsFirstLast.length === 0) {
      await page.goto("/docs");
      await uiHelper.clickLink("Red Hat Developer Hub");
      await uiHelper.openSidebarButton("Administration");
    }
  }

  async expectTopEntriesToBePresent(panelTitle: string) {
    const panel = this.page.locator(".v5-MuiPaper-root", {
      hasText: panelTitle,
    });
    const entries = panel.locator("tbody").locator("tr");
    expect(await entries.count()).toBeGreaterThan(0);
  }

  async clickAndVerifyText(
    firstEntry: Locator,
    expectedText: string,
  ): Promise<void> {
    const [newpage] = await Promise.all([
      this.page.waitForEvent("popup"),
      firstEntry.locator("a").click(),
    ]);
    await this.waitUntilApiCallSucceeds(newpage);

    await newpage.getByText(expectedText).first().waitFor({ state: "visible" });
    await newpage.waitForTimeout(5000);
    await newpage.close();
  }

  async waitUntilApiCallSucceeds(page: Page, urlPart?: string): Promise<void> {
    await waitUntilApiCallSucceeds(page, urlPart);
  }
}

async function waitUntilApiCallIsMade(
  page: Page,
  urlPart: string,
): Promise<void> {
  await page.waitForResponse((response) => response.url().includes(urlPart), {
    timeout: 60000,
  });
}

async function waitUntilApiCallSucceeds(
  page: Page,
  urlPart?: string,
): Promise<void> {
  const part = urlPart ?? "/api/adoption-insights/events";
  const response = await page.waitForResponse(
    async (response) => {
      const urlMatches = response.url().includes(part);
      const isSuccess = response.status() === 200;
      return urlMatches && isSuccess;
    },
    { timeout: 60000 },
  );
  expect(response.status()).toBe(200);
}

/** Navigate to Adoption Insights page and wait for panels. */
export async function goToAdoptionInsights(
  uiHelper: {
    openSidebarButton: (n: string) => Promise<void>;
    clickLink: (n: string) => Promise<void>;
  },
  page: Page,
): Promise<void> {
  await uiHelper.openSidebarButton("Administration");
  await uiHelper.clickLink("Adoption Insights");
  await waitForPanelApiCalls(page);
}

/** Navigate to Adoption Insights and select "Today" date range. */
export async function goToAdoptionInsightsWithToday(
  uiHelper: {
    openSidebarButton: (n: string) => Promise<void>;
    clickLink: (n: string) => Promise<void>;
  },
  page: Page,
): Promise<void> {
  await goToAdoptionInsights(uiHelper, page);
  await selectDateRangeToday(page);
}

/** Wait for Adoption Insights panel API calls to complete. */
export async function waitForPanelApiCalls(page: Page): Promise<void> {
  const types = [
    "active_users",
    "total_users",
    "top_templates",
    "top_catalog_entities",
    "top_plugins",
    "top_techdocs",
    "top_searches",
  ];
  await Promise.all([
    ...types.map((type) =>
      waitUntilApiCallIsMade(
        page,
        `/api/adoption-insights/events?type=${type}`,
      ),
    ),
    waitUntilApiCallSucceeds(page),
  ]);
}

/** Navigate to Adoption Insights and select "Today" date range. Call after opening Adoption Insights page. */
export async function selectDateRangeToday(page: Page): Promise<void> {
  const helper = new TestHelper(page);
  await helper.clickByText("Last 28 days");
  await Promise.all([waitForPanelApiCalls(page), helper.selectOption("Today")]);
}

export async function runInteractionTrackingSetup(
  page: Page,
  uiHelper: AdoptionInsightsUiHelperForPanel,
  templates: string[],
  catalogEntities: string[],
  techdocs: string[],
): Promise<TestHelper> {
  await goToAdoptionInsightsWithToday(uiHelper, page);
  const testHelper = new TestHelper(page);
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
  await goToAdoptionInsightsWithToday(uiHelper, page);
  return testHelper;
}
