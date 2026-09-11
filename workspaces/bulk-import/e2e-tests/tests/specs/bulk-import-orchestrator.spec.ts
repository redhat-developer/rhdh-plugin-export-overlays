import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { GITHUB_ORG } from "../../support/constants/github";
import { BulkImportPO } from "../../support/pages/bulk-import-po";
import { signInForBulkImportTests } from "../../support/utils/auth";
import { setupBulkImportRhdh } from "../../support/utils/deploy";
import { selectGitLabAndRejectLogin } from "../../support/utils/gitlab-provider";
import {
  deployBulkImportOrchestratorWorkflow,
  logOrchestratorDeployFailureDiagnostics,
} from "../utils/workflow-deployment-helpers.js";

test.describe("Bulk import tests orchestrator mode", () => {
  const catalogRepoName = `${GITHUB_ORG}-1-bulk-import-test-${Date.now()}`;
  const catalogRepoDetailsForOrchestrator = {
    name: catalogRepoName,
    url: `github.com/${GITHUB_ORG}/${catalogRepoName}`,
    org: `github.com/${GITHUB_ORG}`,
    owner: GITHUB_ORG,
  };

  test.beforeAll(async ({ rhdh }) => {
    const orchestratorNamespace = "orchestrator";
    await test.runOnce(
      "bulk-import-install-orchestrator-and-test-workflow",
      async () => {
        await deployBulkImportOrchestratorWorkflow(orchestratorNamespace);
      },
    );
    await test.runOnce("bulk-import-orchestrator-rhdh-setup", async () => {
      const rhdhNamespace = rhdh.deploymentConfig.namespace;
      try {
        await setupBulkImportRhdh(rhdh, {
          appConfig: "tests/config/app-config-rhdh-orchestrator-mode.yaml",
          dynamicPlugins: "tests/config/dynamic-plugins-with-orchestrator.yaml",
        });
      } catch (err) {
        await logOrchestratorDeployFailureDiagnostics(rhdhNamespace);
        await logOrchestratorDeployFailureDiagnostics(orchestratorNamespace);
        throw err;
      }
    });

    await APIHelper.createGitHubRepoWithFile(
      catalogRepoDetailsForOrchestrator.owner,
      catalogRepoDetailsForOrchestrator.name,
      "test",
      "ABC",
    );
  });

  test.beforeEach(async ({ loginHelper, uiHelper, page }) => {
    await signInForBulkImportTests(page, loginHelper, uiHelper);
  });

  test.afterAll(async () => {
    try {
      await APIHelper.deleteGitHubRepo(
        catalogRepoDetailsForOrchestrator.owner,
        catalogRepoDetailsForOrchestrator.name,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Cleanup] Final cleanup failed: ${message}`);
    }
  });

  test("should display plugin page", async ({
    page,
    loginHelper,
    uiHelper,
  }) => {
    const bulkImport = new BulkImportPO(page, uiHelper, loginHelper);
    await bulkImport.expectOrchestratorSelectedReposEmpty();
    await loginHelper.checkAndClickOnGHloginPopup();

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
    await bulkImport.expectRepositoriesTableColumns();
  });

  test("should interact with plugin features", async ({
    page,
    uiHelper,
    loginHelper,
  }) => {
    const bulkImport = new BulkImportPO(page, uiHelper, loginHelper);

    await bulkImport.pollUntilRepoRowVisible(
      catalogRepoDetailsForOrchestrator.name,
      [catalogRepoDetailsForOrchestrator.url],
    );

    await bulkImport.checkRepoRowCheckbox(
      catalogRepoDetailsForOrchestrator.name,
    );

    await bulkImport.clickAddRepositoryImportAndWaitForSubmit();

    // Orchestrator import now requires a GitHub App installation token
    // (rhdh-plugins#4349); this suite only configures a PAT
    // (integrations.github[].token), so the job fails closed and the UI
    // surfaces it as an error alert on this page instead of creating a PR.
    const jobErrors = page.getByTestId("orchestrator-job-errors");
    await expect(jobErrors).toBeVisible({ timeout: 60_000 });
    await expect(
      jobErrors.getByText(
        /Orchestrator import requires a GitHub App installation token/i,
      ),
    ).toBeVisible();
  });

  // Success path is blocked until the suite provides a GitHub App installation
  // token. Kept as fixme so the intended coverage is tracked and can be
  // re-enabled once the token is configured.
  test.fixme("should import a repository via orchestrator (success path)", async ({
    page,
    uiHelper,
    loginHelper,
  }) => {
    const bulkImport = new BulkImportPO(page, uiHelper, loginHelper);

    await bulkImport.pollUntilRepoRowVisible(
      catalogRepoDetailsForOrchestrator.name,
      [catalogRepoDetailsForOrchestrator.url],
    );
    await bulkImport.checkRepoRowCheckbox(
      catalogRepoDetailsForOrchestrator.name,
    );
    await bulkImport.clickAddRepositoryImportAndWaitForSubmit();

    const workflowPage =
      await bulkImport.openImportHistoryVerifyWorkflowAndOpenInstance(
        catalogRepoDetailsForOrchestrator.url,
      );
    await expect(
      workflowPage.getByRole("link", { name: "PR_URL" }),
    ).toBeVisible({ timeout: 30_000 });

    await bulkImport.closePageIfNotPrimary(workflowPage);
    await bulkImport.expectRepoRowShowsWorkflowAfterImport(
      catalogRepoDetailsForOrchestrator.name,
    );
  });
});
