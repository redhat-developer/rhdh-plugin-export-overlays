import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { type CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { type BrowserContext } from "@playwright/test";
import {
  createScorecardContext,
  deployRhdh,
  type AggregatedScorecardHelpers,
  type ScorecardHelpers,
} from "../utils/setup";
import { SCORECARD_METRICS } from "../utils/scorecard";

test.describe.serial("Scorecard Plugin Tests", () => {
  let context: BrowserContext | undefined;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;
  let aggregated: AggregatedScorecardHelpers;

  let initialGithubCount: number;
  let initialJiraCount: number;

  test.beforeAll(async ({ browser, rhdh }) => {
    await deployRhdh(rhdh, {
      dynamicPlugins: "tests/config/dynamic-plugins.yaml",
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

  test("Setup aggregated scorecards on homepage", async () => {
    await scorecard.navigateToHome();

    await scorecard.addWidget("GitHub open PRs");
    await scorecard.expectNoProgressBar();
    await scorecard.addWidget("Jira open blocking tickets");
    await scorecard.expectNoProgressBar();

    const [githubMetric, jiraMetric] = SCORECARD_METRICS;

    await scorecard.expectAggregatedScorecardVisible(githubMetric.title);
    await scorecard.expectAggregatedScorecardVisible(jiraMetric.title);

    initialGithubCount = await scorecard.getAggregatedScorecardEntityCount(
      githubMetric.title,
    );
    initialJiraCount = await scorecard.getAggregatedScorecardEntityCount(
      jiraMetric.title,
    );
  });

  test("Aggregated scorecard (GitHub): info tooltips, drill-down, table UI", async () => {
    const [githubMetric] = SCORECARD_METRICS;
    await aggregated.runAggregatedScorecardDrilldownScenario(
      () => scorecard.navigateToHome(),
      githubMetric,
      "github.open_prs",
      {
        thresholdRules: [
          { key: "ideal", color: "rgb(180, 211, 178)" },
          { key: "warning", color: "rgb(250, 213, 165)" },
          { key: "critical", color: "rgb(250, 160, 160)" },
        ],
      },
    );
  });

  test("Aggregated scorecard (Jira): no data found blocks drill-down", async () => {
    const [, jiraMetric] = SCORECARD_METRICS;
    await aggregated.runAggregatedScorecardNoDataHomepageScenario(
      () => scorecard.navigateToHome(),
      jiraMetric,
      "jira.open_issues",
      { skipIfHasDrilldown: true },
    );
  });

  test.describe("Entity Scorecards", () => {
    test("Validate scorecard tabs for GitHub PRs and Jira tickets", async () => {
      await catalog.go();
      await catalog.goToByName("all-scorecards");
      await scorecard.openTab();

      for (const metric of SCORECARD_METRICS) {
        await scorecard.validateScorecardAriaFor(metric);
      }
    });

    test("Validate empty scorecard state", async () => {
      await catalog.go();
      await catalog.goToByName("no-scorecards");
      await scorecard.openTab();
      await scorecard.expectEmptyState();
    });

    test("Displays error state for unavailable data while rendering metrics", async () => {
      await catalog.go();
      await catalog.goToByName("unavailable-metric-service");
      await scorecard.openTab();

      const [githubMetric, jiraMetric] = SCORECARD_METRICS;

      await scorecard.expectScorecardVisible(githubMetric.title);
      await scorecard.expectScorecardVisible(jiraMetric.title);
      await scorecard.expectErrorHeading("Metric data unavailable");
      await scorecard.validateScorecardAriaFor(jiraMetric);
    });

    test("Validate only GitHub scorecard is displayed", async () => {
      await catalog.go();
      await catalog.goToByName("github-scorecard-only");
      await scorecard.openTab();

      const [githubMetric, jiraMetric] = SCORECARD_METRICS;

      await scorecard.expectScorecardVisible(githubMetric.title);
      await scorecard.expectScorecardHidden(jiraMetric.title);
      await scorecard.validateScorecardAriaFor(githubMetric);
    });

    test("Validate only Jira scorecard is displayed", async () => {
      await catalog.go();
      await catalog.goToByName("jira-scorecard-only");
      await scorecard.openTab();

      const [githubMetric, jiraMetric] = SCORECARD_METRICS;

      await scorecard.expectScorecardHidden(githubMetric.title);
      await scorecard.expectScorecardVisible(jiraMetric.title);
      await scorecard.validateScorecardAriaFor(jiraMetric);
    });

    test("Display error state for invalid threshold config while rendering metrics", async () => {
      await catalog.go();
      await catalog.goToByName("invalid-threshold");
      await scorecard.openTab();

      const [githubMetric, jiraMetric] = SCORECARD_METRICS;

      await scorecard.expectScorecardVisible(githubMetric.title);
      await scorecard.expectScorecardVisible(jiraMetric.title);
      await scorecard.expectErrorHeading("Invalid thresholds");
      await scorecard.validateScorecardAriaFor(jiraMetric);
    });

    test("Display custom severity keys with custom threshold expressions, colors and icon", async () => {
      await catalog.go();
      await catalog.goToByName("github-scorecard-only");
      await scorecard.openTab();

      const [githubMetric] = SCORECARD_METRICS;
      await scorecard.validateThresholdLegend(githubMetric, [
        { key: "ideal", expression: "<30", color: "rgb(180, 211, 178)" },
        { key: "warning", expression: "30-70", color: "rgb(250, 213, 165)" },
        { key: "critical", expression: ">70", color: "rgb(250, 160, 160)" },
      ]);
      await scorecard.expectScorecardValue(githubMetric.title, "StarIcon");
    });

    // Re-enable once https://issues.redhat.com/browse/RHIDP-12130 is fixed
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip("Validate scorecards on imported addon-test entity", async () => {
      await catalog.go();
      await catalog.goToByName("addon-test");
      await scorecard.openTab();

      const [githubMetric, jiraMetric] = SCORECARD_METRICS;

      await scorecard.expectScorecardVisible(githubMetric.title);
      await scorecard.expectScorecardVisible(jiraMetric.title);
    });

    // Re-enable once https://issues.redhat.com/browse/RHIDP-12130 is fixed
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip("Verify aggregated scorecard counts increased after import", async () => {
      await scorecard.navigateToHome();

      const [githubMetric, jiraMetric] = SCORECARD_METRICS;

      await scorecard.expectAggregatedScorecardEntityCountToBe(
        githubMetric.title,
        initialGithubCount + 1,
      );
      await scorecard.expectAggregatedScorecardEntityCountToBe(
        jiraMetric.title,
        initialJiraCount + 1,
      );
    });
  });
});
