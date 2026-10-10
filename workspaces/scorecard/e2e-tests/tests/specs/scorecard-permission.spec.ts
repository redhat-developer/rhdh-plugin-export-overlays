import { expect, type BrowserContext, type Page } from "@playwright/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { deployRhdh } from "../utils/setup";
import { scorecardHelpers } from "../utils/scorecard";

test.describe.serial("Scorecard permission", () => {
  let context: BrowserContext | undefined;
  let page: Page;

  test.beforeAll(async ({ browser, rhdh }) => {
    const rbacConfigmapPath = WorkspacePaths.resolve(
      "tests/config/permission/rbac-configmap.yaml",
    );

    await deployRhdh(rhdh, {
      appConfig: "tests/config/permission/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/permission/dynamic-plugins.yaml",
      valueFile: "tests/config/permission/value_file.yaml",
      beforeDeploy: async (deployment) => {
        await $`oc apply -f ${rbacConfigmapPath} -n ${deployment.deploymentConfig.namespace}`;
      },
    });

    context = await browser.newContext({ baseURL: rhdh.rhdhUrl });
    page = await context.newPage();
    await new LoginHelper(page).loginAsKeycloakUser("test2", "test2@123");
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("shows missing permission without scorecard.metric.read", async () => {
    const catalog = new CatalogPage(page);
    const scorecard = scorecardHelpers(page, new UIhelper(page));

    await catalog.go();
    await catalog.goToByName("no-scorecards");
    await scorecard.openTab();

    await expect(page.getByText("Missing permission")).toBeVisible();
    await expect(page.getByText(/scorecard\.metric\.read/)).toBeVisible();
  });
});
