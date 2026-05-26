import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { type BrowserContext, type Page } from "@playwright/test";
import {
  aggregatedScorecardHelpers,
  type AggregatedScorecardHelpers,
} from "../utils/aggregated-scorecard";
import {
  FILECHECK_METRICS,
  OPENSSF_LICENSE_SCORECARD,
  OPENSSF_MAINTAINED_SCORECARD,
  SCORECARD_METRICS,
  scorecardHelpers,
  type ScorecardHelpers,
} from "../utils/scorecard";

test.describe.serial("Scorecard Plugin Tests", () => {
  // Override the 90 s base timeout for all tests and hooks in this group.
  // beforeAll: deploy (~5 min) + filecheck poll (~5 min) + github poll (~2 min) = ~12 min max.
  test.describe.configure({ timeout: 15 * 60 * 1000 });

  let context: BrowserContext | undefined;
  let page: Page;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;
  let aggregated: AggregatedScorecardHelpers;

  let initialGithubCount: number;
  let initialJiraCount: number;

  test.beforeAll(async ({ browser, rhdh }) => {
    await rhdh.configure({
      auth: "keycloak",
      version: process.env.RHDH_VERSION ?? "1.10",
    });
    await rhdh.deploy();

    // Wait 2 minutes for deployment to stabilize before running tests
    await new Promise((resolve) => setTimeout(resolve, 2 * 60 * 1000));

    context = await browser.newContext({
      baseURL: rhdh.rhdhUrl,
    });
    page = await context.newPage();
    const uiHelper = new UIhelper(page);
    catalog = new CatalogPage(page);
    scorecard = scorecardHelpers(page, uiHelper);
    aggregated = aggregatedScorecardHelpers(page);
    await new LoginHelper(page).loginAsKeycloakUser();
    await uiHelper.goToPageUrl("/", "Welcome back!");
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
    await scorecard.addWidget("README file exists");
    await scorecard.expectNoProgressBar();

    const [githubMetric, jiraMetric] = SCORECARD_METRICS;

    await scorecard.expectAggregatedScorecardVisible(githubMetric.title);
    await scorecard.expectAggregatedScorecardVisible(jiraMetric.title);
    await scorecard.expectAggregatedScorecardVisible(
      FILECHECK_METRICS.readme.title,
    );

    initialGithubCount = await scorecard.getAggregatedScorecardEntityCount(
      githubMetric.title,
    );
    initialJiraCount = await scorecard.getAggregatedScorecardEntityCount(
      jiraMetric.title,
    );
  });
  test.describe("Aggregated scorecard drill-down", () => {
    test.describe.configure({ retries: 1 });
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

  test("Aggregated scorecard (README file exists): drill-down and table UI", async () => {
    test.skip(
      process.env.E2E_NIGHTLY_MODE === "true",
      "fails in nightly runs https://redhat.atlassian.net/browse/RHDHBUGS-3191",
    );
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

  test.describe("Entity Scorecards", () => {
    test("Validate scorecard tabs for GitHub PRs and Jira tickets", async () => {
      await catalog.go();
      await catalog.goToByName("all-scorecards");
      await scorecard.openTab();

      for (const metric of SCORECARD_METRICS) {
        await scorecard.validateScorecardAriaFor(metric);
      }

      const [maintainedMetric] = OPENSSF_MAINTAINED_SCORECARD;
      await scorecard.expectScorecardHidden(maintainedMetric.title);
      for (const metric of OPENSSF_LICENSE_SCORECARD) {
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

    test("Validate OpenSSF scorecards with disabled metrics excluded", async () => {
      await page.waitForTimeout(6000);
      await catalog.go();
      await catalog.goToByName("openssf-scorecard-only");
      await scorecard.openTab();

      const [githubMetric, jiraMetric] = SCORECARD_METRICS;
      const [maintainedMetric] = OPENSSF_MAINTAINED_SCORECARD;

      await scorecard.expectScorecardHidden(githubMetric.title);
      await scorecard.expectScorecardHidden(jiraMetric.title);
      await scorecard.expectScorecardHidden(maintainedMetric.title);
      await scorecard.expectScorecardHidden(
        FILECHECK_METRICS.readme.title,
      );
      await scorecard.expectScorecardHidden(
        FILECHECK_METRICS.license.title,
      );

      for (const metric of OPENSSF_LICENSE_SCORECARD) {
        await scorecard.validateScorecardAriaFor(metric);
      }
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

    const filecheckCases = [
      {
        entity: "filecheck-scorecard-github",
        key: "readme",
        expected: "exist",
      },
      {
        entity: "filecheck-scorecard-github",
        key: "license",
        expected: "missing",
      },
      {
        entity: "filecheck-scorecard-gitlab",
        key: "readme",
        expected: "exist",
      },
      {
        entity: "filecheck-scorecard-gitlab",
        key: "license",
        expected: "missing",
      },
    ] as const;

    for (const { entity, key, expected } of filecheckCases) {
      test(`filecheck.${key} is '${expected}' for ${entity}`, async () => {
        test.skip(
          process.env.E2E_NIGHTLY_MODE === "true" &&
            entity.startsWith("filecheck"),
          "fails in nightly runs https://redhat.atlassian.net/browse/RHDHBUGS-3191",
        );
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
