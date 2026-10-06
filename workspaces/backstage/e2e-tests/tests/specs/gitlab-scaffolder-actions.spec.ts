import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import { GitLabScaffolderApi } from "../../support/api/gitlab-scaffolder-api.js";
import { runGitLabCleanupSafely } from "../../support/gitlab/common-test-setup.js";
import {
  bootstrapGitLabDiscoveryApiClient,
  bootstrapGitLabScaffolderPreflight,
  buildGitLabScaffolderNames,
  deleteGitLabScaffolderSharedState,
  deployGitLabScaffolderHub,
  initOrRestoreGitLabScaffolderSharedState,
  isGitLabScaffolderCleanupEnabled,
  requireGitLabScaffolderSharedState,
  writeGitLabScaffolderSharedState,
  type GitLabScaffolderSharedState,
} from "../../support/gitlab/scaffolder-test-setup.js";
import { ensureScaffolderState } from "../../support/scaffolder/scaffolder-setup.js";
import {
  fillRepositoryLocation,
  pollUntil,
  pollUntilDefined,
  prepareScaffolderCreatePage,
  runScaffolderTemplate,
} from "../../support/scaffolder/template-ui.js";

test.describe.serial("GitLab Scaffolder Actions", () => {
  let sharedState: GitLabScaffolderSharedState;
  let playwrightProjectName: string;

  test.beforeAll(async ({ rhdh }, testInfo) => {
    playwrightProjectName = testInfo.project.name;

    await bootstrapGitLabScaffolderPreflight();
    sharedState = await ensureScaffolderState({
      projectName: playwrightProjectName,
      runOnceKey: "gitlab-scaffolder-setup",
      readState: initOrRestoreGitLabScaffolderSharedState,
      writeState: writeGitLabScaffolderSharedState,
      generatePrefix: () => GitLabApiHelper.generateTestPrefix(),
      deploy: () => deployGitLabScaffolderHub(rhdh),
    });
  });

  test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
    await prepareScaffolderCreatePage(page, loginHelper, uiHelper, testInfo);
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
      console.info(
        "GitLab scaffolder cleanup skipped (set GITLAB_SCAFFOLDER_CLEANUP=true locally, or run in CI). Preserved resources:",
      );
      console.info(`  subgroupPath: ${state.subgroupPath}`);
      console.info(`  subgroupId: ${state.subgroupId}`);
      console.info(`  projectName: ${state.projectName}`);
      console.info(`  projectId: ${state.projectId}`);
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
        await fillRepositoryLocation(uiHelper, names.repoUrl);
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
          const project = await GitLabScaffolderApi.findProjectInGroup(
            subgroup.id,
            names.projectName,
          );
          projectId = project?.id ?? 0;
          return projectId;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    await pollUntilDefined(() =>
      GitLabScaffolderApi.getRepositoryFile(projectId, "catalog-info.yaml"),
    );

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
    console.info("GitLab scaffolder publish complete — created resources:");
    console.info(`  subgroupPath: ${names.subgroupPath} (id=${subgroupId})`);
    console.info(`  projectPath: ${projectPath} (id=${projectId})`);
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
        await fillRepositoryLocation(uiHelper, state.repoUrl);
      },
    );

    await pollUntil(async () => {
      const issues = await GitLabScaffolderApi.listProjectIssues(
        state.projectId,
        editedIssueTitle,
      );
      return issues.some((issue) => issue.title === editedIssueTitle);
    });
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
        await fillRepositoryLocation(uiHelper, state.repoUrl);
        await uiHelper.fillTextInputByLabel("Merge request title", mrTitle);
        await uiHelper.fillTextInputByLabel("Source branch name", branchName);
      },
    );

    await pollUntil(async () => {
      const mergeRequests = await GitLabScaffolderApi.listMergeRequests(
        state.projectId,
        branchName,
      );
      return mergeRequests.some(
        (mergeRequest) =>
          mergeRequest.title === mrTitle &&
          mergeRequest.source_branch === branchName,
      );
    });
  });

  test("gitlab:user:info", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const state = requireGitLabScaffolderSharedState(playwrightProjectName);
    const currentUser = await GitLabScaffolderApi.getCurrentUser();

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitLab user info E2E",
      async () => {
        await fillRepositoryLocation(uiHelper, state.repoUrl);
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
        await fillRepositoryLocation(uiHelper, state.repoUrl);
        await uiHelper.fillTextInputByLabel("Variable key", variableKey);
        await uiHelper.fillTextInputByLabel("Variable value", variableValue);
      },
    );

    await pollUntil(async () => {
      const variable = await GitLabScaffolderApi.getProjectVariable(
        state.projectId,
        variableKey,
      );
      return variable?.value === variableValue;
    });
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
        await fillRepositoryLocation(uiHelper, state.repoUrl);
        await uiHelper.fillTextInputByLabel("Commit message", commitMessage);
      },
    );

    await pollUntil(async () => {
      const file = await GitLabScaffolderApi.getRepositoryFile(
        state.projectId,
        pushedFilePath,
      );
      return file?.file_path === pushedFilePath;
    });
  });
});
