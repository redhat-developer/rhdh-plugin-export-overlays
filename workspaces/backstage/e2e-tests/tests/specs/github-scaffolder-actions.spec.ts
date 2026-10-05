import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { Page } from "@playwright/test";

import { GitHubScaffolderApi } from "../../support/api/github-scaffolder-api.js";
import { runGitHubCleanupSafely } from "../../support/github/common-test-setup.js";
import {
  bootstrapGitHubScaffolderPreflight,
  buildGitHubScaffolderNames,
  deleteGitHubScaffolderSharedState,
  deployGitHubScaffolderHub,
  GITHUB_SCAFFOLDER_TEST_ORG,
  initOrRestoreGitHubScaffolderSharedState,
  isGitHubScaffolderCleanupEnabled,
  requireGitHubScaffolderSharedState,
  writeGitHubScaffolderSharedState,
  type GitHubScaffolderSharedState,
} from "../../support/github/scaffolder-test-setup.js";

async function waitForScaffolderSuccess(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeHidden({ timeout: 120_000 });
  await expect(
    page.getByRole("article").getByRole("progressbar").first(),
  ).toHaveAttribute("aria-valuenow", "100", { timeout: 120_000 });
  await expect(page.getByRole("article").getByRole("alert")).toHaveCount(0);
}

async function runScaffolderTemplate(
  page: Page,
  uiHelper: UIhelper,
  templateTitle: string,
  fillParameters: () => Promise<void>,
): Promise<void> {
  await uiHelper.verifyHeading("Templates");
  await expect(async () => {
    await uiHelper.clickBtnInCard(templateTitle, "Choose");
    await expect(
      page.getByRole("heading", { name: templateTitle, level: 2 }),
    ).toBeVisible();
  }).toPass({ timeout: 5000 });
  await fillParameters();
  const reviewButton = page.getByRole("button", { name: "Review" });
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();
  const createButton = page.getByRole("button", {
    name: "Create",
    exact: true,
  });
  await expect(createButton).toBeVisible();
  await createButton.click();
  await waitForScaffolderSuccess(page);
}

test.describe.serial("GitHub Scaffolder Actions", () => {
  let sharedState: GitHubScaffolderSharedState;
  let playwrightProjectName: string;

  test.beforeAll(async ({ rhdh }, testInfo) => {
    playwrightProjectName = testInfo.project.name;

    await bootstrapGitHubScaffolderPreflight();

    await test.runOnce(
      `github-scaffolder-setup-${playwrightProjectName}`,
      async () => {
        sharedState = initOrRestoreGitHubScaffolderSharedState(
          playwrightProjectName,
        );
        if (!sharedState.testPrefix) {
          sharedState.testPrefix = GitHubScaffolderApi.generateTestPrefix();
          writeGitHubScaffolderSharedState(playwrightProjectName, sharedState);
        }

        await deployGitHubScaffolderHub(rhdh);
      },
    );

    sharedState = initOrRestoreGitHubScaffolderSharedState(
      playwrightProjectName,
    );
  });

  test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
    await loginHelper.loginAsGuest();
    await uiHelper.goToPageUrl("/create");
    await uiHelper.dismissQuickstartIfVisible();

    if (testInfo.retry > 0) {
      console.info(
        `Attempt ${testInfo.retry + 1} failed, waiting for scaffolder page to be ready before retry...`,
      );
      await uiHelper.verifyHeading("Templates");
      await expect(
        page.getByRole("button", { name: "Create", exact: true }),
      ).toBeHidden();
    }
  });

  test.afterAll(async () => {
    const state = initOrRestoreGitHubScaffolderSharedState(
      playwrightProjectName,
    );

    if (isGitHubScaffolderCleanupEnabled()) {
      await runGitHubCleanupSafely(async () => {
        if (state.repoName) {
          await GitHubScaffolderApi.deleteRepository(
            GITHUB_SCAFFOLDER_TEST_ORG,
            state.repoName,
          );
        }
      });
    } else if (state.repoName) {
      console.info(
        "GitHub scaffolder cleanup skipped (set GITHUB_SCAFFOLDER_CLEANUP=true locally, or run in CI). Preserved resources:",
      );
      console.info(`  repoFullName: ${state.repoFullName}`);
      console.info(`  repoName: ${state.repoName}`);
    }

    deleteGitHubScaffolderSharedState(playwrightProjectName);
  });

  test("publish:github with autolinks:create", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const names = buildGitHubScaffolderNames(sharedState.testPrefix);

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitHub publish E2E",
      async () => {
        await uiHelper.fillTextInputByLabel("Repository name", names.repoName);
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          names.repoUrl,
        );
      },
    );

    // Verify the repository was created
    let repoExists = false;
    await expect
      .poll(
        async () => {
          try {
            await GitHubScaffolderApi.getRepository(
              GITHUB_SCAFFOLDER_TEST_ORG,
              names.repoName,
            );
            repoExists = true;
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    expect(repoExists).toBe(true);

    // Verify catalog-info.yaml was committed to the repo
    await expect
      .poll(
        async () =>
          GitHubScaffolderApi.getRepositoryFile(
            GITHUB_SCAFFOLDER_TEST_ORG,
            names.repoName,
            "catalog-info.yaml",
          ),
        { timeout: 30_000 },
      )
      .toBeDefined();

    // Verify the autolink reference was created
    await expect
      .poll(
        async () => {
          const autolinks = await GitHubScaffolderApi.listAutolinks(
            GITHUB_SCAFFOLDER_TEST_ORG,
            names.repoName,
          );
          return autolinks.some((a) => a.key_prefix === "E2E-");
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    sharedState = {
      testPrefix: sharedState.testPrefix,
      repoName: names.repoName,
      repoFullName: names.repoFullName,
      repoUrl: names.repoUrl,
      publishCompleted: true,
    };
    writeGitHubScaffolderSharedState(playwrightProjectName, sharedState);

    console.info(
      `GitHub scaffolder publish complete — created repo: ${names.repoFullName}`,
    );
  });

  test("github:issues:create and github:issues:label", async ({
    page,
    uiHelper,
  }) => {
    test.setTimeout(180_000);

    const state = requireGitHubScaffolderSharedState(playwrightProjectName);
    const issueTitle = `${state.testPrefix}-issue`;

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitHub create issue E2E",
      async () => {
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          state.repoUrl,
        );
        await uiHelper.fillTextInputByLabel("Issue title", issueTitle);
      },
    );

    // Verify the issue was created with the expected title
    await expect
      .poll(
        async () => {
          const issues = await GitHubScaffolderApi.listIssues(
            GITHUB_SCAFFOLDER_TEST_ORG,
            state.repoName,
            issueTitle,
          );
          return issues.some((issue) => issue.title === issueTitle);
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // Verify the "e2e-test" label was applied
    await expect
      .poll(
        async () => {
          const issues = await GitHubScaffolderApi.listIssues(
            GITHUB_SCAFFOLDER_TEST_ORG,
            state.repoName,
            issueTitle,
          );
          const issue = issues.find((i) => i.title === issueTitle);
          if (!issue) return false;
          const labels = await GitHubScaffolderApi.getIssueLabels(
            GITHUB_SCAFFOLDER_TEST_ORG,
            state.repoName,
            issue.number,
          );
          return labels.some((l) => l.name === "e2e-test");
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test("publish:github:pull-request", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const state = requireGitHubScaffolderSharedState(playwrightProjectName);
    const prTitle = `${state.testPrefix}-pr`;
    const branchName = `${state.testPrefix}-pr-branch`;

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitHub pull request E2E",
      async () => {
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          state.repoUrl,
        );
        await uiHelper.fillTextInputByLabel("Pull request title", prTitle);
        await uiHelper.fillTextInputByLabel("Source branch name", branchName);
      },
    );

    await expect
      .poll(
        async () => {
          const pullRequests = await GitHubScaffolderApi.listPullRequests(
            GITHUB_SCAFFOLDER_TEST_ORG,
            state.repoName,
            branchName,
          );
          return pullRequests.some(
            (pr) => pr.title === prTitle && pr.head.ref === branchName,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test("github:repo:push", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const state = requireGitHubScaffolderSharedState(playwrightProjectName);
    const commitMessage = `${state.testPrefix} repo push`;
    const pushedFilePath = "e2e-repo-push.yaml";
    // github:repo:push inits a new git history and cannot fast-forward onto
    // main from publish:github. The template pushes that history to this
    // branch on the same repository. Keep it aligned with defaultBranch in
    // github-repo-push.yaml.
    const pushBranch = "e2e-repo-push";

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitHub repo push E2E",
      async () => {
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          state.repoUrl,
        );
        await uiHelper.fillTextInputByLabel("Commit message", commitMessage);
      },
    );

    await expect
      .poll(
        async () => {
          const file = await GitHubScaffolderApi.getRepositoryFile(
            GITHUB_SCAFFOLDER_TEST_ORG,
            state.repoName,
            pushedFilePath,
            pushBranch,
          );
          return file?.path === pushedFilePath;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });
});
