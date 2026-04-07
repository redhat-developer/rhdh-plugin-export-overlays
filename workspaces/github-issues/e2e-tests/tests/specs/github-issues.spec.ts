import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  APIHelper,
  GITHUB_API_ENDPOINTS,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

interface GHIssue {
  pull_request: boolean; // eslint-disable-line @typescript-eslint/naming-convention
  title: string;
}

test.describe("Test github-issues", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "github" });
    await rhdh.deploy();
  });

  test("Verify that the Issues tab renders all the open github issues in the repository", async ({
    loginHelper,
    page,
    uiHelper,
  }) => {
    const component = "Red Hat Developer Hub";
    await loginHelper.loginAsGithubUser();

    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Component");
    await uiHelper.clickLink(component);

    await uiHelper.clickTab("Issues");
    await page.getByRole("button", { name: "Log in" }).click();
    await loginHelper.checkAndReauthorizeGithubApp();

    const response = (await APIHelper.getGithubPaginatedRequest(
      GITHUB_API_ENDPOINTS.issues("open"),
    )) as GHIssue[];
    const openIssues = response.filter((issue) => !issue.pull_request);

    const issuesCountText = new RegExp(
      `All repositories \\(${openIssues.length} Issue.*\\)`,
    );
    await expect(page.getByText(issuesCountText)).toBeVisible();

    for (const issue of openIssues.slice(0, 5)) {
      await uiHelper.verifyText(issue.title.replace(/\s+/g, " "));
    }
  });
});
