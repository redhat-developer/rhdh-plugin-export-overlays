import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  GITHUB_CATALOG_OWNER,
  GITHUB_ORG,
} from "../../support/constants/github";
import {
  CATALOG_FIXTURE_REPOS,
  catalogImportComponentUrl,
} from "../../support/constants/catalog";
import { BulkImportPO } from "../../support/pages/bulk-import-po";
import { CatalogEntityPO } from "../../support/pages/catalog-entity-po";
import { CatalogImportPO } from "../../support/pages/catalog-import-po";
import { defaultCatalogInfoYaml } from "../../support/test-data/catalog-info-yaml";
import {
  signInAsGuestForPermissionTest,
  signInForBulkImportTests,
} from "../../support/utils/auth";
import { setupBulkImportRhdh } from "../../support/utils/deploy";
import { selectGitLabAndRejectLogin } from "../../support/utils/gitlab-provider";
import {
  BULK_IMPORT_HEADING,
  REPO_STATUS_READY_TO_IMPORT,
} from "../../support/constants/bulk-import-selectors";

test.describe("Bulk Import plugin", () => {
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
  owner: user:default/${GITHUB_CATALOG_OWNER}`;

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
        appConfig: "tests/config/app-config-rhdh.yaml",
        dynamicPlugins: "tests/config/dynamic-plugins.yaml",
        valueFile: "tests/config/values.yaml",
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

  test.describe.serial("Bulk import plugin page", () => {
    test.beforeEach(async ({ loginHelper, uiHelper, page }) => {
      await signInForBulkImportTests(page, loginHelper, uiHelper);
    });

    test("Verify the Bulk import plugin page", async ({
      page,
      loginHelper,
      uiHelper,
    }) => {
      const bulkImport = new BulkImportPO(page, uiHelper, loginHelper);
      await loginHelper.checkAndClickOnGHloginPopup();
      await bulkImport.expectAccordionExpanded(true);
      await bulkImport.toggleAccordionClosed();
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
      await bulkImport.expectGithubProviderChecked();
      await selectGitLabAndRejectLogin(page);
      await bulkImport.selectGithubProvider();
      await bulkImport.expectGithubProviderChecked();
      await bulkImport.expectRepositoriesTableColumns();
    });

    test("Add a Repository and Confirm its Preview", async ({
      page,
      loginHelper,
      uiHelper,
    }) => {
      const bulkImport = new BulkImportPO(page, uiHelper, loginHelper);
      await bulkImport.pollUntilRepoRowVisible(catalogRepoDetails.name, [
        REPO_STATUS_READY_TO_IMPORT,
      ]);

      await bulkImport.checkRepoRowCheckbox(catalogRepoDetails.name);
      await bulkImport.searchAndExpectRow(catalogRepoDetails.name, [
        catalogRepoDetails.url,
        REPO_STATUS_READY_TO_IMPORT,
        "Preview file",
      ]);

      await bulkImport.clickPreviewFileLink(catalogRepoDetails.name);
      await expect(await bulkImport.savePreview()).toBeHidden();
      await expect(await uiHelper.clickButton("Import")).toBeDisabled();
    });

    test("Add a Repository, generate a PR, and confirm its preview", async ({
      page,
      loginHelper,
      uiHelper,
    }) => {
      const bulkImport = new BulkImportPO(page, uiHelper, loginHelper);
      await bulkImport.pollUntilRepoRowVisible(
        newRepoDetails.repoName,
        [REPO_STATUS_READY_TO_IMPORT],
        { intervals: [5_000], timeout: 40_000 },
      );

      await bulkImport.checkRepoRowCheckbox(newRepoDetails.repoName);
      await bulkImport.clickPreviewFileLink(newRepoDetails.repoName);
      await bulkImport.savePreview();
      await bulkImport.searchAndExpectRow(newRepoDetails.repoName, [
        REPO_STATUS_READY_TO_IMPORT,
      ]);
      await expect(await uiHelper.clickButton("Import")).toBeDisabled({
        timeout: 10_000,
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
      const expectedCatalogInfoYaml = defaultCatalogInfoYaml(
        newRepoDetails.repoName,
        `${newRepoDetails.owner}/${newRepoDetails.repoName}`,
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
        repoName: CATALOG_FIXTURE_REPOS.janusTest2BulkImport,
        url: catalogImportComponentUrl(
          CATALOG_FIXTURE_REPOS.janusTest2BulkImport,
        ),
      };

      const catalogImport = new CatalogImportPO(page);
      const catalogEntity = new CatalogEntityPO(page);
      const bulkImport = new BulkImportPO(page, uiHelper, loginHelper);

      await uiHelper.openSidebar("Catalog");
      await uiHelper.clickButton("Self-service");
      await uiHelper.clickButton("Import an existing Git repository");
      await catalogImport.registerFromComponentUrl(catalogImportedRepo.url);

      await expect(async () => {
        await catalogEntity.gotoComponent(catalogImportedRepo.repoName);
        await loginHelper.checkAndClickOnGHloginPopup();
        await catalogEntity.expectComponentVisible(
          catalogImportedRepo.repoName,
        );
      }).toPass({
        intervals: [15_000],
        timeout: 180_000,
      });

      await uiHelper.openSidebar(BULK_IMPORT_HEADING);
      await bulkImport.verifyHeading();
      await bulkImport.assertRepoAbsent(catalogImportedRepo.repoName);
    });
  });

  test.describe("Bulk Import - Ensure users without bulk import permissions cannot access the bulk import plugin", () => {
    test.beforeEach(async ({ loginHelper, uiHelper }) => {
      await signInAsGuestForPermissionTest(loginHelper, uiHelper);
    });

    test("Bulk Import - Verify users without permission cannot access", async ({
      uiHelper,
    }) => {
      await uiHelper.verifyText("Permission required");
      expect(await uiHelper.isBtnVisible("Import")).toBeFalsy();
    });
  });
});
