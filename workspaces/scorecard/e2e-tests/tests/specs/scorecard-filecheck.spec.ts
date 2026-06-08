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
  scorecardHelpers,
  type ScorecardHelpers,
} from "../utils/scorecard";

test.describe.serial("Scorecard Filecheck Tests", () => {
  let context: BrowserContext | undefined;
  let page: Page;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;
  let aggregated: AggregatedScorecardHelpers;

  test.beforeAll(async ({ browser, rhdh }) => {
    await rhdh.configure({
      auth: "keycloak",
      version: process.env.RHDH_VERSION ?? "1.10",
    });
    await rhdh.deploy();

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

  test("Setup filecheck aggregated scorecard on homepage", async () => {
    await scorecard.navigateToHome();
    await scorecard.addWidget("README file exists");
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
