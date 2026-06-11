import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { type CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { type BrowserContext } from "@playwright/test";
import {
  createScorecardContext,
  deployRhdh,
  type AggregatedScorecardHelpers,
  type ScorecardHelpers,
} from "../utils/setup";
import { FILECHECK_METRICS } from "../utils/scorecard";

test.describe.serial("Scorecard Filecheck Tests", () => {
  let context: BrowserContext | undefined;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;
  let aggregated: AggregatedScorecardHelpers;

  test.beforeAll(async ({ browser, rhdh }) => {
    await deployRhdh(rhdh, {
      appConfig: "tests/config/filecheck/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/filecheck/dynamic-plugins.yaml",
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

  test("Setup filecheck aggregated scorecard on homepage", async () => {
    await scorecard.navigateToHome();
    await scorecard.addWidget("README file exists");
    await scorecard.expectNoProgressBar();
    // A second widget triggers Save and persists the layout to user settings.
    // Without this, runAggregatedScorecardDrilldownScenario's page.reload() leaves
    // an empty homepage (single addWidget often skips Save on a fresh page).
    await scorecard.addWidget("Entity section");
    await scorecard.expectNoProgressBar();
    await scorecard.expectAggregatedScorecardVisible(
      FILECHECK_METRICS.readme.title,
    );
  });

  test.describe("Aggregated scorecard drill-down", () => {
    test.describe.configure({ retries: 1 });

    test("Aggregated scorecard (README file exists): drill-down and table UI", async () => {
      await aggregated.runAggregatedScorecardDrilldownScenario(
        () => scorecard.navigateToHome(),
        FILECHECK_METRICS.readme,
        "filecheck.readme",
        {
          thresholdRules: [
            { key: "exist", color: "rgb(46, 125, 50)" },
            { key: "missing", color: "rgb(211, 47, 47)" },
          ],
        },
      );
    });
  });

  const filecheckCases = [
    {
      entity: "filecheck-scorecard-github",
      key: "readme",
      expected: "exist",
    },
    {
      entity: "filecheck-scorecard-gitlab",
      key: "readme",
      expected: "exist",
    },
  ] as const;

  for (const { entity, key, expected } of filecheckCases) {
    test(`filecheck.${key} is '${expected}' for ${entity}`, async () => {
      await scorecard.expectFilecheckForEntity(
        async () => {
          await catalog.go();
          await catalog.goToByName(entity);
        },
        FILECHECK_METRICS[key].title,
        expected,
      );
    });
  }
});
