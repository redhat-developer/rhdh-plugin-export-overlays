import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  setupBrowser,
  UIhelper,
  APIHelper,
  LoginHelper,
  GITHUB_API_ENDPOINTS,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { CatalogImportPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import type { Page, BrowserContext } from "@playwright/test";

const TEMPLATES = [
  "Add ArgoCD to an existing project",
  "Ansible Job Template",
  "Create a .NET Frontend application in Azure DevOps with a CI pipeline",
  "Create a Go Backend application with a CI pipeline",
  "Ansible Job",
  "Create a Node.js Backend application with a CI pipeline",
  "Create a Python application in GitLab with a CI pipeline",
  "Create a Quarkus Backend application with a CI pipeline",
  "Register existing component to Software Catalog",
  "Create a Spring Boot Backend application with a CI pipeline",
  "Create a techdocs sample",
  "Create a tekton CI Pipeline",
];

const RESOURCES = [
  "Red Hat Developer Hub",
  "ArgoCD",
  "GitHub Showcase repository",
  "KeyCloak",
  "S3 Object bucket storage",
  "PostgreSQL cluster",
];

const TABLE_SELECTORS = {
  nextPage: 'button[aria-label="Next Page"]',
  previousPage: 'button[aria-label="Previous Page"]',
  lastPage: 'button[aria-label="Last Page"]',
  rows: 'table[class*="MuiTable-root-"] tbody tr',
  pageSelectBox: 'div[class*="MuiTablePagination-input"]',
};

let page: Page;
let context: BrowserContext;

test.describe("GitHub Happy path", () => {
  let loginHelper: LoginHelper;
  let uiHelper: UIhelper;
  let catalogImport: CatalogImportPage;

  const component =
    "https://github.com/redhat-developer/rhdh/blob/main/catalog-entities/all.yaml";

  const verifyPRRows = async (
    allPRs: { title: string }[],
    startRow: number,
    lastRow: number,
  ) => {
    for (let i = startRow; i < lastRow; i++) {
      await uiHelper?.verifyRowsInTable([allPRs[i].title], false);
    }
  };

  test.beforeAll(async ({ browser, rhdh }, testInfo) => {
    test.info().annotations.push({
      type: "component",
      description: "core",
    });

    await rhdh.configure({ auth: "github" });
    await rhdh.deploy();

    ({ page, context } = await setupBrowser(browser, testInfo));
    uiHelper = new UIhelper(page);
    loginHelper = new LoginHelper(page);
    catalogImport = new CatalogImportPage(page);
    // test.info().setTimeout(600 * 1000);

    await loginHelper.loginAsGithubUser();
  });

  //   test("Login as a Github user from Settings page.", async () => {
  //     await loginHelper.loginAsGithubUser();

  //     const ghLogin = await loginHelper.githubLoginFromSettingsPage(
  //       process.env.VAULT_GH_USER_ID,
  //       process.env.VAULT_GH_USER_PASS,
  //       process.env.VAULT_GH_2FA_SECRET,
  //     );
  //     expect(ghLogin).toBe("Login successful");
  //   });

  //   test("Verify Profile is Github Account Name in the Settings page", async () => {
  //     await uiHelper.openProfileDropdown();
  //     await page
  //       .getByRole("menuitem", { name: "Settings" })
  //       .click({ timeout: 5000 });
  //     await uiHelper.verifyHeading(process.env.VAULT_GH_USER_ID);
  //     await uiHelper.verifyHeading(
  //       `User Entity: ${process.env.VAULT_GH_USER_ID}`,
  //     );
  //   });

  //   test("Import an existing Git repository", async () => {
  //     await uiHelper.openSidebar("Catalog");
  //     await uiHelper.selectMuiBox("Kind", "Component");
  //     await uiHelper.clickButton("Self-service");
  //     await uiHelper.clickButton("Import an existing Git repository");
  //     await catalogImport.registerExistingComponent(component);
  //   });

  //   test("Verify that the following components were ingested into the Catalog", async () => {
  //     await uiHelper.openSidebar("Catalog");
  //     await uiHelper.selectMuiBox("Kind", "Group");
  //     await uiHelper.verifyComponentInCatalog("Group", ["Janus-IDP Authors"]);

  //     await uiHelper.verifyComponentInCatalog("API", ["Petstore"]);
  //     await uiHelper.verifyComponentInCatalog("Component", [
  //       "Red Hat Developer Hub",
  //     ]);

  //     await uiHelper.selectMuiBox("Kind", "Resource");
  //     await uiHelper.verifyRowsInTable([
  //       "ArgoCD",
  //       "GitHub Showcase repository",
  //       "KeyCloak",
  //       "PostgreSQL cluster",
  //       "S3 Object bucket storage",
  //     ]);

  //     await uiHelper.openSidebar("Catalog");
  //     await uiHelper.selectMuiBox("Kind", "User");
  //     await uiHelper.searchInputPlaceholder("rhdh");
  //     await uiHelper.verifyRowsInTable(["rhdh-qe rhdh-qe"]);
  //   });

  //   test("Verify all 12 Software Templates appear in the Create page", async () => {
  //     await uiHelper.clickLink({ ariaLabel: "Self-service" });
  //     await uiHelper.verifyHeading("Templates");

  //     for (const template of TEMPLATES) {
  //       await uiHelper.waitForTitle(template, 4);
  //       await uiHelper.verifyHeading(template);
  //     }
  //   });

  // backstage-plugin-github-pull-requests
  test("Click login on the login popup and verify that Overview tab renders", async () => {
    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("Red Hat Developer Hub");

    const expectedPath = "/catalog/default/component/red-hat-developer-hub";
    await page.waitForURL(`**${expectedPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    expect(page.url()).toContain(expectedPath);

    // await loginHelper.clickOnGHloginPopup();
    await uiHelper.verifyLink("About RHDH", { exact: false });
    await uiHelper.waitForLoad();

    await uiHelper.verifyText(/Average Size Of PR\d+ lines/);
    await expect(
      page.locator(
        'a[href="https://github.com/redhat-developer/rhdh/tree/main/catalog-entities/components/"]',
      ),
    ).toBeVisible();
  });

  //   test("Verify that the Issues tab renders all the open github issues in the repository", async () => {
  //     await uiHelper.openCatalogSidebar("Component");
  //     await uiHelper.clickLink("Red Hat Developer Hub");

  //     const expectedPath = "/catalog/default/component/red-hat-developer-hub";
  //     await page.waitForURL(`**${expectedPath}`, {
  //       waitUntil: "domcontentloaded",
  //       timeout: 20000,
  //     });
  //     expect(page.url()).toContain(expectedPath);

  //     await uiHelper.clickTab("Issues");
  //     await loginHelper.clickOnGHloginPopup();
  //     const allIssues = await APIHelper.getGithubPaginatedRequest(
  //       GITHUB_API_ENDPOINTS.issues("open"),
  //     );
  //     const openIssues = allIssues.filter(
  //       (issue: { pull_request: boolean }) => !issue.pull_request,
  //     );

  //     const issuesCountText = new RegExp(
  //       `All repositories \\(${openIssues.length} Issue.*\\)`,
  //     );
  //     await expect(page.getByText(issuesCountText)).toBeVisible();

  //     for (const issue of openIssues.slice(0, 5)) {
  //       await uiHelper.verifyText(
  //         (issue as { title: string }).title.replace(/\s+/g, " "),
  //       );
  //     }
  //   });

  // backstage-plugin-github-pull-requests
  test("Verify that the Pull/Merge Requests tab renders the 5 most recently updated Open Pull Requests", async () => {
    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("Red Hat Developer Hub");

    const expectedPath = "/catalog/default/component/red-hat-developer-hub";
    await page.waitForURL(`**${expectedPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    expect(page.url()).toContain(expectedPath);

    await uiHelper.clickTab("Pull/Merge Requests");
    const openPRs = await APIHelper.getGitHubPRs(
      "redhat-developer",
      "rhdh",
      "open",
    );
    await verifyPRRows(openPRs, 0, 5);
  });

  // backstage-plugin-github-pull-requests
  test("Click on the CLOSED filter and verify that the 5 most recently updated Closed PRs are rendered (same with ALL)", async () => {
    const closedButton = page.getByRole("button", { name: "CLOSED" });
    await expect(closedButton).toBeVisible();
    await expect(closedButton).toBeEnabled();
    await closedButton.click();
    const closedPRs = await APIHelper.getGitHubPRs(
      "redhat-developer",
      "rhdh",
      "closed",
    );
    await uiHelper.waitForLoad();
    await verifyPRRows(closedPRs, 0, 5);
  });

  // backstage-plugin-github-pull-requests
  test("Click on the arrows to verify that the next/previous/first/last pages of PRs are loaded", async () => {
    await uiHelper.clickTab("Pull/Merge Requests");

    const allPRs = await APIHelper.getGitHubPRs(
      "redhat-developer",
      "rhdh",
      "all",
      true,
    );

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

  // backstage-plugin-github-pull-requests
  test("Verify that the 5, 10, 20 items per page option properly displays the correct number of PRs", async () => {
    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("Red Hat Developer Hub");
    // await loginHelper.clickOnGHloginPopup();
    await uiHelper.clickTab("Pull/Merge Requests");
    await uiHelper.waitForLoad();
    const openPRs = await APIHelper.getGitHubPRs(
      "redhat-developer",
      "rhdh",
      "open",
    );

    for (const rows of [5, 10, 20]) {
      await page.click(TABLE_SELECTORS.pageSelectBox);
      await page.click(`ul[role="listbox"] li[data-value="${rows}"]`);
      await uiHelper.waitForLoad();
      await uiHelper.verifyText(openPRs[rows - 1].title, false);
      await uiHelper.verifyLink(openPRs[rows].number.toString(), {
        exact: false,
        notVisible: true,
      });
      const tableRows = page.locator(TABLE_SELECTORS.rows);
      await expect(tableRows).toHaveCount(rows);
    }
  });

  // TODO: https://issues.redhat.com/browse/RHDHBUGS-2099
  //   test.fixme("Verify that the CI tab renders 5 most recent github actions", async () => {
  //     await page.locator("a").getByText("CI", { exact: true }).first().click();
  //     await loginHelper.checkAndClickOnGHloginPopup();

  //     const response = await APIHelper.githubRequest(
  //       "GET",
  //       GITHUB_API_ENDPOINTS.workflowRuns,
  //     );
  //     const responseBody = await response.json();
  //     const workflowRuns = responseBody.workflow_runs;

  //     for (const workflowRun of workflowRuns.slice(0, 5)) {
  //       await uiHelper.verifyText(workflowRun.id);
  //     }
  //   });

  // TODO: https://issues.redhat.com/browse/RHDHBUGS-2099
  //   test.fixme("Click on the Dependencies tab and verify that all the relations have been listed and displayed", async () => {
  //     await uiHelper.clickTab("Dependencies");
  //     for (const resource of RESOURCES) {
  //       const resourceElement = page.locator(
  //         `#workspace:has-text("${resource}")`,
  //       );
  //       await resourceElement.scrollIntoViewIfNeeded();
  //       await expect(resourceElement).toBeVisible();
  //     }
  //   });

  // TODO: https://issues.redhat.com/browse/RHDHBUGS-2099
  //   test.fixme("Sign out and verify that you return back to the Sign in page", async () => {
  //     await uiHelper.openProfileDropdown();
  //     await page
  //       .getByRole("menuitem", { name: "Settings" })
  //       .click({ timeout: 5000 });
  //     await loginHelper.signOut();
  //     await context.clearCookies();
  //   });
});
