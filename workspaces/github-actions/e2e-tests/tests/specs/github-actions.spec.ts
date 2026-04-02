import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  APIHelper,
  GITHUB_API_ENDPOINTS,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

test.describe("Test github-actions", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "github" });
    await rhdh.deploy();
  });

  test("Verify that the CI tab renders 5 most recent github actions", async ({
    page,
    loginHelper,
    uiHelper,
  }) => {
    const component = "Red Hat Developer Hub";
    await loginHelper.loginAsGithubUser();

    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Component");
    await uiHelper.searchInputPlaceholder(component);
    await uiHelper.clickLink(component);

    await page.locator("a").getByText("CI", { exact: true }).first().click();
    await page.getByRole("button", { name: "Log in" }).click();
    await loginHelper.checkAndReauthorizeGithubApp();

    const response = await APIHelper.githubRequest(
      "GET",
      GITHUB_API_ENDPOINTS.workflowRuns,
    );
    const json = await response.json();
    const workflowRuns = json.workflow_runs;

    for (const workflowRun of workflowRuns.slice(0, 5)) {
      await uiHelper.verifyText(workflowRun.id);
    }
  });
});
