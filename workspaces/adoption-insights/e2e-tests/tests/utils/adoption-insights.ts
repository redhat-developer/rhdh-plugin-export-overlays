import { expect, type Page, type Locator } from "@playwright/test";

/** Minimal UI helper interface used by populateMissingPanelData (matches e2e-test-utils fixture). */
export interface AdoptionInsightsUiHelperForPanel {
  clickLink(name: string): Promise<void>;
  fillTextInputByLabel(label: string, text: string): Promise<void>;
  clickButton(
    label: string | RegExp,
    options?: { exact?: boolean },
  ): Promise<unknown>;
}

export function getPanel(page: Page, title: string | RegExp): Locator {
  return page
    .locator("article > div > div")
    .filter({
      has: page.getByRole("heading", { name: title, level: 5 }),
    })
    .first();
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
        .getByRole("heading", { level: 5 })
        .textContent();
      const match = fullText?.match(/\d+/);
      return match ? parseInt(match[0], 10) : null;
    } catch (error) {
      console.error("Error getting count from panel:", error);
      return null;
    }
  }

  async getVisibleFirstRowText(panel: Locator): Promise<string[]> {
    const firstRow = panel.locator("tbody tr").first();

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
    uiHelper: AdoptionInsightsUiHelperForPanel,
    templatesFirstLast: string[],
    catalogEntitiesFirstLast: string[],
    techdocsFirstLast: string[],
  ): Promise<void> {
    if (templatesFirstLast.length === 0) {
      // TODO: revert to "Self-service" once fixed: https://redhat.atlassian.net/browse/RHDHBUGS-3676
      // await this.page.getByRole("link", { name: "Self-service" }).click();
      await this.page.getByRole("link", { name: "Create" }).click();
      const templateHeading = this.page
        .getByRole("heading", { name: "Create a tekton CI Pipeline" })
        .first();
      let templateAvailable = await templateHeading
        .isVisible({ timeout: 10000 })
        .catch(() => false);

      if (!templateAvailable) {
        const importButton = this.page.getByRole("button", {
          name: "Import an existing Git repository",
        });
        const canImport = await importButton
          .isVisible({ timeout: 5000 })
          .catch(() => false);
        if (canImport) {
          const sampleTemplate =
            "https://github.com/redhat-developer/red-hat-developer-hub-software-templates/blob/main/templates/github/tekton/template.yaml";
          await importButton.click();
          await this.page
            .getByRole("textbox", { name: "URL" })
            .fill(sampleTemplate);
          await this.page.getByRole("button", { name: "Analyze" }).click();
          await this.page.getByRole("button", { name: "Import" }).click();
          // eslint-disable-next-line playwright/no-wait-for-timeout -- template wizard needs fixed settle time after Import
          await this.page.waitForTimeout(2000);
          await this.page.getByRole("button", { name: "Register" }).click();
          // eslint-disable-next-line playwright/no-wait-for-timeout -- template wizard needs fixed settle time before Create
          await this.page.waitForTimeout(5000);
          // TODO: revert to "Self-service" once fixed: https://redhat.atlassian.net/browse/RHDHBUGS-3676
          // await this.page.getByRole("link", { name: "Self-service" }).click();
          await this.page.getByRole("link", { name: "Create" }).click();
          templateAvailable = await templateHeading
            .isVisible({ timeout: 10000 })
            .catch(() => false);
        }
      }

      if (templateAvailable) {
        const pipelineCard = templateHeading.locator("..").locator("..");
        await pipelineCard.getByRole("button", { name: "Choose" }).click();

        const inputText = "reallyUniqueName";
        await uiHelper.fillTextInputByLabel("Organization", inputText);
        await uiHelper.fillTextInputByLabel("Repository", inputText);
        await uiHelper.clickButton("Next");
        await uiHelper.fillTextInputByLabel("Image Builder", inputText);
        await uiHelper.fillTextInputByLabel("Image URL", inputText);
        await uiHelper.fillTextInputByLabel("Namespace", inputText);
        await this.page.getByRole("spinbutton", { name: "Port" }).fill("8080");
        await uiHelper.clickButton("Review");
        await uiHelper.clickButton("Create");
        await this.page
          .getByRole("button", { name: "Error: Request failed" })
          .waitFor({ state: "visible" });
      }
    }

    if (catalogEntitiesFirstLast.length === 0) {
      await this.page.goto("/catalog");
      await uiHelper.clickLink("Red Hat Developer Hub");
      // eslint-disable-next-line playwright/no-wait-for-timeout -- intentional delay
      await this.page.waitForTimeout(5000);
      await expect(this.page.getByText("Red Hat Developer Hub")).toBeVisible();
    }

    if (techdocsFirstLast.length === 0) {
      await this.page.goto("/docs");
      await expect(this.page.locator("h1").first()).toContainText("Docs");
      await clickAdoptionInsightsSidebarLink(this.page);
    }
  }

  async expectTopEntriesToBePresent(panelTitle: string | RegExp) {
    const panel = getPanel(this.page, panelTitle);
    const entries = panel.locator("tbody tr");
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
    await waitUntilApiCallSucceeds(newpage);

    await newpage.getByText(expectedText).first().waitFor({ state: "visible" });
    await newpage.waitForTimeout(5000);
    await newpage.close();
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

export async function waitUntilApiCallSucceeds(
  page: Page,
  urlPart = "/api/adoption-insights/events",
): Promise<void> {
  const response = await page.waitForResponse(
    async (response) => {
      const urlMatches = response.url().includes(urlPart);
      const isSuccess = response.status() === 200;
      return urlMatches && isSuccess;
    },
    { timeout: 60000 },
  );
  expect(response.status()).toBe(200);
}

async function clickAdoptionInsightsSidebarLink(page: Page): Promise<void> {
  const link = page.locator('nav a:has-text("Adoption Insights")').first();
  await link.waitFor({ state: "visible", timeout: 15_000 });
  await link.click();
}

/** Navigate to Adoption Insights page and wait for panels. */
export async function goToAdoptionInsights(page: Page): Promise<void> {
  await clickAdoptionInsightsSidebarLink(page);
  await waitForPanelApiCalls(page);
}

/** Navigate to Adoption Insights and select "Today" date range. */
export async function goToAdoptionInsightsWithToday(page: Page): Promise<void> {
  await goToAdoptionInsights(page);
  const helper = new TestHelper(page);
  await helper.clickByText("Last 28 days");
  await Promise.all([waitForPanelApiCalls(page), helper.selectOption("Today")]);
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

export async function runInteractionTrackingSetup(
  page: Page,
  uiHelper: AdoptionInsightsUiHelperForPanel,
  templates: string[],
  catalogEntities: string[],
  techdocs: string[],
): Promise<void> {
  const testHelper = new TestHelper(page);
  await testHelper.populateMissingPanelData(
    uiHelper,
    templates,
    catalogEntities,
    techdocs,
  );
  await page.getByPlaceholder("Search...").fill("Dummy search");
  await waitUntilApiCallSucceeds(page);
  await expect(page.getByText("No results found")).toBeVisible();
  await page.goto("/catalog");
  await page.reload();
  await waitUntilApiCallSucceeds(page);
  await goToAdoptionInsightsWithToday(page);
}
