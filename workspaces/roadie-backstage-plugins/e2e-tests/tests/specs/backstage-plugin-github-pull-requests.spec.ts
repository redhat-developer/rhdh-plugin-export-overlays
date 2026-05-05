import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { TABLE_SELECTORS } from "../../support/constants/github-pull-requests";
import { searchGitHubPRs } from "../../support/api/github-pull-requests";
import { PullRequestsPage } from "../../support/pages/github-pull-requests";

test.describe("Backstage Plugin - GitHub Pull Requests", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "github",
      appConfig: `${WorkspacePaths.configDir}/github-pull-requests/app-config-rhdh.yaml`,
      dynamicPlugins: `${WorkspacePaths.configDir}/github-pull-requests/dynamic-plugins.yaml`,
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper, uiHelper, page }) => {
    await loginHelper.loginAsGithubUser();

    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("Red Hat Developer Hub");

    const expectedPath = "/catalog/default/component/red-hat-developer-hub";
    await page.waitForURL(`**${expectedPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    expect(page.url()).toContain(expectedPath);

    await uiHelper.waitForTitle("Red Hat Developer Hub");
  });

  test("Click login on the login popup and verify that Overview tab renders", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.verifyLink("About RHDH", { exact: false });
    // forces the test to wait for the loading spinner to appear in place of this text, ensuring 'waitForLoad' won't skip waiting due to no spinner being present at the moment it would be called
    await uiHelper.waitForTextDisappear(
      "You are not logged into GitHub. You need to be signed in to see the content of this card.",
    );
    await uiHelper.waitForLoad();

    await uiHelper.verifyText(/Average Size Of PR\d+ lines/);
    await expect(
      page.locator(
        'a[href="https://github.com/redhat-developer/rhdh/tree/main/catalog-entities/components/"]',
      ),
    ).toBeVisible();
  });

  test.describe("Pull/Merge Requests tab", () => {
    test.beforeEach(async ({ uiHelper }) => {
      await uiHelper.clickTab("Pull/Merge Requests");
    });

    test("Verify that the Pull/Merge Requests tab renders the 5 most recently updated Open Pull Requests", async ({
      page,
      uiHelper,
    }) => {
      const prPage = new PullRequestsPage(page, uiHelper);
      const openPRs = await searchGitHubPRs("open");

      const openButton = page.getByRole("button", { name: "OPEN" });
      await expect(openButton).toBeVisible();
      await expect(openButton).toBeEnabled();
      await uiHelper.waitForLoad();

      await prPage.verifyPRRows(openPRs, 0, 5);
    });

    test("Click on the CLOSED filter and verify that the 5 most recently updated Closed PRs are rendered (same with ALL)", async ({
      page,
      uiHelper,
    }) => {
      const prPage = new PullRequestsPage(page, uiHelper);
      const closedPRs = await searchGitHubPRs("closed");

      const closedButton = page.getByRole("button", { name: "CLOSED" });
      await expect(closedButton).toBeVisible();
      await expect(closedButton).toBeEnabled();
      await uiHelper.waitForLoad();
      await closedButton.click();

      await uiHelper.waitForLoad();
      await prPage.verifyPRRows(closedPRs, 0, 5);
    });

    test("Click on the arrows to verify that the next/previous/first/last pages of PRs are loaded", async ({
      page,
      uiHelper,
    }) => {
      const prPage = new PullRequestsPage(page, uiHelper);
      const allPRs = await searchGitHubPRs("all");

      const allButton = page.getByRole("button", { name: "ALL" });
      await expect(allButton).toBeVisible();
      await expect(allButton).toBeEnabled();
      await allButton.click();
      await uiHelper.waitForLoad();

      await prPage.verifyPRRows(allPRs, 0, 5);

      await page.locator(TABLE_SELECTORS.nextPage).click();
      await uiHelper.waitForLoad();
      await prPage.verifyPRRows(allPRs, 5, 10);

      // redhat-developer/rhdh have more than 1000 PRs; plugin caps at 1000 results
      const lastPagePRs = 996;

      await page.locator(TABLE_SELECTORS.lastPage).click();
      await uiHelper.waitForLoad();
      await prPage.verifyPRRows(allPRs, lastPagePRs, 1000);

      await page.locator(TABLE_SELECTORS.previousPage).click();
      await uiHelper.waitForLoad();
      await prPage.verifyPRRows(allPRs, lastPagePRs - 5, lastPagePRs - 1);
    });

    test("Verify that the 5, 10, 20 items per page option properly displays the correct number of PRs", async ({
      page,
      uiHelper,
    }) => {
      const prPage = new PullRequestsPage(page, uiHelper);
      const openPRs = await searchGitHubPRs("open");

      await uiHelper.waitForLoad();

      for (const rows of [5, 10, 20]) {
        await prPage.verifyPRRowsPerPage(rows, openPRs);
      }
    });
  });
});
