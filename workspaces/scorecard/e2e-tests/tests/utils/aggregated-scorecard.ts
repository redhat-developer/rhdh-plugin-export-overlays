import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEFAULT_THRESHOLD_LABELS, DEFAULT_THRESHOLD_RULES } from "./constants";
import type { ScorecardMetric, ThresholdRule } from "./types";

/** URL pattern for `/scorecard/aggregations/:id/metrics/:id` (matches `metricId` from dynamic-plugins). */
export function drilldownUrlPattern(metricId: string): RegExp {
  const escaped = metricId.replace(/\./g, "\\.");
  return new RegExp(
    `\\/scorecard\\/aggregations\\/${escaped}\\/metrics\\/${escaped}(\\?.*)?$`,
  );
}

/** Assertions and locators for homepage aggregated scorecards and their entity drill-down. */
export function aggregatedScorecardHelpers(page: Page) {
  const homepageCard = (metricId: string) =>
    page.getByTestId(`scorecard-homepage-card-${metricId}`);

  const impl = {
    homepageCard,

    async expectHomepageCardVisible(metricId: string) {
      await expect(homepageCard(metricId)).toBeVisible({ timeout: 30_000 });
    },

    /**
     * Tolerates slow GitHub data fetches on overloaded CI clusters. Structural
     * assertions (title, description) stay on a tight timeout; data-dependent
     * threshold labels use `expect.poll` with increasing back-off and a full
     * page reload between attempts to trigger a fresh data fetch.
     */
    async expectHomepageCardDisplaysMetricWithRetry(
      card: Locator,
      metric: ScorecardMetric,
      reload: () => Promise<void>,
    ) {
      const labels = metric.thresholdLabels ?? DEFAULT_THRESHOLD_LABELS;

      await expect(card.getByText(metric.title, { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(card).toContainText(metric.description, { timeout: 10_000 });

      for (const thresholdLabel of labels) {
        await expect
          .poll(
            async () => {
              const visible = await card
                .getByText(thresholdLabel, { exact: true })
                .isVisible();
              if (!visible) {
                await reload();
                await page.reload();
                await expect(card).toBeVisible({ timeout: 30_000 });
              }
              return visible;
            },
            {
              message: `Threshold label "${thresholdLabel}" never appeared on card "${metric.title}"`,
              intervals: [10_000, 20_000, 30_000, 45_000, 60_000],
              timeout: 5 * 60 * 1000,
            },
          )
          .toBe(true);
      }
    },

    /** Hovers each visible threshold color swatch and checks the chart tooltip text. */
    async expectChartThresholdTooltips(card: Locator, metric: ScorecardMetric) {
      const labels = metric.thresholdLabels ?? DEFAULT_THRESHOLD_LABELS;
      const chart = page.locator(".v5-MuiBox-root");

      const expectTooltipText = async () => {
        await expect(chart.getByText(/%|No entities/i)).toBeVisible({
          timeout: 10_000,
        });
      };

      for (const label of labels) {
        await page.keyboard.press("Escape");
        const swatch = card.getByTestId(
          `legend-colorbox-${label.toLowerCase()}`,
        );
        if (await swatch.isVisible()) {
          await swatch.hover();
          await expectTooltipText();
        }
      }
    },

    async expectLastUpdatedTooltip(card: Locator) {
      await page.keyboard.press("Escape");
      await card.getByTestId("scorecard-homepage-card-info").hover();
      await expect(
        page.getByRole("tooltip").filter({ hasText: /Last updated/i }),
      ).toBeVisible({ timeout: 10_000 });
    },

    drilldownLink(card: Locator) {
      return card.getByRole("link");
    },

    async openDrilldown(card: Locator) {
      await card.getByRole("link").click();
    },

    async expectDrilldownUrl(metricId: string) {
      await expect(page).toHaveURL(drilldownUrlPattern(metricId));
    },

    async expectDrilldownHeading(title: string) {
      await expect(
        page.getByRole("heading").filter({ hasText: title }).first(),
      ).toBeVisible({ timeout: 120_000 });
    },

    async expectDrilldownCardAriaSnapshot(
      metricId: string,
      metric: ScorecardMetric,
    ) {
      const card = homepageCard(metricId);
      await expect(card).toBeVisible({ timeout: 120_000 });

      const labels = metric.thresholdLabels ?? DEFAULT_THRESHOLD_LABELS;
      const thresholdLabelSnapshots = labels
        .map((l) => `            - paragraph: "${l}"`)
        .join("\n");

      await expect(card).toMatchAriaSnapshot(`
          - article:
            - text: "${metric.title}"
            - separator
            - paragraph: "${metric.description}"
${thresholdLabelSnapshots}
            - application
        `);
    },

    async expectEntityTableHeaders() {
      for (const name of [
        "Status",
        "Value",
        "Entity",
        "Owner",
        "Kind",
        "Last updated",
      ] as const) {
        await expect(page.getByRole("columnheader", { name })).toBeVisible();
      }
    },

    async expectEntityTableHasDataRow() {
      await expect(page.locator("tbody tr").first()).toBeVisible({
        timeout: 120_000,
      });
    },

    async expectEntityTablePagination() {
      await expect(
        page.getByRole("button", { name: "next page" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "previous page" }),
      ).toBeVisible();
      await expect(page.getByText(/\d-\d+ of \d+/)).toBeVisible();
    },

    async expectDrilldownThresholdLegend(
      metricId: string,
      rules: readonly Pick<ThresholdRule, "key" | "color">[],
    ) {
      const card = homepageCard(metricId);
      await expect(card).toBeVisible({ timeout: 120_000 });
      for (const rule of rules) {
        await expect(card).toContainText(
          rule.key.charAt(0).toUpperCase() + rule.key.slice(1),
        );
        const swatch = card.getByTestId(
          `legend-colorbox-${rule.key.toLowerCase()}`,
        );
        await expect(swatch).toBeVisible({ timeout: 60_000 });
        if (rule.color) {
          await expect(swatch).toHaveCSS("background-color", rule.color);
        }
      }
    },

    /**
     * Homepage card when aggregation `total === 0`: {@link EmptyStatePanel} shows
     * "No data found", helper copy, and **no** `/scorecard/aggregations/...` drill-down link.
     *
     * Use `skipIfHasDrilldown` when the environment may return data (CI vs cluster);
     * the test skips instead of failing so environments with data keep a green run.
     */
    async runAggregatedScorecardNoDataHomepageScenario(
      navigateToHome: () => Promise<void>,
      metric: ScorecardMetric,
      metricId: string,
      options?: { skipIfHasDrilldown?: boolean },
    ) {
      await navigateToHome();
      const card = impl.homepageCard(metricId);
      await expect(card).toBeVisible({ timeout: 120_000 });

      const drilldownAnchors = card.locator(
        'a[href*="/scorecard/aggregations/"]',
      );
      if (options?.skipIfHasDrilldown && (await drilldownAnchors.count()) > 0) {
        test.skip(
          true,
          "Aggregation returned entity drill-down data in this environment; this path expects total === 0 (no drill-down link on the homepage card).",
        );
      }

      await test.step("Homepage card shows metric title and description", async () => {
        await expect(
          card.getByText(metric.title, { exact: true }),
        ).toBeVisible();
        await expect(card).toContainText(metric.description);
        await expect(
          card.getByText("No data found", { exact: true }),
        ).toBeVisible();
      });

      await test.step("Drill-down is not available (no aggregation link on card)", async () => {
        await expect(drilldownAnchors).toHaveCount(0);
      });
    },

    async runAggregatedScorecardDrilldownScenario(
      navigateToHome: () => Promise<void>,
      metric: ScorecardMetric,
      metricId: string,
      options?: {
        thresholdRules?: readonly Pick<ThresholdRule, "key" | "color">[];
      },
    ) {
      await navigateToHome();
      const card = impl.homepageCard(metricId);

      await test.step("Homepage card UI is present", async () => {
        await impl.expectHomepageCardVisible(metricId);
        await impl.expectHomepageCardDisplaysMetricWithRetry(
          card,
          metric,
          async () => {
            await navigateToHome();
          },
        );
      });

      await test.step("Threshold tooltips", async () => {
        await impl.expectChartThresholdTooltips(card, metric);
      });

      await test.step("Last updated tooltip", async () => {
        await impl.expectLastUpdatedTooltip(card);
      });

      await test.step("Entity drill-down page loads and shows table", async () => {
        await impl.openDrilldown(card);
        await impl.expectDrilldownUrl(metricId);
        await impl.expectDrilldownHeading(metric.title);
      });

      await test.step("Drill-down page scorecard card snapshot", async () => {
        await impl.expectDrilldownCardAriaSnapshot(metricId, metric);
      });

      await test.step("Drill-down threshold legend", async () => {
        await impl.expectDrilldownThresholdLegend(
          metricId,
          options?.thresholdRules ?? DEFAULT_THRESHOLD_RULES,
        );
      });

      await test.step("Drill-down entity table columns and rows", async () => {
        await impl.expectEntityTableHeaders();
        await impl.expectEntityTableHasDataRow();
      });

      await test.step("Drill-down table pagination controls", async () => {
        await impl.expectEntityTablePagination();
      });
    },
  };

  return impl;
}

export type AggregatedScorecardHelpers = ReturnType<
  typeof aggregatedScorecardHelpers
>;
