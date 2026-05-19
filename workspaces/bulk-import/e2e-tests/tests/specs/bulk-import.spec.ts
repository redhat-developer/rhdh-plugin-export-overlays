import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  GITHUB_ORG,
  WAIT_OBJECTS,
  applyBulkImportRbacConfigmap,
  assertRepoAbsentOnBulkImport,
  setupBulkImportRhdh,
  catalogDefaultComponentPath,
  clickBulkImportPreviewSave,
  ensureBulkImportAccordionOpen,
  expectCatalogComponentVisible,
  waitForBulkImportPageLoad,
} from "./bulk-import-shared";

const githubCatalogOwner = () =>
  process.env.VAULT_GH_USER_ID?.trim() || "test1";

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

async function selectRepoInTable(page: Page, repoName: string) {
  await page
    .locator(`tr:has(:text-is("${repoName}"))`)
    .getByRole("checkbox")
    .check();
}

async function waitForLoad(page: Page) {
  for (const item of Object.values(WAIT_OBJECTS)) {
    await page
      .waitForSelector(item, {
        state: "hidden",
        timeout: 12000,
      })
      .catch(() => {});
  }
}

async function reloadBulkImportPage(page: Page): Promise<void> {
  await page.reload();
  await waitForBulkImportPageLoad(page);
  await ensureBulkImportAccordionOpen(page);
}

type GithubLoginHelper = {
  checkAndReauthorizeGithubApp: () => Promise<void>;
};

/**
 * Bulk Import shows "Login Required" after the page content paints. Wait for the
 * dialog (do not use a one-shot isVisible right after the page marker).
 */
async function dismissBulkImportLoginDialogIfPresent(
  page: Page,
  loginHelper: GithubLoginHelper,
  waitForDialogMs = 8_000,
): Promise<void> {
  const loginDialog = page.getByRole("dialog", { name: "Login Required" });

  const appeared = await loginDialog
    .waitFor({ state: "visible", timeout: waitForDialogMs })
    .then(() => true)
    .catch(() => false);

  if (!appeared) {
    return;
  }

  const logInButton = loginDialog.getByRole("button", { name: "Log in" });
  await expect(logInButton).toBeVisible({ timeout: 10_000 });

  const authorize = loginHelper.checkAndReauthorizeGithubApp();
  await logInButton.click();
  await authorize;

  await expect(loginDialog).toBeHidden({ timeout: 60_000 });
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
  owner: user:default/${githubCatalogOwner()}`;

  const newRepoName = `bulk-import-${Date.now()}`;
  const newRepoDetails = {
    owner: `${GITHUB_ORG}`,
    repoName: newRepoName,
    updatedComponentName: `${newRepoName}-updated`,
    labels: `bulkimport1: test1;bulkimport2: test2`,
    repoUrl: `github.com/${GITHUB_ORG}/${newRepoName}`,
  };

  test.beforeAll(async ({ rhdh }) => {
    await test.runOnce("bulk-import-rhdh-setup", async () => {
      await setupBulkImportRhdh(rhdh, {
        auth: "github",
      });
    });

    await APIHelper.createGitHubRepoWithFile(
      catalogRepoDetails.owner,
      catalogRepoDetails.name,
      "catalog-info.yaml",
      catalogInfoYamlContent,
    );

    await APIHelper.createGitHubRepoWithFile(
      newRepoDetails.owner,
      newRepoDetails.repoName,
      "README.md",
      "qa test project",
    );
  });

  test.beforeEach(async ({ loginHelper, uiHelper, page }) => {
    await loginHelper.loginAsGithubUser();
    await uiHelper.openSidebar("Bulk import");

    const bulkImportReady = page.getByText("Source control tool", {
      exact: true,
    });

    await expect(bulkImportReady).toBeVisible({ timeout: 20_000 });
    await dismissBulkImportLoginDialogIfPresent(page, loginHelper);
    await expect(
      page.getByRole("dialog", { name: "Login Required" }),
    ).toBeHidden({ timeout: 5_000 });
    await expect(bulkImportReady).toBeVisible();
    await uiHelper.verifyHeading("Bulk import");
  });

  test.afterAll(async () => {
    try {
      await APIHelper.deleteGitHubRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
      );
      await APIHelper.deleteGitHubRepo(
        newRepoDetails.owner,
        newRepoDetails.repoName,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Cleanup] Final cleanup failed: ${message}`);
    }
  });

  test("Bulk import plugin page", async ({ page }) => {
    const accordion = page.getByRole("button", {
      name: "Import to Red Hat Developer Hub",
    });
    await expect(accordion).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("button", { name: "Import to Red Hat Developer Hub" })
      .click();

    await expect(
      page.getByRole("button", { name: "Import to Red Hat Developer Hub" }),
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

  test.fixme('Verify that the two selected repositories are listed: one with the status "Already imported" and another with the status "WAIT_PR_APPROVAL."', async () => {
    // TODO: re-enable when bulk-import import/approval statuses match legacy expectations.
  });

  test("Verify the Content of catalog-info.yaml in the PR is Correct", async () => {
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
      githubCatalogOwner(),
    );
    expect(prCatalogInfoYaml).toEqual(expectedCatalogInfoYaml);
  });

  test.fixme("Verify Selected repositories shows catalog-info.yaml status as 'Already imported' and 'WAIT_PR_APPROVAL'", async () => {
    // TODO: re-enable when bulk-import import/approval statuses match legacy expectations.
  });

  test.fixme("Merge the PR on GitHub and Confirm the Status Updates to 'Already imported'", async () => {
    // TODO: re-enable when bulk-import import/approval statuses match legacy expectations.
  });

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

  test("Catalog-imported repo is in Catalog but absent from Bulk import", async ({
    page,
    uiHelper,
    loginHelper,
  }) => {
    const catalogImportedRepo = {
      repoName: "janus-test-2-bulk-import-test",
      url: "https://github.com/janus-test/janus-test-2-bulk-import-test/blob/main/catalog-info.yaml",
    };

    await uiHelper.openSidebar("Catalog");
    await uiHelper.clickButton("Self-service");
    await uiHelper.clickButton("Import an existing Git repository");

    await catalogImportRegisterFromComponentUrl(page, catalogImportedRepo.url);

    await expect(async () => {
      await page.goto(
        catalogDefaultComponentPath(catalogImportedRepo.repoName),
      );
      await loginHelper.checkAndClickOnGHloginPopup();
      await expectCatalogComponentVisible(page, catalogImportedRepo.repoName);
    }).toPass({
      intervals: [15_000],
      timeout: 180_000,
    });

    await uiHelper.openSidebar("Bulk import");
    await uiHelper.verifyHeading("Bulk import");
    await assertRepoAbsentOnBulkImport(
      page,
      uiHelper,
      catalogImportedRepo.repoName,
    );
  });
});

test.describe
  .serial("Bulk Import - Ensure users without bulk import permissions cannot access the bulk import plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await applyBulkImportRbacConfigmap(rhdh.deploymentConfig.namespace);
  });

  test.beforeEach(async ({ loginHelper, uiHelper }) => {
    await loginHelper.signOut();
    await loginHelper.loginAsGuest();
    await uiHelper.openSidebar("Bulk import");
  });

  test("Bulk Import - Verify users without permission cannot access", async ({
    uiHelper,
  }) => {
    await uiHelper.verifyText("Permission required");
    expect(await uiHelper.isBtnVisible("Import")).toBeFalsy();
  });
});
