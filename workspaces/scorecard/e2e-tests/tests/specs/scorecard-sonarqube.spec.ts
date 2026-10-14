import { type BrowserContext } from "@playwright/test";
import { type CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { SONARQUBE_METRICS } from "../utils/constants";
import { deploySonarQube, readSonarQubeToken } from "../utils/sonarqube-deploy";
import {
  createScorecardContext,
  deployRhdh,
  type ScorecardHelpers,
} from "../utils/setup";

test.describe.serial("Scorecard SonarQube Tests", () => {
  let context: BrowserContext | undefined;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;

  test.beforeAll(async ({ browser, rhdh }) => {
    const namespace = rhdh.deploymentConfig.namespace;
    await test.runOnce(`scorecard-sonarqube-setup-${namespace}`, async () => {
      await deploySonarQube(rhdh.k8sClient, namespace);
    });
    // envsubst reads this while RHDH secrets are applied, then it is removed
    // so later failures do not inherit it. The reader does not log the value.
    process.env.SONARQUBE_TOKEN = readSonarQubeToken(namespace);
    try {
      await deployRhdh(rhdh, {
        appConfig: "tests/config/sonarqube/app-config-rhdh.yaml",
        dynamicPlugins: "tests/config/sonarqube/dynamic-plugins.yaml",
      });
    } finally {
      delete process.env.SONARQUBE_TOKEN;
    }
    await new Promise((resolve) => setTimeout(resolve, 2 * 60 * 1000));
    ({ context, catalog, scorecard } = await createScorecardContext(
      browser,
      rhdh.rhdhUrl,
    ));
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("default instance shows analyzed SonarQube metrics", async () => {
    await catalog.go();
    await catalog.goToByName("sonarqube-default");
    await scorecard.openTab();

    await scorecard.expectScorecardValue(
      SONARQUBE_METRICS.qualityGate.title,
      "CheckCircleOutlineIcon",
    );
    await scorecard.expectScorecardValue(
      SONARQUBE_METRICS.openIssues.title,
      "CheckCircleOutlineIcon",
    );
    await scorecard.expectScorecardValue(
      SONARQUBE_METRICS.codeCoverage.title,
      "CheckCircleOutlineIcon",
    );
    await expect(
      scorecard.getScorecardCard(SONARQUBE_METRICS.codeCoverage),
    ).toContainText("100");
    await scorecard.expectScorecardValue(
      SONARQUBE_METRICS.securityRating.title,
      "CheckCircleOutlineIcon",
    );
  });

  test("named instance shows the low-coverage project", async () => {
    await catalog.go();
    await catalog.goToByName("sonarqube-low");
    await scorecard.openTab();

    await scorecard.expectScorecardValue(
      SONARQUBE_METRICS.codeCoverage.title,
      "DangerousOutlinedIcon",
    );
    await expect(
      scorecard.getScorecardCard(SONARQUBE_METRICS.codeCoverage),
    ).toContainText("33");
  });

  test("missing project shows the metric error state", async () => {
    await catalog.go();
    await catalog.goToByName("sonarqube-missing");
    await scorecard.openTab();
    await scorecard.expectErrorHeading("Metric data unavailable");
  });

  test("entity without a project key has an empty scorecard", async () => {
    await catalog.go();
    await catalog.goToByName("sonarqube-none");
    await scorecard.openTab();
    await scorecard.expectEmptyState();
  });
});
