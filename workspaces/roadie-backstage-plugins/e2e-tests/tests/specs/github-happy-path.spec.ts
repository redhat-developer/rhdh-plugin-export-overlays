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

test.describe("GitHub Happy path src", () => {
  let loginHelper: LoginHelper;
  let uiHelper: UIhelper;
  let catalogImport: CatalogImportPage;

  const component =
    "https://github.com/redhat-developer/rhdh/blob/main/catalog-entities/all.yaml";

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

  test("Login as a Github user from Settings page.", async () => {
    await loginHelper.loginAsGithubUser();

    const ghLogin = await loginHelper.githubLoginFromSettingsPage(
      process.env.VAULT_GH_USER_ID,
      process.env.VAULT_GH_USER_PASS,
      process.env.VAULT_GH_2FA_SECRET,
    );
    expect(ghLogin).toBe("Login successful");
  });

  test("Verify Profile is Github Account Name in the Settings page", async () => {
    await uiHelper.openProfileDropdown();
    await page
      .getByRole("menuitem", { name: "Settings" })
      .click({ timeout: 5000 });
    await uiHelper.verifyHeading(process.env.VAULT_GH_USER_ID);
    await uiHelper.verifyHeading(
      `User Entity: ${process.env.VAULT_GH_USER_ID}`,
    );
  });

  test("Import an existing Git repository", async () => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Component");
    await uiHelper.clickButton("Self-service");
    await uiHelper.clickButton("Import an existing Git repository");
    await catalogImport.registerExistingComponent(component);
  });

  test("Verify that the following components were ingested into the Catalog", async () => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Group");
    await uiHelper.verifyComponentInCatalog("Group", ["Janus-IDP Authors"]);

    await uiHelper.verifyComponentInCatalog("API", ["Petstore"]);
    await uiHelper.verifyComponentInCatalog("Component", [
      "Red Hat Developer Hub",
    ]);

    await uiHelper.selectMuiBox("Kind", "Resource");
    await uiHelper.verifyRowsInTable([
      "ArgoCD",
      "GitHub Showcase repository",
      "KeyCloak",
      "PostgreSQL cluster",
      "S3 Object bucket storage",
    ]);

    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "User");
    await uiHelper.searchInputPlaceholder("rhdh");
    await uiHelper.verifyRowsInTable(["rhdh-qe rhdh-qe"]);
  });

  test("Verify all 12 Software Templates appear in the Create page", async () => {
    await uiHelper.clickLink({ ariaLabel: "Self-service" });
    await uiHelper.verifyHeading("Templates");

    for (const template of TEMPLATES) {
      await uiHelper.waitForTitle(template, 4);
      await uiHelper.verifyHeading(template);
    }
  });

  test("Verify that the Issues tab renders all the open github issues in the repository", async () => {
    await uiHelper.openCatalogSidebar("Component");
    await uiHelper.clickLink("Red Hat Developer Hub");

    const expectedPath = "/catalog/default/component/red-hat-developer-hub";
    await page.waitForURL(`**${expectedPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    expect(page.url()).toContain(expectedPath);

    await uiHelper.clickTab("Issues");
    await loginHelper.clickOnGHloginPopup();
    const allIssues = await APIHelper.getGithubPaginatedRequest(
      GITHUB_API_ENDPOINTS.issues("open"),
    );
    const openIssues = allIssues.filter(
      (issue: { pull_request: boolean }) => !issue.pull_request,
    );

    const issuesCountText = new RegExp(
      `All repositories \\(${openIssues.length} Issue.*\\)`,
    );
    await expect(page.getByText(issuesCountText)).toBeVisible();

    for (const issue of openIssues.slice(0, 5)) {
      await uiHelper.verifyText(
        (issue as { title: string }).title.replace(/\s+/g, " "),
      );
    }
  });

  // TODO: https://issues.redhat.com/browse/RHDHBUGS-2099
  test.fixme("Verify that the CI tab renders 5 most recent github actions", async () => {
    await page.locator("a").getByText("CI", { exact: true }).first().click();
    await loginHelper.checkAndClickOnGHloginPopup();

    const response = await APIHelper.githubRequest(
      "GET",
      GITHUB_API_ENDPOINTS.workflowRuns,
    );
    const responseBody = await response.json();
    const workflowRuns = responseBody.workflow_runs;

    for (const workflowRun of workflowRuns.slice(0, 5)) {
      await uiHelper.verifyText(workflowRun.id);
    }
  });

  // TODO: https://issues.redhat.com/browse/RHDHBUGS-2099
  test.fixme("Click on the Dependencies tab and verify that all the relations have been listed and displayed", async () => {
    await uiHelper.clickTab("Dependencies");
    for (const resource of RESOURCES) {
      const resourceElement = page.locator(
        `#workspace:has-text("${resource}")`,
      );
      await resourceElement.scrollIntoViewIfNeeded();
      await expect(resourceElement).toBeVisible();
    }
  });

  // TODO: https://issues.redhat.com/browse/RHDHBUGS-2099
  test.fixme("Sign out and verify that you return back to the Sign in page", async () => {
    await uiHelper.openProfileDropdown();
    await page
      .getByRole("menuitem", { name: "Settings" })
      .click({ timeout: 5000 });
    await loginHelper.signOut();
    await context.clearCookies();
  });
});
