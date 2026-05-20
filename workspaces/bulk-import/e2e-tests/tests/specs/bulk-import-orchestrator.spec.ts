import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import installOrchestrator from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import { GITHUB_ORG } from "./bulk-import-shared";
import { BulkImportPO } from "../../support/pages/bulk-import-po";
import { prepareBulkImportPage } from "../../support/utils/auth";
import { selectGitLabAndRejectLogin } from "../../support/utils/gitlab-provider";
import { GITHUB_PROVIDER_LABEL } from "../../support/constants/bulk-import-selectors";

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
        await installOrchestrator(orchestratorNamespace);
        await $`bash tests/scripts/install-workflow.sh ${orchestratorNamespace}`;
      },
    );
    await test.runOnce("bulk-import-orchestrator-rhdh-setup", async () => {
      const namespace = rhdh.deploymentConfig.namespace;
      const rbacPath = WorkspacePaths.resolve(
        "tests/config/rbac-configmap.yaml",
      );
      await $`kubectl apply -f ${rbacPath} -n ${namespace}`;

      await rhdh.configure({
        auth: "github",
        appConfig: "tests/config/app-config-rhdh-orchestrator-mode.yaml",
        dynamicPlugins: "tests/config/dynamic-plugins-with-orchestrator.yaml",
      });
      await rhdh.deploy({ timeout: 20 * 60 * 1000 });
    });

    await APIHelper.createGitHubRepoWithFile(
      catalogRepoDetailsForOrchestrator.owner,
      catalogRepoDetailsForOrchestrator.name,
      "test",
      "ABC",
    );
  });

  test.beforeEach(async ({ loginHelper, uiHelper, page }) => {
    await prepareBulkImportPage(page, loginHelper, uiHelper);
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
    await expect(
      page.getByRole("radio", { name: GITHUB_PROVIDER_LABEL }),
    ).toBeChecked();
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

    await expect(async () => {
      await page.reload();
      await uiHelper.waitForLoad(12_000);
      await loginHelper.checkAndClickOnGHloginPopup();
      await bulkImport.searchAndExpectRow(
        catalogRepoDetailsForOrchestrator.name,
        [],
      );
    }).toPass({
      intervals: [5_000],
      timeout: 40_000,
    });

    await bulkImport.checkRepoRowCheckbox(
      catalogRepoDetailsForOrchestrator.name,
    );
    await bulkImport.searchAndExpectRow(
      catalogRepoDetailsForOrchestrator.name,
      [catalogRepoDetailsForOrchestrator.url],
    );

    await expect(await uiHelper.clickButton("Import")).toBeDisabled({
      timeout: 10_000,
    });

    const workflowPage =
      await bulkImport.clickLinkOpensTargetPage("View workflow");
    await expect(
      workflowPage.getByRole("link", { name: "PR_URL" }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
