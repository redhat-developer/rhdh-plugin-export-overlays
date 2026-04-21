import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import installOrchestrator from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import path from "path";
export const WAIT_OBJECTS = {
  muiLinearProgress: 'div[class*="MuiLinearProgress-root"]',
  muiCircularProgress: '[class*="MuiCircularProgress-root"]',
};

const DEFAULT_CATALOG_INFO_YAML = (
  componentName: string,
  projectSlug: string,
  owner: string,
) => `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${componentName}
  annotations:
    github.com/project-slug: ${projectSlug}
spec:
  type: other
  lifecycle: unknown
  owner: user:default/${owner}
`;

// Helper function to select a repository in the table
async function selectRepoInTable(page: Page, repoName: string) {
  await page
    .locator(`tr:has(:text-is("${repoName}"))`)
    .getByRole("checkbox")
    .check();
}

// Helper function to filter/search for added repositories
async function filterAddedRepo(page: Page, uiHelper: any, repoName: string) {
  await uiHelper.searchInputPlaceholder(repoName);
}

// Helper function to wait for page load (wait for progress indicators to disappear)
async function waitForLoad(page: Page) {
  for (const item of Object.values(WAIT_OBJECTS)) {
    await page
      .waitForSelector(item, {
        state: "hidden",
        timeout: 12000,
      })
      .catch(() => {
        // Ignore if selector not found
      });
  }
}

/**
 * Catalog "Import an existing Git repository" flow without e2e-test-utils
 * CatalogImportPage.analyzeAndWait (it ties success to Analyze disappearing, which flakes).
 */
async function catalogImportRegisterFromComponentUrl(page: Page, url: string) {
  await page.locator('input[name="url"]').fill(url);
  await page.getByRole("button", { name: "Analyze" }).click();
  await waitForLoad(page);

  const importButton = page.getByRole("button", {
    name: "Import",
    exact: true,
  });
  const refreshButton = page.getByRole("button", {
    name: "Refresh",
    exact: true,
  });

  await expect(importButton.or(refreshButton)).toBeVisible({ timeout: 60_000 });

  if (await refreshButton.isVisible()) {
    return;
  }

  await expect(importButton).toBeEnabled({ timeout: 30_000 });
  await importButton.click();
  await waitForLoad(page);
}

export const GITHUB_ORG = "janus-qe";

test.describe.serial("Bulk Import plugin", () => {
  const catalogRepoName = `${GITHUB_ORG}-1-bulk-import-test-${Date.now()}`;
  const catalogRepoDetails = {
    name: catalogRepoName,
    url: `github.com/${GITHUB_ORG}/${catalogRepoName}`,
    org: `github.com/${GITHUB_ORG}`,
    owner: GITHUB_ORG,
  };

  const catalogInfoYamlContent = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${catalogRepoName}
  annotations:
    github.com/project-slug: ${GITHUB_ORG}/${catalogRepoName}
spec:
  type: other
  lifecycle: unknown
  owner: user:default/rhdh-qe-2`;

  const newRepoName = `bulk-import-${Date.now()}`;
  const newRepoDetails = {
    owner: `${GITHUB_ORG}`,
    repoName: newRepoName,
    updatedComponentName: `${newRepoName}-updated`,
    labels: `bulkimport1: test1;bulkimport2: test2`,
    repoUrl: `github.com/${GITHUB_ORG}/${newRepoName}`,
  };

  test.beforeAll(async ({ rhdh }) => {
    const rbacConfigmapPath = path.resolve(
      process.cwd(),
      "tests/config/rbac-configmap.yaml",
    );
    const namespace = rhdh.deploymentConfig.namespace;
    // todo: make it once...
    await $`kubectl apply -f ${rbacConfigmapPath} -n ${namespace}`;
    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh.yaml",
      valueFile: "tests/config/values.yaml",
    });
    await rhdh.deploy({
      timeout: 20 * 60 * 1000, // 20 min
    });

    // Create the repository with catalog-info.yaml file dynamically
    await APIHelper.createGitHubRepoWithFile(
      catalogRepoDetails.owner,
      catalogRepoDetails.name,
      "catalog-info.yaml",
      catalogInfoYamlContent,
    );

    // Create new GitHub repository without catalog-info.yaml
    await APIHelper.createGitHubRepoWithFile(
      newRepoDetails.owner,
      newRepoDetails.repoName,
      "README.md",
      "qa test project",
    );
  });

  test.beforeEach(async ({ loginHelper, uiHelper }) => {
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.openSidebar("Bulk import");
    await uiHelper.verifyHeading("Bulk import");
  });

  test("Bulk import plugin page", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: "Import to Red Hat Developer" }),
    ).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("button", { name: "Import to Red Hat Developer" })
      .click();
    await expect(
      page.getByRole("button", { name: "Import to Red Hat Developer" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByText("Source control tool", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Importing requires approval.")
      .getByTestId("HelpOutlineIcon")
      .hover();
    await expect(
      page.getByRole("tooltip", { name: "Importing requires approval." }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "GitHub" })).toBeChecked();
    await page.getByRole("radio", { name: "GitLab" }).check();
    await expect(page.getByRole("radio", { name: "GitLab" })).toBeChecked();
    await page.getByRole("radio", { name: "GitHub" }).check();
    await expect(page.getByRole("article")).toMatchAriaSnapshot(`
      - table:
        - rowgroup:
          - row "select all repositories Name URL Organization Status":
            - columnheader "select all repositories Name":
              - checkbox "select all repositories"
              - text: Name
            - columnheader "URL"
            - columnheader "Organization"
            - columnheader "Status"
    `);
  });

  test("Add a Repository and Confirm its Preview", async ({
    page,
    uiHelper,
  }) => {
    // Wait to ensure the repo will appear in the Bulk Import UI
    await expect(async () => {
      await page.reload();
      await waitForLoad(page);
      await uiHelper.searchInputPlaceholder(catalogRepoDetails.name);
      await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
        "Ready to import",
      ]);
    }).toPass({
      intervals: [5_000],
      timeout: 40_000,
    });

    await selectRepoInTable(page, catalogRepoDetails.name);
    await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
      catalogRepoDetails.url,
      "Ready to import",
      "Preview file",
    ]);

    await uiHelper.clickOnLinkInTableByUniqueText(
      catalogRepoDetails.name,
      "Preview file",
    );

    await expect(await uiHelper.clickButton("Save")).toBeHidden();
    await expect(await uiHelper.clickButton("Import")).toBeDisabled();
  });

  test("Add a Repository, generate a PR, and confirm its preview", async ({
    page,
    uiHelper,
  }) => {
    // Wait to ensure the repo will appear in the Bulk Import UI
    await expect(async () => {
      await page.reload();
      await waitForLoad(page);
      await uiHelper.searchInputPlaceholder(newRepoDetails.repoName);
      await uiHelper.verifyRowInTableByUniqueText(newRepoDetails.repoName, [
        "Ready to import",
      ]);
    }).toPass({
      intervals: [5_000],
      timeout: 40_000,
    });

    await selectRepoInTable(page, newRepoDetails.repoName);
    await uiHelper.clickOnLinkInTableByUniqueText(
      newRepoDetails.repoName,
      "Preview file",
    );
    await uiHelper.clickButton("Save");
    await uiHelper.verifyRowInTableByUniqueText(newRepoDetails.repoName, [
      "Ready to import",
    ]);
    await expect(await uiHelper.clickButton("Import")).toBeDisabled({
      timeout: 10000,
    });
  });

  // todo, plugin changed behavior, maybe bug...
  test('Verify that the two selected repositories are listed: one with the status "Already imported" and another with the status "WAIT_PR_APPROVAL."', async ({
    page,
    uiHelper,
  }) => {
    await waitForLoad(page);
    await filterAddedRepo(page, uiHelper, catalogRepoDetails.name);
    await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
      catalogRepoDetails.url,
      "Imported",
    ]);
    await filterAddedRepo(page, uiHelper, newRepoDetails.repoName);
    await uiHelper.verifyRowInTableByUniqueText(newRepoDetails.repoName, [
      "Waiting for Approval",
    ]);
  });

  test("Verify the Content of catalog-info.yaml in the PR is Correct", async () => {
    // First verify that a PR exists
    const prs = await APIHelper.getGitHubPRs(
      newRepoDetails.owner,
      newRepoDetails.repoName,
      "open",
    );
    expect(prs.length).toBeGreaterThan(0);

    const prCatalogInfoYaml = await APIHelper.getfileContentFromPR(
      newRepoDetails.owner,
      newRepoDetails.repoName,
      1,
      "catalog-info.yaml",
    );
    const expectedCatalogInfoYaml = DEFAULT_CATALOG_INFO_YAML(
      newRepoDetails.repoName,
      `${newRepoDetails.owner}/${newRepoDetails.repoName}`,
      "test1",
    );
    expect(prCatalogInfoYaml).toEqual(expectedCatalogInfoYaml);
  });

  test("Verify Selected repositories shows catalog-info.yaml status as 'Already imported' and 'WAIT_PR_APPROVAL'", async ({
    uiHelper,
  }) => {
    await uiHelper.searchInputPlaceholder(catalogRepoDetails.name);
    await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
      "Imported",
    ]);
    await uiHelper.searchInputPlaceholder(newRepoDetails.repoName);
    await uiHelper.verifyRowInTableByUniqueText(newRepoDetails.repoName, [
      "Waiting for Approval",
    ]);
  });

  test("Merge the PR on GitHub and Confirm the Status Updates to 'Already imported'", async ({
    page,
    uiHelper,
  }) => {
    // Merge PR is generated for the repository without the catalog.yaml file.
    await APIHelper.mergeGitHubPR(
      newRepoDetails.owner,
      newRepoDetails.repoName,
      1,
    );
    // Ensure that no PR is generated for the repository that already has a catalog.yaml file.
    expect(
      await APIHelper.getGitHubPRs(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
        "open",
      ),
    ).toHaveLength(0);

    // Wait to ensure the repo will appear in the Bulk Import UI
    await expect(async () => {
      await page.reload();
      await waitForLoad(page);
      await filterAddedRepo(page, uiHelper, newRepoDetails.repoName);
      // verify that the status has changed to "Already imported."
      await uiHelper.verifyRowInTableByUniqueText(newRepoDetails.repoName, [
        "Imported",
      ]);
    }).toPass({
      intervals: [5_000],
      timeout: 40_000,
    });
  });

  test("Verify Added Repositories Appear in the Catalog as Expected", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Component");
    await uiHelper.searchInputPlaceholder(catalogRepoDetails.name);
    //Wait 60 seconds to observe the result

    await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
      "other",
      "unknown",
    ]);
  });

  test.afterAll(async () => {
    try {
      // Delete the dynamically created GitHub repository with catalog-info.yaml
      await APIHelper.deleteGitHubRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
      );

      // Delete the GitHub repository
      await APIHelper.deleteGitHubRepo(
        newRepoDetails.owner,
        newRepoDetails.repoName,
      );

      console.log(
        `[Cleanup] Deleted GitHub repositories: ${catalogRepoDetails.name}, ${newRepoDetails.repoName}`,
      );
    } catch (error) {
      console.error(
        `[Cleanup] Final cleanup failed: ${(error as any).message}`,
      );
    }
  });
});

test.describe
  .serial("Bulk Import - Verify existing repo are displayed in bulk import Added repositories", () => {
  const existingRepoFromAppConfig = "janus-test-3-bulk-import";

  const existingComponentDetails = {
    name: "janus-test-2-bulk-import-test",
    repoName: "janus-test-2-bulk-import-test",
    url: `https://github.com/janus-test/janus-test-2-bulk-import-test/blob/main/catalog-info.yaml`,
  };

  test.beforeAll(async ({ rhdh }) => {
    const rbacConfigmapPath = path.resolve(
      process.cwd(),
      "tests/config/rbac-configmap.yaml",
    );
    const namespace = rhdh.deploymentConfig.namespace;
    // todo: make it once...
    await $`kubectl apply -f ${rbacConfigmapPath} -n ${namespace}`;
    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh.yaml",
      valueFile: "tests/config/values.yaml",
    });
    await rhdh.deploy({
      timeout: 20 * 60 * 1000, // 20 min
    });
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("Verify existing repo from app-config is displayed in bulk import Added repositories", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Bulk import");
    await waitForLoad(page);
    await filterAddedRepo(page, uiHelper, existingRepoFromAppConfig);
    await uiHelper.verifyRowInTableByUniqueText(existingRepoFromAppConfig, [
      "Imported",
    ]);
  });

  test('Verify repo from "import an existing git repository" are displayed in bulk import Added repositories', async ({
    page,
    uiHelper,
  }) => {
    // Import an existing Git repository
    await uiHelper.openSidebar("Catalog");
    await uiHelper.clickButton("Self-service");
    await uiHelper.clickButton("Import an existing Git repository");

    await catalogImportRegisterFromComponentUrl(
      page,
      existingComponentDetails.url,
    );

    // Verify in bulk import's Added Repositories
    // Navigate directly to ensure a clean page state (avoids landing on the import tab)
    // The backend may take time to sync the import status, so retry with page reload
    await expect(async () => {
      await page.goto("/bulk-import/repositories");
      await waitForLoad(page);
      await filterAddedRepo(page, uiHelper, existingComponentDetails.repoName);
      await uiHelper.verifyRowInTableByUniqueText(
        existingComponentDetails.repoName,
        ["Imported"],
      );
    }).toPass({
      intervals: [5_000, 10_000, 15_000],
      timeout: 90_000,
    });
  });
});

test.describe
  .serial("Bulk Import - Ensure users without bulk import permissions cannot access the bulk import plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh.yaml",
      valueFile: "tests/config/values.yaml",
    });
    await rhdh.deploy({
      timeout: 20 * 60 * 1000, // 20 min
    });
  });

  test.beforeEach(async ({ loginHelper }) => {
    // Second default user password was not exposed with help of framework. So let's hard code it for now...
    await loginHelper.loginAsKeycloakUser("test2", "test2@123");
  });

  test("Bulk Import - Verify users without permission cannot access", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Bulk import");
    await uiHelper.verifyText("Permission required");
    expect(await uiHelper.isBtnVisible("Import")).toBeFalsy();
  });
});

// ============================================================================
// ORCHESTRATOR MODE TESTS (CURRENT TESTS)
// ============================================================================

test.describe("Bulk import tests orchestrator mode", () => {
  const catalogRepoName = `${GITHUB_ORG}-1-bulk-import-test-${Date.now()}`;
  const catalogRepoDetailsForOrchestrator = {
    name: catalogRepoName,
    url: `github.com/${GITHUB_ORG}/${catalogRepoName}`,
    org: `github.com/${GITHUB_ORG}`,
    owner: GITHUB_ORG,
  };

  test.beforeAll(async ({ rhdh }) => {
    await rhdh.teardown();
    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh-orchestrator-mode.yaml",
      dynamicPlugins: "tests/config/dynamic-plugins-with-orchestrator.yaml",
    });
    await rhdh.deploy();
    await rhdh.waitUntilReady();

    const orchestratorNamespace = "orchestrator";

    await test.runOnce("install-orchestrator-and-test-workflow", async () => {
      await installOrchestrator(orchestratorNamespace);
      await $`bash tests/scripts/install-workflow.sh ${orchestratorNamespace}`;
    });

    await APIHelper.createGitHubRepoWithFile(
      catalogRepoDetailsForOrchestrator.owner,
      catalogRepoDetailsForOrchestrator.name,
      "test",
      "ABC",
    );
  });

  test.beforeEach(async ({ loginHelper }) => {
    // Login before each test
    await loginHelper.loginAsKeycloakUser();
  });

  test("should display plugin page", async ({ page, uiHelper }) => {
    // Navigate to your plugin
    await uiHelper.openSidebar("Bulk import");

    // Verify the page loaded
    await uiHelper.verifyHeading("Bulk import");

    // Add more assertions as needed
    await expect(page.locator("text=Selected repositories (0)")).toBeVisible();

    await expect(
      page.getByText("Source control tool", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Importing requires approval.")
      .getByTestId("HelpOutlineIcon")
      .hover();
    await expect(
      page.getByRole("tooltip", { name: "Importing requires approval." }), // remove this tooltip in the code...
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "GitHub" })).toBeChecked();
    await page.getByRole("radio", { name: "GitLab" }).check();
    await expect(page.getByRole("radio", { name: "GitLab" })).toBeChecked();
    await page.getByRole("radio", { name: "GitHub" }).check();

    // Verify bulk import form structure (avoid full aria snapshot — table data is dynamic from GitHub)
    const article = page.getByRole("article");
    await expect(article).toBeVisible();
    await expect(article.getByRole("table")).toBeVisible();
    await expect(
      article.getByRole("columnheader", { name: "Name" }),
    ).toBeVisible();
    await expect(
      article.getByRole("columnheader", { name: "URL" }),
    ).toBeVisible();
    await expect(
      article.getByRole("columnheader", { name: "Organization" }),
    ).toBeVisible();
    await expect(
      article.getByRole("columnheader", { name: "Status" }),
    ).toBeVisible();
    await expect(
      article.getByRole("checkbox", { name: "select all repositories" }),
    ).toBeVisible();
    await expect(article.getByRole("button", { name: "Import" })).toBeVisible();
    await expect(article.getByRole("link", { name: "Cancel" })).toBeVisible();
  });

  test("should interact with plugin features", async ({ page, uiHelper }) => {
    await uiHelper.openSidebar("Bulk import");

    // Wait to ensure the repo will appear in the Bulk Import UI
    await expect(async () => {
      await page.reload();
      // whait why progressors will dissapear
      for (const item of Object.values(WAIT_OBJECTS)) {
        await page.waitForSelector(item, {
          state: "hidden",
          timeout: 12000,
        });
      }

      await uiHelper.searchInputPlaceholder(
        catalogRepoDetailsForOrchestrator.name,
      );
      await uiHelper.verifyRowInTableByUniqueText(
        catalogRepoDetailsForOrchestrator.name,
        [],
      );
    }).toPass({
      intervals: [5_000],
      timeout: 40_000,
    });

    await page
      .locator(`tr:has(:text-is("${catalogRepoDetailsForOrchestrator.name}"))`)
      .getByRole("checkbox")
      .check();
    await uiHelper.verifyRowInTableByUniqueText(
      catalogRepoDetailsForOrchestrator.name,
      [catalogRepoDetailsForOrchestrator.url],
    );

    await expect(await uiHelper.clickButton("Import")).toBeDisabled({
      timeout: 10000,
    });

    const workflowPage = await clickLinkWithNewTab(page, "View workflow");
    await expect(
      workflowPage.getByRole("link", { name: "PR_URL" }),
    ).toBeVisible({ timeout: 10000 });
  });

  test.afterAll(async () => {
    try {
      // Delete the dynamically created GitHub repository with catalog-info.yaml
      await APIHelper.deleteGitHubRepo(
        catalogRepoDetailsForOrchestrator.owner,
        catalogRepoDetailsForOrchestrator.name,
      );

      console.log(
        `[Cleanup] Deleted GitHub repository: ${catalogRepoDetailsForOrchestrator.name}`,
      );
    } catch (error) {
      console.error(
        `[Cleanup] Final cleanup failed: ${(error as any).message}`,
      );
    }
  });
});

/** Clicks a link that opens in a new tab and returns the new page (so you can assert on it). */
async function clickLinkWithNewTab(
  page: Page,
  name: string | RegExp,
): Promise<Page> {
  const [newPage] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("link", { name }).click(),
  ]);
  await newPage.waitForLoadState();
  return newPage;
}
