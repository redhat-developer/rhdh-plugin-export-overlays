import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import path from "path";
import {
  GITHUB_ORG,
  WAIT_OBJECTS,
  clickBulkImportPreviewSave,
  handleGitHubAuthDialogIfPresent,
} from "./bulk-import-shared";

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


async function ensureBulkImportAccordionOpen(page: Page): Promise<void> {
  const btn = page.getByRole("button", {
    name: "Import to Red Hat Developer Hub",
  });
  if ((await btn.getAttribute("aria-expanded")) !== "true") {
    await btn.click();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
  }
}



async function reloadBulkImportPage(page: Page): Promise<void> {
  await page.reload();
  await waitForLoad(page);
  await handleGitHubAuthDialogIfPresent(page, 22_000);
  await ensureBulkImportAccordionOpen(page);
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

  test.beforeEach(async ({ loginHelper, uiHelper, page }) => {
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.openSidebar("Bulk import");
    await handleGitHubAuthDialogIfPresent(page, 4000);
    await uiHelper.verifyHeading("Bulk import");
  });

  test("Bulk import plugin page", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: "Import to Red Hat Developer Hub" }),
    ).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("button", { name: "Import to Red Hat Developer Hub" })
      .click();

    await expect(
      page.getByRole("button", { name: "Import to Red Hat Developer Hub" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByText("Source control tool", { exact: true }),
    ).toBeVisible();
    await handleGitHubAuthDialogIfPresent(page, 18_000);
    await page
      .getByLabel("Importing requires approval.")
      .getByTestId("HelpOutlineIcon")
      .hover({ force: true });
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
      await reloadBulkImportPage(page);
      await uiHelper.searchInputPlaceholder(catalogRepoDetails.name);
      await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
        "Ready to import",
      ]);
    }).toPass({
      intervals: [5_000, 10_000, 15_000],
      timeout: 120_000,
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

    await expect(await clickBulkImportPreviewSave(page)).toBeHidden();
    await expect(await uiHelper.clickButton("Import")).toBeDisabled();
  });

  test("Add a Repository, generate a PR, and confirm its preview", async ({
    page,
    uiHelper,
  }) => {
    // Wait to ensure the repo will appear in the Bulk Import UI
    await expect(async () => {
      await reloadBulkImportPage(page);
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
    await clickBulkImportPreviewSave(page);
    await uiHelper.verifyRowInTableByUniqueText(newRepoDetails.repoName, [
      "Ready to import",
    ]);
    await expect(await uiHelper.clickButton("Import")).toBeDisabled({
      timeout: 10000,
    });
  });

  // plugin changed behavior....
  // test('Verify that the two selected repositories are listed: one with the status "Already imported" and another with the status "WAIT_PR_APPROVAL."', async ({
  //   page,
  //   uiHelper,
  // }) => {
  //   await waitForLoad(page);
  //   await filterAddedRepo(page, uiHelper, catalogRepoDetails.name);
  //   await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
  //     catalogRepoDetails.url,
  //     "Imported",
  //   ]);
  //   await filterAddedRepo(page, uiHelper, newRepoDetails.repoName);
  //   await uiHelper.verifyRowInTableByUniqueText(newRepoDetails.repoName, [
  //     "Waiting for Approval",
  //   ]);
  // });

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

  // test("Verify Selected repositories shows catalog-info.yaml status as 'Already imported' and 'WAIT_PR_APPROVAL'", async ({
  //   uiHelper,
  // }) => {
  //   await uiHelper.searchInputPlaceholder(catalogRepoDetails.name);
  // await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
  //   "Imported",
  // ]);
  //   await uiHelper.searchInputPlaceholder(newRepoDetails.repoName);
  //   await uiHelper.verifyRowInTableByUniqueText(newRepoDetails.repoName, [
  //     "Waiting for Approval",
  //   ]);
  // });

  // test("Merge the PR on GitHub and Confirm the Status Updates to 'Already imported'", async ({
  //   page,
  //   uiHelper,
  // }) => {
  //   // Merge PR is generated for the repository without the catalog.yaml file.
  //   await APIHelper.mergeGitHubPR(
  //     newRepoDetails.owner,
  //     newRepoDetails.repoName,
  //     1,
  //   );
  //   // Ensure that no PR is generated for the repository that already has a catalog.yaml file.
  //   expect(
  //     await APIHelper.getGitHubPRs(
  //       catalogRepoDetails.owner,
  //       catalogRepoDetails.name,
  //       "open",
  //     ),
  //   ).toHaveLength(0);

  // // Wait to ensure the repo will appear in the Bulk Import UI
  // await expect(async () => {
  //   await reloadBulkImportPage(page);
  //   await filterAddedRepo(page, uiHelper, newRepoDetails.repoName);
  //   // verify that the status has changed to "Already imported."
  //   await verifyImportedOrAlreadyImportedRow(uiHelper, newRepoDetails.repoName);
  // }).toPass({
  //   intervals: [5_000, 10_000],
  //   timeout: 120_000,
  // });
  // });

  test("Verify Added Repositories Appear in the Catalog as Expected", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Component");
    await uiHelper.searchInputPlaceholder(catalogRepoDetails.name);

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

  test.beforeEach(async ({ loginHelper, uiHelper, page }) => {
    await loginHelper.loginAsKeycloakUser();
    await uiHelper.openSidebar("Bulk import");
    await handleGitHubAuthDialogIfPresent(page, 4000);
  });

  // test("Verify existing repo from app-config is displayed in bulk import Added repositories", async ({
  //   page,
  //   uiHelper,
  // }) => {
  //   await uiHelper.openSidebar("Bulk import");
  //   await waitForLoad(page);
  //   await filterAddedRepo(page, uiHelper, existingRepoFromAppConfig);
  // await uiHelper.verifyRowInTableByUniqueText(existingRepoFromAppConfig, [
  //   "Imported",
  // ]);
  // });

  // test('Verify repo from "import an existing git repository" are displayed in bulk import Added repositories', async ({
  //   page,
  //   uiHelper,
  // }) => {
  //   // Import an existing Git repository
  //   await uiHelper.openSidebar("Catalog");
  //   await uiHelper.clickButton("Self-service");
  //   await uiHelper.clickButton("Import an existing Git repository");

  //   await catalogImportRegisterFromComponentUrl(
  //     page,
  //     existingComponentDetails.url,
  //   );

  //   // RepositoriesList may be absent (Router-only mount); confirm registration via Catalog entity.
  //   await expect(async () => {
  //     await page.goto(catalogDefaultComponentPath(existingComponentDetails.repoName));
  //     await handleGitHubAuthDialogIfPresent(page, 22_000);
  //     await expectCatalogComponentVisible(page, existingComponentDetails.repoName);
  //   }).toPass({
  //     intervals: [15_000],
  //     timeout: 180_000,
  //   });

  //   await page.goto("/bulk-import");
  //   await waitForLoad(page);
  //   await handleGitHubAuthDialogIfPresent(page, 22_000);
  //   const addedHeading = page.getByText(/Added repositories/i).first();
  //   if (await addedHeading.isVisible({ timeout: 8000 }).catch(() => false)) {
  //     await addedHeading.scrollIntoViewIfNeeded();
  //     await filterAddedRepo(page, uiHelper, existingComponentDetails.repoName);
  //     await verifyImportedOrAlreadyImportedRow(
  //       uiHelper,
  //       existingComponentDetails.repoName,
  //     );
  //   }
  // });
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

  test.beforeEach(async ({ loginHelper, uiHelper, page }) => {
    // Second default user password was not exposed with help of framework. So let's hard code it for now...
    await loginHelper.loginAsKeycloakUser("test2", "test2@123");
    await uiHelper.openSidebar("Bulk import");
    await handleGitHubAuthDialogIfPresent(page, 22_000);
  });

  test("Bulk Import - Verify users without permission cannot access", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Bulk import");
    await uiHelper.verifyText("Permission required");
    expect(await uiHelper.isBtnVisible("Import")).toBeFalsy();
  });
});
