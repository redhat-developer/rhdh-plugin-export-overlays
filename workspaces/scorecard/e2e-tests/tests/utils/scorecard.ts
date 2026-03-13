import { expect, type Page } from "@playwright/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export const SCORECARD_METRICS = [
  {
    title: "GitHub open PRs",
    description:
      "Current count of open Pull Requests for a given GitHub repository.",
  },
  {
    title: "Jira open blocking tickets",
    description:
      "Highlights the number of critical, blocking issues that are currently open in Jira.",
  },
] as const;

export function scorecardHelpers(page: Page, uiHelper: UIhelper) {
  return {
    async openTab() {
      const tab = page.getByRole("tab", { name: "Scorecard" });
      await expect(tab).toBeVisible();
      await tab.click();
    },
    async expectEmptyState() {
      await expect(page.getByText("No scorecards added yet")).toBeVisible();
      await expect(page.getByRole("article")).toContainText(
        "Scorecards help you monitor component health at a glance. To begin, explore our documentation for setup guidelines.",
      );
      await expect(
        page.getByRole("link", { name: "View documentation" }),
      ).toBeVisible();
    },
    async validateScorecardAriaFor(scorecard: {
      title: string;
      description: string;
    }) {
      const section = page
        .locator("article")
        .filter({ hasText: scorecard.title });
      await expect(section).toBeVisible();
      await expect(section).toContainText(scorecard.title);
      await expect(section).toContainText(scorecard.description);
      await expect(section).toContainText(/Success/);
      await expect(section).toContainText(/Warning/);
      await expect(section).toContainText(/Error/);
    },
    async expectScorecardVisible(title: string) {
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    },
    async expectScorecardHidden(title: string) {
      await expect(page.getByText(title, { exact: true })).toBeHidden();
    },
    async expectErrorHeading(errorText: string) {
      await expect(
        page.getByText(errorText, { exact: true }).first(),
      ).toBeVisible();
    },
    async navigateToHome() {
      await uiHelper.openSidebar("Home");
    },
    async enterEditMode() {
      await page.getByRole("button", { name: "Edit" }).click();
    },
    async enterEditModeIfNeeded() {
      const editButton = page.getByRole("button", { name: "Edit" });
      if (await editButton.isVisible()) await editButton.click();
    },
    async openAddWidgetDialog() {
      await page.getByRole("button", { name: "Add widget" }).click();
    },
    async selectWidget(cardName: string) {
      await page.getByRole("button", { name: cardName }).click();
    },
    async expectNoProgressBar() {
      await expect(
        page.getByRole("article").getByRole("progressbar").first(),
      ).toBeHidden({ timeout: 5000 });
    },
    async saveChanges() {
      await page.getByRole("button", { name: "Save" }).click();
    },
    async expectAggregatedScorecardVisible(metricTitle: string) {
      await expect(
        page.locator("article").filter({ hasText: metricTitle }),
      ).toBeVisible();
    },
    async getAggregatedScorecardEntityCount(
      metricTitle: string,
    ): Promise<number> {
      const card = page.locator("article").filter({ hasText: metricTitle });
      const text = await card.textContent();
      const match = text?.match(/(\d+)\s*entities/);
      return match ? Number.parseInt(match[1], 10) : 0;
    },
    async expectAggregatedScorecardEntityCountToBe(
      metricTitle: string,
      expectedCount: number,
    ) {
      const card = page.locator("article").filter({ hasText: metricTitle });
      await expect(card).toContainText(`${expectedCount} entities`);
    },
  };
}

export type ScorecardHelpers = ReturnType<typeof scorecardHelpers>;
