import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  setupBrowser,
  UIhelper,
  APIHelper,
  LoginHelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { Page } from "@playwright/test";

const TABLE_SELECTORS = {
  nextPage: 'button[aria-label="Next Page"]',
  previousPage: 'button[aria-label="Previous Page"]',
  lastPage: 'button[aria-label="Last Page"]',
  rows: 'table[class*="MuiTable-root-"] tbody tr',
  pageSelectBox: 'div[class*="MuiTablePagination-input"]',
};

let page: Page;

test.describe("Backstage Plugin - GitHub Pull Requests", () => {
  let loginHelper: LoginHelper;
  let uiHelper: UIhelper;

  const verifyPRRows = async (
    allPRs: { title: string }[],
    startRow: number,
    lastRow: number,
  ) => {
    for (let i = startRow; i < lastRow; i++) {
      await uiHelper?.verifyRowsInTable([allPRs[i].title], false);
    }
  };

  const getShowcasePRs = async (
    state: "open" | "closed" | "all",
    paginated = false,
  ) => {
    return await APIHelper.getGitHubPRs(
      "redhat-developer",
      "rhdh",
      state,
      paginated,
    );
  };

  const verifyPRRowsPerPage = async (
    rows: number,
    allPRs: { title: string; number: number }[],
  ) => {
    await page.click(TABLE_SELECTORS.pageSelectBox);
    await page.click(`ul[role="listbox"] li[data-value="${rows}"]`);

    await uiHelper.waitForLoad();
    await uiHelper.verifyText(allPRs[rows - 1].title, false);
    await uiHelper.verifyLink(allPRs[rows].number.toString(), {
      exact: false,
      notVisible: true,
    });
    const tableRows = page.locator(TABLE_SELECTORS.rows);
    await expect(tableRows).toHaveCount(rows);
  };

  test.beforeAll(async ({ browser, rhdh }, testInfo) => {
    test.info().annotations.push({
      type: "component",
      description: "core",
    });

    await rhdh.configure({ auth: "github" });
    await rhdh.deploy();

    ({ page } = await setupBrowser(browser, testInfo));
    uiHelper = new UIhelper(page);
    loginHelper = new LoginHelper(page);
    test.info().setTimeout(600 * 1000);

    await loginHelper.loginAsGithubUser();
  });

  test.beforeEach(async () => {
    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("Red Hat Developer Hub");

    const expectedPath = "/catalog/default/component/red-hat-developer-hub";
    await page.waitForURL(`**${expectedPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    expect(page.url()).toContain(expectedPath);
  });

  test("Click login on the login popup and verify that Overview tab renders", async () => {
    await uiHelper.verifyLink("About RHDH", { exact: false });
    await uiHelper.waitForLoad();

    await uiHelper.verifyText(/Average Size Of PR\d+ lines/);
    await expect(
      page.locator(
        'a[href="https://github.com/redhat-developer/rhdh/tree/main/catalog-entities/components/"]',
      ),
    ).toBeVisible();
  });

  test.describe("Pull/Merge Requests tab", () => {
    test.beforeEach(async () => {
      await uiHelper.clickTab("Pull/Merge Requests");
    });

    test("Verify that the Pull/Merge Requests tab renders the 5 most recently updated Open Pull Requests", async () => {
      const openPRs = await getShowcasePRs("open");
      await verifyPRRows(openPRs, 0, 5);
    });

    test("Click on the CLOSED filter and verify that the 5 most recently updated Closed PRs are rendered (same with ALL)", async () => {
      await uiHelper.waitForLoad();
      const closedButton = page.getByRole("button", { name: "CLOSED" });
      await expect(closedButton).toBeVisible();
      await expect(closedButton).toBeEnabled();
      await closedButton.click();
      const closedPRs = await getShowcasePRs("closed");
      await uiHelper.waitForLoad();
      await verifyPRRows(closedPRs, 0, 5);
    });

    test("Click on the arrows to verify that the next/previous/first/last pages of PRs are loaded", async () => {
      const allPRs = await getShowcasePRs("all", true);

      const allButton = page.getByRole("button", { name: "ALL" });
      await expect(allButton).toBeVisible();
      await expect(allButton).toBeEnabled();
      await allButton.click();
      await verifyPRRows(allPRs, 0, 5);

      await page.click(TABLE_SELECTORS.nextPage);
      await verifyPRRows(allPRs, 5, 10);

      // redhat-developer/rhdh have more than 1000 PRs; plugin caps at 1000 results
      const lastPagePRs = 996;

      await page.click(TABLE_SELECTORS.lastPage);
      await verifyPRRows(allPRs, lastPagePRs, 1000);

      await page.click(TABLE_SELECTORS.previousPage);
      await uiHelper.waitForLoad();
      await verifyPRRows(allPRs, lastPagePRs - 5, lastPagePRs - 1);
    });

    test("Verify that the 5, 10, 20 items per page option properly displays the correct number of PRs", async () => {
      await uiHelper.waitForLoad();
      const openPRs = await getShowcasePRs("open");

      for (const rows of [5, 10, 20]) {
        await verifyPRRowsPerPage(rows, openPRs);
      }
    });
  });
});
