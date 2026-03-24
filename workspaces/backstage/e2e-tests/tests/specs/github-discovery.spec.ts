import { CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { GithubApiHelper } from "../../support/api/github-api-helper";
import { RHDH_GITHUB_TEST_ORGANIZATION } from "../../support/constants/github/organization";

test.describe("Github Discovery Catalog", () => {
  let catalogPage: CatalogPage;
  let githubApiHelper: GithubApiHelper;

  test.beforeAll(async ({ rhdh }) => {
    // Allow time for deployment + 1 min provider refresh delay + browser setup
    test.setTimeout(10 * 60 * 1000);

    test.info().annotations.push({
      type: "component",
      description: "api",
    });

    await rhdh.configure({
      auth: "github",
      appConfig: "tests/config/github-discovery/app-config-rhdh.yaml",
      secrets: "tests/config/github-discovery/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/github-discovery/dynamic-plugins.yaml",
    });
    await rhdh.deploy();
    // Wait 1 minute for github provider to refresh entities before running tests
    await new Promise((resolve) => setTimeout(resolve, 1 * 60 * 1000));
  });

  test.beforeEach(async ({ loginHelper, page }) => {
    await loginHelper.loginAsGithubUser();
    catalogPage = new CatalogPage(page);
    githubApiHelper = new GithubApiHelper();
    await catalogPage.go();
  });

  test(`Discover Organization's Catalog`, async () => {
    const organizationRepos = await githubApiHelper.getReposFromOrg(
      RHDH_GITHUB_TEST_ORGANIZATION,
    );
    const reposNames: string[] = (organizationRepos as Array<{ name?: string }>)
      .map((repo) => repo.name)
      .filter((name): name is string => typeof name === "string");

    const reposWithCatalogInfo: string[] = (
      await Promise.all(
        reposNames.map(async (repo) =>
          (await githubApiHelper.fileExistsInRepo(
            `${RHDH_GITHUB_TEST_ORGANIZATION}/${repo}`,
            "catalog-info.yaml",
          ))
            ? repo
            : null,
        ),
      )
    ).filter((repo): repo is string => typeof repo === "string");

    for (const repo of reposWithCatalogInfo) {
      await catalogPage.search(repo);
      const row = await catalogPage.tableRow(repo);
      await expect(row).toBeVisible();
    }
    expect(true).toBe(false);
  });
});
