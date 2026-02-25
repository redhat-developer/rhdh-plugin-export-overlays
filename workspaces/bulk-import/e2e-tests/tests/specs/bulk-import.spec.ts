import { APIHelper } from "rhdh-e2e-test-utils/helpers";
import { test, expect, Page } from "../fixtures";

export const WAIT_OBJECTS = {
  MuiLinearProgress: 'div[class*="MuiLinearProgress-root"]',
  MuiCircularProgress: '[class*="MuiCircularProgress-root"]',
};

test.describe("Bulk import tests", () => {
  const catalogRepoName = `janus-test-1-bulk-import-test-${Date.now()}`;
  const githubOrg = 'cloud-eda';
  const catalogRepoDetails = {
    name: catalogRepoName,
    url: `github.com/${githubOrg}/${catalogRepoName}`,
    org: `github.com/${githubOrg}`,
    owner: githubOrg,
  };

  test.beforeAll(async () => {
    test.info().annotations.push({
      type: "component",
      description: "plugins",
    });

    // Create the repository with catalog-info.yaml file dynamically
    await APIHelper.createGitHubRepoWithFile(
      catalogRepoDetails.owner,
      catalogRepoDetails.name,
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

      await uiHelper.searchInputPlaceholder(catalogRepoDetails.name);
      await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, []);
    }).toPass({
      intervals: [5_000],
      timeout: 40_000,
    });

    await page
      .locator(`tr:has(:text-is("${catalogRepoDetails.name}"))`)
      .getByRole("checkbox")
      .check();
    await uiHelper.verifyRowInTableByUniqueText(catalogRepoDetails.name, [
      catalogRepoDetails.url,
    ]);

    await expect(await uiHelper.clickButton("Import")).toBeDisabled({
      timeout: 10000,
    });

    const workflowPage = await clickLinkWithNewTab(page, "View workflow");
    await expect(workflowPage.getByRole("link", { name: "PR_URL" })).toBeVisible(
      { timeout: 10000 },
    );
  });

  test.afterAll(async () => {
    try {
      // Delete the dynamically created GitHub repository with catalog-info.yaml
      await APIHelper.deleteGitHubRepo(
        catalogRepoDetails.owner,
        catalogRepoDetails.name,
      );

      console.log(
        `[Cleanup] Deleted GitHub repository: ${catalogRepoDetails.name}`,
      );
    } catch (error) {
      console.error(`[Cleanup] Final cleanup failed: ${(error as any).message}`);
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
