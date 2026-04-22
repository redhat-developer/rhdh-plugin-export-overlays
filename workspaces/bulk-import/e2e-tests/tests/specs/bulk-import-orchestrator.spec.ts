import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { APIHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import installOrchestrator from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import { GITHUB_ORG, WAIT_OBJECTS } from "./bulk-import-shared";

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
    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh-orchestrator-mode.yaml",
      dynamicPlugins: "tests/config/dynamic-plugins-with-orchestrator.yaml",
    });
    await rhdh.deploy();
    await rhdh.waitUntilReady();

    await APIHelper.createGitHubRepoWithFile(
      catalogRepoDetailsForOrchestrator.owner,
      catalogRepoDetailsForOrchestrator.name,
      "test",
      "ABC",
    );
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("should display plugin page", async ({ page, uiHelper }) => {
    await uiHelper.openSidebar("Bulk import");
    await uiHelper.verifyHeading("Bulk import");
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

  test("should interact with plugin features", async ({ page, uiHelper }) => {
    await uiHelper.openSidebar("Bulk import");

    await expect(async () => {
      await page.reload();
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
