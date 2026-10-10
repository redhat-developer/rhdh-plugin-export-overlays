import { type BrowserContext, type Locator } from "@playwright/test";
import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  DATA_SOURCES_DIALOG_EMPTY_VALUE,
  DATA_SOURCES_DIALOG_UNAVAILABLE_VALUE,
  DORA_METRICS,
} from "../utils/constants";
import {
  createScorecardContext,
  deployRhdh,
  type AggregatedScorecardHelpers,
  type ScorecardHelpers,
} from "../utils/setup";
import type { ScorecardMetric } from "../utils/types";
import { CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";

test.describe.serial("Scorecard DORA Tests", () => {
  let context: BrowserContext | undefined;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;
  let aggregated: AggregatedScorecardHelpers;

  async function openDoraEntityScorecard(): Promise<void> {
    await catalog.go();
    await catalog.goToByName("dora-scorecard");
    await scorecard.openTab();
  }

  test.beforeAll(async ({ browser, rhdh }) => {
    await deployRhdh(rhdh, {
      dynamicPlugins: "tests/config/dora/dynamic-plugins.yaml",
      appConfig: "tests/config/dora/app-config-rhdh.yaml",
    });
    // Wait 2 minutes for deployment to stabilize before running tests
    await new Promise((resolve) => setTimeout(resolve, 2 * 60 * 1000));
    ({ context, catalog, scorecard, aggregated } = await createScorecardContext(
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
      await scorecard.validateScorecardAriaFor(metric, {
        visualization: "sparkline",
      });
    }

    // Collector rows in the data-sources dialog always render "--" and "N/A".
    // The sparkline current value is what shows a collected deployment frequency.
    const [deploymentFrequencyMetric] = DORA_METRICS;
    await scorecard.expectSparklineCurrentValue(deploymentFrequencyMetric);
  });

  test("Verify View data sources displays correct data for DORA metrics", async () => {
    await openDoraEntityScorecard();

    for (const metric of DORA_METRICS) {
      await scorecard.expectDataSourcesDialog(metric, (dialog) =>
        expectDoraDatasourcesRows(dialog, metric),
      );
    }
  });

  test.describe("Aggregated scorecards", () => {
    test.describe.configure({ retries: 1 });

    test("Verify aggregated scorecards are displayed for all 4 DORA metrics", async () => {
      await scorecard.navigateToHome();

      for (const metric of DORA_METRICS) {
        await scorecard.expectAggregatedScorecardVisible(
          metric.aggregationTitle ?? metric.title,
        );
      }
    });

    test("Aggregated scorecard (DORA Deployment Frequency): View data sources", async () => {
      const [deploymentFrequencyMetric] = DORA_METRICS;

      await scorecard.expectDataSourcesDialog(
        deploymentFrequencyMetric,
        (dialog) =>
          expectDoraDatasourcesRows(dialog, deploymentFrequencyMetric),
      );
    });

    test("Aggregated scorecard (DORA Deployment Frequency): drill-down and table UI", async () => {
      const [deploymentFrequencyMetric] = DORA_METRICS;

      await aggregated.runAggregatedScorecardDrilldownScenario(
        () => scorecard.navigateToHome(),
        deploymentFrequencyMetric,
        "doraDeploymentFrequencyKpi",
        {
          showCurrent: true,
          showThresholdExpressions: true,
          visualization: "sparkline",
        },
      );
    });
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
