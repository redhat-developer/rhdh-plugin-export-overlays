import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { Page } from "@playwright/test";

import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import {
  bootstrapGitLabDiscoveryApiClient,
  bootstrapGitLabScaffolderPreflight,
  buildGitLabScaffolderNames,
  deleteGitLabScaffolderSharedState,
  deployGitLabScaffolderHub,
  initOrRestoreGitLabScaffolderSharedState,
  isGitLabScaffolderCleanupEnabled,
  requireGitLabScaffolderSharedState,
  runGitLabCleanupSafely,
  writeGitLabScaffolderSharedState,
  type GitLabScaffolderSharedState,
} from "../../support/gitlab-events-test-setup.js";

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
  await uiHelper.verifyHeading("Self-service");
  await uiHelper.clickBtnInCard(templateTitle, "Choose");
  await uiHelper.waitForTitle(templateTitle, 2);
  await fillParameters();
  await expect(page.getByRole("button", { name: "Review" })).toBeEnabled();
  await uiHelper.clickButton("Review");
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeVisible();
  await uiHelper.clickButton("Create");
  await waitForScaffolderSuccess(page);
}

test.describe.serial("GitLab Scaffolder Actions", () => {
  let sharedState: GitLabScaffolderSharedState;
  let playwrightProjectName: string;

  test.beforeAll(async ({ rhdh }, testInfo) => {
    playwrightProjectName = testInfo.project.name;

    await bootstrapGitLabScaffolderPreflight();

    await test.runOnce("gitlab-scaffolder-setup", async () => {
      sharedState = initOrRestoreGitLabScaffolderSharedState(
        playwrightProjectName,
      );
      if (!sharedState.testPrefix) {
        sharedState.testPrefix = GitLabApiHelper.generateTestPrefix();
        writeGitLabScaffolderSharedState(playwrightProjectName, sharedState);
      }

      await deployGitLabScaffolderHub(rhdh);
    });

    sharedState = initOrRestoreGitLabScaffolderSharedState(
      playwrightProjectName,
    );
  });

  test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
    await loginHelper.loginAsGuest();
    await uiHelper.goToPageUrl("/create");
    await uiHelper.dismissQuickstartIfVisible();

    if (testInfo.retry > 0) {
      const coolDownMs = 2000;
      console.log(
        `Attempt ${testInfo.retry + 1} failed, waiting ${coolDownMs}ms before retry...`,
      );
      await page.waitForTimeout(coolDownMs);
    }
  });

  test.afterAll(async () => {
    bootstrapGitLabDiscoveryApiClient();

    const state = initOrRestoreGitLabScaffolderSharedState(
      playwrightProjectName,
    );

    if (isGitLabScaffolderCleanupEnabled()) {
      await runGitLabCleanupSafely(async () => {
        if (state.projectId) {
          await GitLabApiHelper.deleteProject(state.projectId, true);
        }
        if (state.subgroupId) {
          await GitLabApiHelper.deleteGroup(state.subgroupId, true);
        }
      });
    } else if (state.projectId || state.subgroupId) {
      console.warn(
        "GitLab scaffolder cleanup skipped (set GITLAB_SCAFFOLDER_CLEANUP=true locally, or run in CI). Preserved resources:",
      );
      console.warn(`  subgroupPath: ${state.subgroupPath}`);
      console.warn(`  subgroupId: ${state.subgroupId}`);
      console.warn(`  projectName: ${state.projectName}`);
      console.warn(`  projectId: ${state.projectId}`);
    }

    deleteGitLabScaffolderSharedState(playwrightProjectName);
    await GitLabApiHelper.dispose();
  });

  test("publish:gitlab with gitlab:group:ensureExists", async ({
    page,
    uiHelper,
  }) => {
    test.setTimeout(180_000);

    const names = buildGitLabScaffolderNames(sharedState.testPrefix);

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitLab publish E2E",
      async () => {
        await uiHelper.fillTextInputByLabel("Project name", names.projectName);
        await uiHelper.fillTextInputByLabel(
          "Subgroup path",
          names.subgroupPath,
        );
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          names.repoUrl,
        );
      },
    );

    let projectId = 0;
    let subgroupId = 0;
    await expect
      .poll(
        async () => {
          const subgroup = await GitLabApiHelper.getGroupByPath(
            names.subgroupPath,
          );
          subgroupId = subgroup.id;
          const project = await GitLabApiHelper.findProjectInGroup(
            subgroup.id,
            names.projectName,
          );
          projectId = project?.id ?? 0;
          return projectId;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          GitLabApiHelper.getRepositoryFile(projectId, "catalog-info.yaml"),
        { timeout: 30_000 },
      )
      .toBeDefined();

    sharedState = {
      testPrefix: sharedState.testPrefix,
      subgroupId,
      subgroupPath: names.subgroupPath,
      projectId,
      projectName: names.projectName,
      repoUrl: names.repoUrl,
      publishCompleted: true,
    };
    writeGitLabScaffolderSharedState(playwrightProjectName, sharedState);

    const project = await GitLabApiHelper.getProject(projectId);
    const projectPath =
      project.path_with_namespace ??
      project.full_path ??
      `${names.subgroupPath}/${names.projectName}`;
    console.warn("GitLab scaffolder publish complete — created resources:");
    console.warn(`  subgroupPath: ${names.subgroupPath} (id=${subgroupId})`);
    console.warn(`  projectPath: ${projectPath} (id=${projectId})`);
  });

  test("gitlab:issues:create and gitlab:issue:edit", async ({
    page,
    uiHelper,
  }) => {
    test.setTimeout(180_000);

    const state = requireGitLabScaffolderSharedState(playwrightProjectName);
    const issueTitle = `${state.testPrefix}-issue`;
    const editedIssueTitle = `${issueTitle}-edited`;

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitLab create issue E2E",
      async () => {
        await uiHelper.fillTextInputByLabel(
          "Project ID",
          String(state.projectId),
        );
        await uiHelper.fillTextInputByLabel("Issue title", issueTitle);
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          state.repoUrl,
        );
      },
    );

    await expect
      .poll(
        async () => {
          const issues = await GitLabApiHelper.listProjectIssues(
            state.projectId,
            editedIssueTitle,
          );
          return issues.some((issue) => issue.title === editedIssueTitle);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test("publish:gitlab:merge-request", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const state = requireGitLabScaffolderSharedState(playwrightProjectName);
    const mrTitle = `${state.testPrefix}-mr`;
    const branchName = `${state.testPrefix}-mr-branch`;

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitLab merge request E2E",
      async () => {
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          state.repoUrl,
        );
        await uiHelper.fillTextInputByLabel("Merge request title", mrTitle);
        await uiHelper.fillTextInputByLabel("Source branch name", branchName);
      },
    );

    await expect
      .poll(
        async () => {
          const mergeRequests = await GitLabApiHelper.listMergeRequests(
            state.projectId,
            branchName,
          );
          return mergeRequests.some(
            (mr) => mr.title === mrTitle && mr.source_branch === branchName,
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test("gitlab:user:info", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const state = requireGitLabScaffolderSharedState(playwrightProjectName);
    const currentUser = await GitLabApiHelper.getCurrentUser();

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitLab user info E2E",
      async () => {
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          state.repoUrl,
        );
      },
    );

    expect(currentUser.state).toBe("active");
  });

  test("gitlab:projectVariable:create", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const state = requireGitLabScaffolderSharedState(playwrightProjectName);
    const variableKey = `E2E_${state.testPrefix.replace(/-/g, "_")}_VAR`;
    const variableValue = `${state.testPrefix}-value`;

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitLab project variable E2E",
      async () => {
        await uiHelper.fillTextInputByLabel(
          "Project ID",
          String(state.projectId),
        );
        await uiHelper.fillTextInputByLabel(
          "Repository Location",
          state.repoUrl,
        );
        await uiHelper.fillTextInputByLabel("Variable key", variableKey);
        await uiHelper.fillTextInputByLabel("Variable value", variableValue);
      },
    );

    await expect
      .poll(
        async () => {
          const variable = await GitLabApiHelper.getProjectVariable(
            state.projectId,
            variableKey,
          );
          return variable?.value === variableValue;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test("gitlab:repo:push", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const state = requireGitLabScaffolderSharedState(playwrightProjectName);
    const commitMessage = `${state.testPrefix} repo push`;
    const pushedFilePath = "e2e-repo-push.yaml";

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitLab repo push E2E",
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
          const file = await GitLabApiHelper.getRepositoryFile(
            state.projectId,
            pushedFilePath,
          );
          return file?.file_path === pushedFilePath;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  });
});
