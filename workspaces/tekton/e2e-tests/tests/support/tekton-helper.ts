import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Helper for Tekton CI plugin E2E tests.
 * Mirrors the API used in RHDH core tekton.spec.ts so overlay tests can reuse the same spec structure.
 */
export class TektonHelper {
  constructor(private readonly page: Page) {}

  async ensurePipelineRunsTableIsNotEmpty(): Promise<void> {
    await expect(
      this.page
        .locator(
          'table[aria-label="Pipeline Runs"] tbody tr, [role="table"] tbody tr',
        )
        .first(),
    ).toBeVisible({ timeout: 30000 });
  }

  getAllGridColumnsTextForPipelineRunsTable(): string[] {
    return ["Name", "Status", "Task Status", "Started", "Duration"];
  }

  async search(text: string): Promise<void> {
    const searchInput = this.page
      .getByPlaceholder("Filter")
      .or(this.page.getByRole("searchbox"));
    await searchInput.fill(text);
    await this.page.waitForTimeout(500);
  }

  async clickOnExpandRowFromPipelineRunsTable(): Promise<void> {
    const expandButton = this.page
      .locator(
        'table button[aria-label="Expand row"], [data-testid="expand-row"]',
      )
      .first();
    await expandButton.click();
  }

  async openModalEchoHelloWorld(): Promise<void> {
    await this.page
      .getByRole("button", { name: /echo-hello-world/i })
      .first()
      .click();
  }

  async isModalOpened(): Promise<void> {
    await expect(
      this.page
        .getByRole("dialog")
        .or(
          this.page
            .locator('[role="presentation"]')
            .filter({ hasText: /echo|hello|world|stage/i }),
        ),
    ).toBeVisible({ timeout: 10000 });
  }

  async checkPipelineStages(expectedStages: string[]): Promise<void> {
    for (const stage of expectedStages) {
      await expect(
        this.page.getByText(stage, { exact: true }).first(),
      ).toBeVisible();
    }
  }
}
