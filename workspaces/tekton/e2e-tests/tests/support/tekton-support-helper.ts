import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export class TektonSupportHelper {
  private readonly uiHelper: UIhelper;
  private readonly searchField: Locator;

  constructor(private readonly page: Page) {
    this.uiHelper = new UIhelper(page);
    this.searchField = page.locator("#input-with-icon-adornment");
  }

  async goToByName(name: string): Promise<void> {
    await this.uiHelper.openCatalogSidebar("Component");
    await this.uiHelper.clickLink(name);
  }

  async clickTab(tabName: string): Promise<void> {
    const tabLocator = this.page.getByRole("tab", {
      name: tabName,
      exact: true,
    });
    await tabLocator.waitFor({ state: "visible" });
    await tabLocator.click();
  }

  async goToBackstageJanusProject(): Promise<void> {
    await this.goToByName("backstage-janus");
  }

  async goToBackstageJanusProjectCITab(): Promise<void> {
    await this.goToBackstageJanusProject();
    await this.clickTab("CI");
    await this.waitForPipelineRunsOrKubernetesError();
  }

  private async waitForPipelineRunsOrKubernetesError(): Promise<void> {
    const pipelineRunsHeading = this.page
      .locator("h2")
      .filter({ hasText: "Pipeline Runs" })
      .first();
    await pipelineRunsHeading.waitFor({ state: "visible", timeout: 15000 });
    await this.uiHelper.verifyHeading("Pipeline Runs");
  }

  getAllGridColumnsTextForPipelineRunsTable(): string[] {
    return ["NAME", "STATUS", "TASK STATUS", "STARTED", "DURATION"];
  }

  async clickOnExpandRowFromPipelineRunsTable(runName: string): Promise<void> {
    await this.page
      .getByRole("row")
      .filter({ hasText: runName })
      .getByRole("button", { name: "expand row" })
      .click();
  }

  async openModalEchoHelloWorld(): Promise<void> {
    const locator = this.page.locator('g[data-test="task echo-hello-world"]');
    await locator.first().waitFor({ state: "visible" });
    await locator.first().click();
  }

  async ensurePipelineRunsTableIsNotEmpty(): Promise<void> {
    const rowCount = await this.page
      .locator('table[aria-labelledby="Pipeline Runs"] tbody tr')
      .count();
    expect(rowCount).toBeGreaterThan(0);
  }

  async search(value: string): Promise<void> {
    const searchInput = this.page.locator('input[placeholder="Search"]');
    await searchInput.waitFor({ state: "visible" });
    await searchInput.fill(value);
  }

  async verifyModalOpened(): Promise<void> {
    await expect(this.page.locator("#pipelinerun-logs")).toBeVisible();
  }

  async checkPipelineStages(texts: string[]): Promise<void> {
    for (const text of texts) {
      const headingLocator = this.page
        .getByRole("heading")
        .filter({ hasText: text })
        .first();
      await expect(headingLocator).toBeVisible({ timeout: 20000 });
    }
  }
}
