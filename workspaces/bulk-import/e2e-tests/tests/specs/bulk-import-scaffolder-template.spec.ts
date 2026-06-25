import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { setupBulkImportRhdh } from "../../support/utils/deploy";

const TEMPLATE_TITLE =
  "Create catalog-info.yaml in GitHub/GitLab repository" as const;

// TODO: revert to GITHUB_ORG ("janus-qe") before merging — using personal account for local dev
// const LOCAL_DEV_GITHUB_ORG = "janus-qe";
const LOCAL_DEV_GITHUB_ORG = "dom-aug-org";

const repositoryParametersGitHub = {
  repoUrl: "",
  branchName: "backstage-integration",
  targetBranchName: "main",
  name: `bulk-import-template-${Date.now()}`,
  organization: LOCAL_DEV_GITHUB_ORG,
  gitProviderHost: "github.com",
};
repositoryParametersGitHub.repoUrl = `github.com?owner=${repositoryParametersGitHub.organization}&repo=${repositoryParametersGitHub.name}`;

test.describe("Bulk Import via Scaffolder Template", () => {
  test.beforeAll(async ({ rhdh }) => {
    await test.runOnce("bulk-import-scaffolder-template-setup", async () => {
      await setupBulkImportRhdh(rhdh, {
        appConfig: "tests/config/app-config-rhdh-scaffolder-template.yaml",
        dynamicPlugins:
          "tests/config/dynamic-plugins-with-scaffolder-template.yaml",
        valueFile: "tests/config/values.yaml",
      });
    });

    await APIHelper.createGitHubRepoWithFile(
      repositoryParametersGitHub.organization,
      repositoryParametersGitHub.name,
      "README.md",
      "Bulk import scaffolder template test repo",
    );
  });

  test.beforeEach(async ({ loginHelper, uiHelper }) => {
    await loginHelper.loginAsGithubUser();
    await uiHelper.goToPageUrl("/create");
    await uiHelper.verifyHeading("Self-service");
  });

  test.afterAll(async () => {
    try {
      await APIHelper.deleteGitHubRepo(
        repositoryParametersGitHub.organization,
        repositoryParametersGitHub.name,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[Cleanup] Failed to delete repo ${repositoryParametersGitHub.name}: ${message}`,
      );
    }
  });

  test("Verify bulk import scaffolder template page loads", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.verifyHeading("Templates");
    await uiHelper.clickBtnInCard(TEMPLATE_TITLE, "Choose");
    await expect(page.getByText(TEMPLATE_TITLE)).toBeVisible();
    await expect(
      page.getByLabel("Repository URL (Backstage format)"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Review" })).toBeEnabled();
  });

  test("Import a GitHub repository via scaffolder template", async ({
    page,
    uiHelper,
  }) => {
    test.setTimeout(5 * 60 * 1000);

    await uiHelper.clickBtnInCard(TEMPLATE_TITLE, "Choose");
    await uiHelper.waitForTitle(TEMPLATE_TITLE, 2);

    await uiHelper.fillTextInputByLabel(
      "Repository URL (Backstage format)",
      repositoryParametersGitHub.repoUrl,
    );
    await uiHelper.fillTextInputByLabel(
      "Owner of the Repository",
      repositoryParametersGitHub.organization,
    );
    await uiHelper.fillTextInputByLabel(
      "Name of the repository",
      repositoryParametersGitHub.name,
    );
    await uiHelper.fillTextInputByLabel(
      "The branch to add the catalog entity to",
      repositoryParametersGitHub.branchName,
    );
    await uiHelper.fillTextInputByLabel(
      "The branch to target the PR/MR to",
      repositoryParametersGitHub.targetBranchName,
    );
    await uiHelper.fillTextInputByLabel("Git provider host", "github.com");

    await expect(page.getByRole("button", { name: "Review" })).toBeEnabled();
    await uiHelper.clickButton("Review");

    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeVisible();
    await uiHelper.clickButton("Create");

    // Wait for the scaffolder task to complete
    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("article").getByRole("progressbar").first(),
    ).toHaveAttribute("aria-valuenow", "100", { timeout: 120_000 });

    // Verify no errors in the task output
    await expect(page.getByRole("article").getByRole("alert")).toHaveCount(0);

    // Verify task detail shows the PR creation step completed
    await expect(page.getByText("Create PR (GitHub)")).toBeVisible();
  });

  test("GitLab form renders correctly", async ({ page, uiHelper }) => {
    await uiHelper.clickBtnInCard(TEMPLATE_TITLE, "Choose");
    await uiHelper.waitForTitle(TEMPLATE_TITLE, 2);

    await uiHelper.fillTextInputByLabel(
      "Repository URL (Backstage format)",
      "gitlab.com?owner=test-org&repo=test-repo",
    );
    await uiHelper.fillTextInputByLabel("Owner of the Repository", "test-org");
    await uiHelper.fillTextInputByLabel("Name of the repository", "test-repo");
    await uiHelper.fillTextInputByLabel(
      "The branch to add the catalog entity to",
      "backstage-integration",
    );
    await uiHelper.fillTextInputByLabel(
      "The branch to target the PR/MR to",
      "main",
    );
    await uiHelper.fillTextInputByLabel("Git provider host", "gitlab.com");

    await expect(page.getByRole("button", { name: "Review" })).toBeEnabled();
  });
});
