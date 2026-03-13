import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import type { BrowserContext, Page } from "@playwright/test";
import {
  SCORECARD_METRICS,
  scorecardHelpers,
  type ScorecardHelpers,
} from "../utils/scorecard";

test.describe.serial("Scorecard Plugin Tests", () => {
  let context: BrowserContext | undefined;
  let page: Page;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;

  let initialGithubCount: number;
  let initialJiraCount: number;

  test.beforeAll(async ({ browser, rhdhDeploymentWorker }) => {
    // Allow time for deployment + 2 min stabilization delay + browser setup
    test.setTimeout(10 * 60 * 1000);

    await rhdhDeploymentWorker.configure({
      auth: "keycloak",
      version: process.env.RHDH_VERSION ?? "1.10",
    });
    await rhdhDeploymentWorker.deploy();

    // Wait 2 minutes for deployment to stabilize before running tests
    await new Promise((resolve) => setTimeout(resolve, 2 * 60 * 1000));

    context = await browser.newContext({
      baseURL: rhdhDeploymentWorker.rhdhUrl,
    });
    page = await context.newPage();
    const uiHelper = new UIhelper(page);
    catalog = new CatalogPage(page);
    scorecard = scorecardHelpers(page, uiHelper);
    await new LoginHelper(page).loginAsKeycloakUser();
    await uiHelper.goToPageUrl("/", "Welcome back!");
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("Setup aggregated scorecards on homepage", async () => {
    await scorecard.navigateToHome();

    await scorecard.enterEditModeIfNeeded();
    await scorecard.openAddWidgetDialog();
    await scorecard.selectWidget("GitHub open PRs");
    await scorecard.expectNoProgressBar();
    await scorecard.enterEditMode();
    await scorecard.expectNoProgressBar();
    await scorecard.openAddWidgetDialog();
    await scorecard.selectWidget("Jira open blocking tickets");
    await scorecard.saveChanges();

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

  test.describe("Entity Scorecards", () => {
    test("Validate scorecard tabs for GitHub PRs and Jira tickets", async () => {
      await page.waitForTimeout(6000);
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
