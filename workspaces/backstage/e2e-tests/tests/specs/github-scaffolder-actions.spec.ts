import { test } from "@red-hat-developer-hub/e2e-test-utils/test";

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
import { ensureScaffolderState } from "../../support/scaffolder/scaffolder-setup.js";
import {
  fillRepositoryLocation,
  pollUntil,
  pollUntilDefined,
  prepareScaffolderCreatePage,
  runScaffolderTemplate,
} from "../../support/scaffolder/template-ui.js";

/** Matches `defaultBranch` in github-repo-push.yaml. */
const GITHUB_REPO_PUSH_BRANCH = "e2e-repo-push";

async function issueHasLabel(
  repoName: string,
  issueTitle: string,
  labelName: string,
): Promise<boolean> {
  const issues = await GitHubScaffolderApi.listIssues(
    GITHUB_SCAFFOLDER_TEST_ORG,
    repoName,
    issueTitle,
  );
  const issue = issues.find((candidate) => candidate.title === issueTitle);
  if (!issue) {
    return false;
  }
  const labels = await GitHubScaffolderApi.getIssueLabels(
    GITHUB_SCAFFOLDER_TEST_ORG,
    repoName,
    issue.number,
  );
  return labels.some((label) => label.name === labelName);
}

test.describe.serial("GitHub Scaffolder Actions", () => {
  let sharedState: GitHubScaffolderSharedState;
  let playwrightProjectName: string;

  test.beforeAll(async ({ rhdh }, testInfo) => {
    playwrightProjectName = testInfo.project.name;
    await bootstrapGitHubScaffolderPreflight();
    sharedState = await ensureScaffolderState({
      projectName: playwrightProjectName,
      runOnceKey: `github-scaffolder-setup-${playwrightProjectName}`,
      readState: initOrRestoreGitHubScaffolderSharedState,
      writeState: writeGitHubScaffolderSharedState,
      generatePrefix: () => GitHubScaffolderApi.generateTestPrefix(),
      deploy: () => deployGitHubScaffolderHub(rhdh),
    });
  });

  test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
    await prepareScaffolderCreatePage(page, loginHelper, uiHelper, testInfo);
  });

  test.afterAll(async () => {
    const state = initOrRestoreGitHubScaffolderSharedState(
      playwrightProjectName,
    );

    if (!isGitHubScaffolderCleanupEnabled()) {
      if (state.repoName) {
        console.info(
          "GitHub scaffolder cleanup skipped (set GITHUB_SCAFFOLDER_CLEANUP=true locally, or run in CI). Preserved resources:",
        );
        console.info(`  repoFullName: ${state.repoFullName}`);
        console.info(`  repoName: ${state.repoName}`);
      }
      deleteGitHubScaffolderSharedState(playwrightProjectName);
      return;
    }

    const deleted = await runGitHubCleanupSafely(async () => {
      if (state.repoName) {
        await GitHubScaffolderApi.deleteRepository(
          GITHUB_SCAFFOLDER_TEST_ORG,
          state.repoName,
        );
      }
    });
    // Keep the name on disk when delete fails so the next run can retry.
    if (deleted) {
      deleteGitHubScaffolderSharedState(playwrightProjectName);
    }
  });

  test("publish:github with autolinks:create", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const names = buildGitHubScaffolderNames(sharedState.testPrefix);
    sharedState = {
      testPrefix: sharedState.testPrefix,
      repoName: names.repoName,
      repoFullName: names.repoFullName,
      repoUrl: names.repoUrl,
      publishCompleted: false,
    };
    writeGitHubScaffolderSharedState(playwrightProjectName, sharedState);

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitHub publish E2E",
      async () => {
        await uiHelper.fillTextInputByLabel("Repository name", names.repoName);
        await fillRepositoryLocation(uiHelper, names.repoUrl);
      },
    );

    await pollUntil(async () => {
      try {
        await GitHubScaffolderApi.getRepository(
          GITHUB_SCAFFOLDER_TEST_ORG,
          names.repoName,
        );
        return true;
      } catch {
        return false;
      }
    });

    await pollUntilDefined(() =>
      GitHubScaffolderApi.getRepositoryFile(
        GITHUB_SCAFFOLDER_TEST_ORG,
        names.repoName,
        "catalog-info.yaml",
      ),
    );

    await pollUntil(async () => {
      const autolinks = await GitHubScaffolderApi.listAutolinks(
        GITHUB_SCAFFOLDER_TEST_ORG,
        names.repoName,
      );
      return autolinks.some((autolink) => autolink.key_prefix === "E2E-");
    });

    sharedState = {
      ...sharedState,
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
        await fillRepositoryLocation(uiHelper, state.repoUrl);
        await uiHelper.fillTextInputByLabel("Issue title", issueTitle);
      },
    );

    await pollUntil(() =>
      issueHasLabel(state.repoName, issueTitle, "e2e-test"),
    );
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
        await fillRepositoryLocation(uiHelper, state.repoUrl);
        await uiHelper.fillTextInputByLabel("Pull request title", prTitle);
        await uiHelper.fillTextInputByLabel("Source branch name", branchName);
      },
    );

    await pollUntil(async () => {
      const pullRequests = await GitHubScaffolderApi.listPullRequests(
        GITHUB_SCAFFOLDER_TEST_ORG,
        state.repoName,
        branchName,
      );
      return pullRequests.some(
        (pullRequest) =>
          pullRequest.title === prTitle && pullRequest.head.ref === branchName,
      );
    });
  });

  test("github:repo:push", async ({ page, uiHelper }) => {
    test.setTimeout(180_000);

    const state = requireGitHubScaffolderSharedState(playwrightProjectName);
    const commitMessage = `${state.testPrefix} repo push`;
    const pushedFilePath = "e2e-repo-push.yaml";

    await runScaffolderTemplate(
      page,
      uiHelper,
      "GitHub repo push E2E",
      async () => {
        await fillRepositoryLocation(uiHelper, state.repoUrl);
        await uiHelper.fillTextInputByLabel("Commit message", commitMessage);
      },
    );

    await pollUntil(async () => {
      const file = await GitHubScaffolderApi.getRepositoryFile(
        GITHUB_SCAFFOLDER_TEST_ORG,
        state.repoName,
        pushedFilePath,
        GITHUB_REPO_PUSH_BRANCH,
      );
      return file?.path === pushedFilePath;
    });
  });
});
