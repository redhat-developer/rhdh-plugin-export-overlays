import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { type CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { type BrowserContext, type Locator } from "@playwright/test";
import {
  createScorecardContext,
  deployRhdh,
  type ScorecardHelpers,
} from "../utils/setup";
import {
  DATA_SOURCES_DIALOG_EMPTY_VALUE,
  DATA_SOURCES_DIALOG_UNAVAILABLE_VALUE,
} from "../utils/constants/constants";
import { DORA_ENTITY, DORA_METRICS } from "../utils/constants/dora-constants";
import type { ScorecardMetric } from "../utils/types";

test.describe.serial("Scorecard DORA Tests", () => {
  let context: BrowserContext | undefined;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;

  async function openDoraEntityScorecard(): Promise<void> {
    await catalog.go();
    await catalog.goToByName(DORA_ENTITY);
    await scorecard.openTab();
  }

  test.beforeAll(async ({ browser, rhdh }) => {
    await deployRhdh(rhdh, {
      dynamicPlugins: "tests/config/dora/dynamic-plugins.yaml",
      appConfig: "tests/config/dora/app-config-rhdh.yaml",
    });
    // Wait 2 minutes for deployment to stabilize before running tests
    await new Promise((resolve) => setTimeout(resolve, 2 * 60 * 1000));
    ({ context, catalog, scorecard } = await createScorecardContext(
      browser,
      rhdh.rhdhUrl,
    ));
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("Verify entity scorecards are displayed for all 4 DORA metrics", async () => {
    await openDoraEntityScorecard();

    for (const metric of DORA_METRICS) {
      // Title, description and the elite/medium/low threshold legend.
      await scorecard.validateScorecardAriaFor(metric);
    }
  });

  test("Verify aggregated scorecards are displayed for all 4 DORA metrics", async () => {
    await scorecard.navigateToHome();

    for (const metric of DORA_METRICS) {
      await scorecard.expectAggregatedScorecardVisible(
        metric.aggregationTitle ?? metric.title,
      );
    }
  });

  test("Verify View data sources displays correct data for DORA metrics", async () => {
    await openDoraEntityScorecard();

    for (const metric of DORA_METRICS) {
      await scorecard.expectDataSourcesDialog(metric, (dialog) =>
        expectDoraDatasourcesRows(dialog, metric),
      );
    }
  });

  async function expectDoraDatasourcesRows(
    dialog: Locator,
    metric: Pick<ScorecardMetric, "id" | "title" | "collectors">,
  ): Promise<void> {
    const rows = dialog.locator("tbody [role='row']");
    await expect(rows).toHaveCount(metric.collectors!.length, {
      timeout: 30_000,
    });

    for (const collector of metric.collectors!) {
      const row = rows.filter({ hasText: collector.description });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(collector.plugin);
      await expect(row).toContainText(metric.id);
      await expect(row).toContainText(DATA_SOURCES_DIALOG_EMPTY_VALUE);
      await expect(row).toContainText(DATA_SOURCES_DIALOG_UNAVAILABLE_VALUE);
    }
  }
});
