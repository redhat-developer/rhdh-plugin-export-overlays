import { expect, type Page } from "@playwright/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export const FILECHECK_METRICS = {
  readme: {
    title: "File check: readme",
    description: "Checks whether the readme file exists in the repository.",
    thresholdLabels: ["Exist", "Missing"],
  },
  license: {
    title: "File check: license",
    description: "Checks whether the license file exists in the repository.",
    thresholdLabels: ["Exist", "Missing"],
  },
} as const;

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
      try {
        // Wait for the page to settle after navigation before checking edit state.
        // isVisible() is a snapshot and returns false on a page that is still loading.
        await editButton.waitFor({ state: "visible", timeout: 10_000 });
        await editButton.click();
      } catch {
        // Edit button never appeared — already in edit mode.
      }
    },
    async addWidget(cardName: string) {
      await this.enterEditModeIfNeeded();
      await this.openAddWidgetDialog();
      await this.selectWidget(cardName);
      // Auto-wait for Save button then click it; fall back if widget auto-saved
      try {
        await page
          .getByRole("button", { name: "Save" })
          .click({ timeout: 3000 });
      } catch {
        // Widget auto-saved (e.g. first widget on a fresh page)
      }
      // Wait for Save to disappear — confirms we've exited edit mode
      await page
        .getByRole("button", { name: "Save" })
        .waitFor({ state: "hidden", timeout: 5000 });
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
      ).toBeHidden({ timeout: 30_000 });
    },
    async saveChanges() {
      await page.getByRole("button", { name: "Save" }).click();
    },
    async expectAggregatedScorecardVisible(metricTitle: string) {
      await expect(
        page.locator("article").filter({ hasText: metricTitle }),
      ).toBeVisible({ timeout: 90_000 });
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
    async expectFilecheckForEntity(
      navigate: () => Promise<void>,
      metricTitle: string,
      expectedStatus: "exist" | "missing",
    ) {
      await navigate();
      await this.openTab();
      await this.expectFilecheckValue(metricTitle, expectedStatus);
    },
    async expectFilecheckValue(
      metricTitle: string,
      expectedStatus: "exist" | "missing",
    ) {
      const section = page.locator("article").filter({ hasText: metricTitle });
      // Wait for the article to appear, then for any loading spinner inside it to clear
      await expect(section).toBeVisible({ timeout: 60_000 });
      await expect(section.getByRole("progressbar")).toHaveCount(0, {
        timeout: 60_000,
      });
      const iconTestId =
        expectedStatus === "exist"
          ? "CheckCircleOutlineIcon"
          : "DangerousOutlinedIcon";
      await expect(
        section.locator(`[data-testid="${iconTestId}"]`),
      ).toBeVisible({ timeout: 90_000 });
    },
  };
}

export type ScorecardHelpers = ReturnType<typeof scorecardHelpers>;
