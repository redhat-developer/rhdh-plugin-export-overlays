import { expect, type Locator, type Page } from "@playwright/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { ScorecardMetric } from "./types";
import { DEFAULT_THRESHOLDS } from "./constants";
import { thresholdRuleLegendLocator } from "./thresholds";

/**
 * Temporal fix for https://redhat.atlassian.net/browse/RHDHBUGS-3898.
 * The entity tab links navigate the document instead of routing client side,
 * so when opening a tab the sign-in page comes back.
 */
async function ensureSignedIn(page: Page, expectedLocator: Locator) {
  const signIn = page.getByRole("button", { name: "Sign In", exact: true });

  // Wait for whichever renders first - sign in or expected locator
  const signedOut = await Promise.race([
    signIn
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => null),
    expectedLocator
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => false)
      .catch(() => null),
  ]);
  if (!signedOut) return;

  // The Keycloak SSO session is still alive, so this just lands back on the tab when sign in is clicked.
  await signIn.click();
  await expect(expectedLocator).toBeVisible({ timeout: 60_000 });
}

export function scorecardHelpers(page: Page, uiHelper: UIhelper) {
  const getScorecardCard = (metric: Pick<ScorecardMetric, "title">) =>
    page
      .locator('[role="article"]')
      .filter({ has: page.getByText(metric.title, { exact: true }) });

  return {
    getScorecardCard,
    async openTab() {
      const tab = page.getByRole("link", { name: "Scorecard" });
      await expect(tab).toBeVisible();
      await tab.click();
      await ensureSignedIn(page, tab);
    },
    async expectEmptyState() {
      await expect(page.getByText("No scorecards added yet")).toBeVisible();
      await expect(
        page.getByText(
          "Scorecards help you monitor component health at a glance. To begin, explore our documentation for setup guidelines.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "View documentation" }),
      ).toBeVisible();
    },
    async expectScorecardCardVisible(metric: ScorecardMetric) {
      await expect(getScorecardCard(metric)).toBeVisible();
    },
    async validateScorecardAriaFor(
      scorecard: ScorecardMetric,
      options?: { visualization?: "sparkline" },
    ) {
      const scorecardCard = getScorecardCard(scorecard);
      await expect(scorecardCard).toBeVisible();
      await expect(scorecardCard).toContainText(scorecard.title);
      await expect(scorecardCard).toContainText(scorecard.description);
      await this.validateThresholdLegend(scorecard, options);
    },
    async validateThresholdLegend(
      metric: ScorecardMetric,
      options?: { visualization?: "sparkline" },
    ) {
      const scorecardCard = getScorecardCard(metric);
      await expect(scorecardCard).toBeVisible();

      const rules = metric.thresholds ?? DEFAULT_THRESHOLDS;
      for (const rule of rules) {
        await expect(
          thresholdRuleLegendLocator(scorecardCard, rule, true),
        ).toBeVisible();
        if (options?.visualization === "sparkline") {
          const legendItem = scorecardCard.getByTestId(
            `sparkline-threshold-legend-item-${rule.keyLabel.toLowerCase()}`,
          );
          await expect(legendItem).toBeVisible();
          if (rule.color) {
            await expect(
              legendItem.getByTestId("sparkline-threshold-color"),
            ).toHaveCSS("stroke", rule.color);
          }
        } else {
          const swatch = scorecardCard.getByTestId(
            `legend-colorbox-${rule.keyLabel.toLowerCase()}`,
          );
          if (rule.color) {
            await expect(swatch).toHaveCSS("background-color", rule.color);
          }
        }
      }
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
        await editButton.waitFor({ state: "visible", timeout: 10_000 });
        await editButton.click();
      } catch {
        // Edit button never appeared — already in edit mode.
      }
    },
    async addWidget(cardName: string, options?: { exact?: boolean }) {
      await this.enterEditModeIfNeeded();
      await this.openAddWidgetDialog();
      await this.selectWidget(cardName, options);
      try {
        await page
          .getByRole("button", { name: "Save" })
          .click({ timeout: 3000 });
      } catch {
        // Widget auto-saved (e.g. first widget on a fresh page)
      }
      await page
        .getByRole("button", { name: "Save" })
        .waitFor({ state: "hidden", timeout: 5000 });
    },
    async openAddWidgetDialog() {
      await page.getByRole("button", { name: "Add widget" }).click();
    },
    async selectWidget(cardName: string, options?: { exact?: boolean }) {
      const widget = page
        .getByRole("button", {
          name: cardName,
          exact: options?.exact,
        })
        .first();
      await widget.scrollIntoViewIfNeeded();
      await widget.click();
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
        page
          .locator('[role="article"]')
          .filter({ hasText: metricTitle })
          .first(),
      ).toBeVisible({ timeout: 90_000 });
    },
    async getAggregatedScorecardEntityCount(
      metricTitle: string,
    ): Promise<number> {
      const card = page
        .locator('[role="article"]')
        .filter({ hasText: metricTitle });
      const text = await card.textContent();
      const match = text?.match(/(\d+)\s*entities/);
      return match ? Number.parseInt(match[1], 10) : 0;
    },
    async expectAggregatedScorecardEntityCountToBe(
      metricTitle: string,
      expectedCount: number,
    ) {
      const card = page
        .locator('[role="article"]')
        .filter({ hasText: metricTitle });
      await expect(card).toContainText(`${expectedCount} entities`);
    },
    async expectFilecheckForEntity(
      navigate: () => Promise<void>,
      metricTitle: string,
      expectedStatus: "exist" | "missing",
    ) {
      await navigate();
      await this.openTab();
      const iconTestId =
        expectedStatus === "exist"
          ? "CheckCircleOutlineIcon"
          : "DangerousOutlinedIcon";
      await this.expectScorecardValue(metricTitle, iconTestId);
    },
    async expectScorecardValue(
      metricTitle: string,
      expectedIconTestId: string,
    ) {
      const section = page
        .locator('[role="article"]')
        .filter({ hasText: metricTitle });
      await expect(section).toBeVisible({ timeout: 60_000 });
      await expect(section.getByRole("progressbar")).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(
        section.locator(`[data-testid="${expectedIconTestId}"]`),
      ).toBeVisible({ timeout: 90_000 });
    },
    async openDataSourcesDialog(card: Locator): Promise<Locator> {
      await card.getByRole("button", { name: /more options/i }).click();
      await page.getByRole("menuitem", { name: /view data sources/i }).click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      return dialog;
    },
    async closeDataSourcesDialog(dialog: Locator): Promise<void> {
      await dialog.getByRole("button", { name: "Close" }).last().click();
      await expect(dialog).toBeHidden();
    },
    async expectDataSourcesDialog(
      scorecard: Pick<ScorecardMetric, "title">,
      verifyData?: (locator: Locator) => Promise<void>,
    ): Promise<void> {
      const card = getScorecardCard(scorecard);
      await expect(card).toBeVisible({ timeout: 90_000 });

      const dialog = await this.openDataSourcesDialog(card);
      await expect(dialog).toContainText(`${scorecard.title} sources`);

      const dataSourcesDialogColumns = [
        "PLUGIN",
        "CHECK",
        "VALUE",
        "STATUS",
        "LAST SYNCED",
      ];
      for (const column of dataSourcesDialogColumns) {
        await expect(dialog.getByText(column, { exact: true })).toBeVisible();
      }

      await verifyData?.(dialog);

      await this.closeDataSourcesDialog(dialog);
    },
  };
}

export type ScorecardHelpers = ReturnType<typeof scorecardHelpers>;
