import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import installOrchestrator from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import { GITHUB_ORG } from "./bulk-import-shared";
import {
  dismissBulkImportLoginDialogIfPresent,
  ensureGithubUserSession,
} from "../support/utils";

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
    await ensureGithubUserSession(page, loginHelper);
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
        catalogRepoDetailsForOrchestrator.owner,
        catalogRepoDetailsForOrchestrator.name,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Cleanup] Final cleanup failed: ${message}`);
    }
  });

  test("should display plugin page", async ({ page }) => {
    await expect(page.locator("text=Selected repositories (0)")).toBeVisible();

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

  test("should interact with plugin features", async ({
    page,
    uiHelper,
    loginHelper,
  }) => {
    await expect(async () => {
      await page.reload();
      await uiHelper.waitForLoad(12_000);
      await loginHelper.checkAndClickOnGHloginPopup();
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
      timeout: 10_000,
    });

    const workflowPage = await clickLinkWithNewTab(page, "View workflow");
    await expect(
      workflowPage.getByRole("link", { name: "PR_URL" }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
