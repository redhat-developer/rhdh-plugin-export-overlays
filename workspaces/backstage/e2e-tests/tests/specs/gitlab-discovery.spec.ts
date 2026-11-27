import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import {
  bootstrapSelfHostedGitLabApiClient,
  prepareSelfHostedGitLabParentGroup,
  runGitLabCleanupSafely,
} from "../../support/gitlab/common-test-setup.js";
import {
  deleteGitLabDiscoverySharedState,
  readGitLabDiscoverySharedState,
  requireGitLabDiscoverySharedState,
  writeGitLabDiscoverySharedState,
} from "../../support/gitlab/discovery-test-setup.js";

/** Static token from tests/config/gitlab-discovery/app-config-rhdh.yaml */
const CATALOG_TOKEN = "gitlab-discovery-e2e-token";

test.describe("gitlab discovery UI tests", () => {
  let entityName: string;
  let playwrightProjectName: string;
  let rhdhUrl: string;

  test.beforeAll(async ({ rhdh }, testInfo) => {
    playwrightProjectName = testInfo.project.name;
    const testPrefix = bootstrapSelfHostedGitLabApiClient();
    // Stale-resource cleanup and project creation run before deploy() raises
    // the timeout, so give them room of their own.
    test.setTimeout(600_000);

    // runOnce + shared state: a restarted worker (e.g. on a retry) reuses the
    // project the first worker created instead of creating a second one.
    await test.runOnce(
      `gitlab-discovery-setup-${playwrightProjectName}`,
      async () => {
        const parent = await prepareSelfHostedGitLabParentGroup();
        const name = `${testPrefix}-discovery`;
        const createdProjectId = await GitLabApiHelper.createProject(
          parent.parentGroupId,
          name,
        );
        await GitLabApiHelper.createFile(
          createdProjectId,
          "catalog-info.yaml",
          `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${name}
  description: My Description
spec:
  type: website
  lifecycle: experimental
  owner: guests`,
          `Add catalog-info.yaml for ${name}`,
        );
        writeGitLabDiscoverySharedState(playwrightProjectName, {
          entityName: name,
          projectId: createdProjectId,
        });
      },
    );
    entityName = requireGitLabDiscoverySharedState(
      playwrightProjectName,
    ).entityName;

    await rhdh.configure({
      auth: "guest",
      appConfig: "tests/config/gitlab-discovery/app-config-rhdh.yaml",
      secrets: "tests/config/gitlab-discovery/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/gitlab-discovery/dynamic-plugins.yaml",
    });

    await rhdh.deploy();
    rhdhUrl = rhdh.rhdhUrl;
  });

  test.beforeEach(async ({ loginHelper, uiHelper }) => {
    await loginHelper.loginAsGuest();
    await uiHelper.openSidebar("Catalog");
  });

  test.afterAll(async () => {
    const state = readGitLabDiscoverySharedState(playwrightProjectName);
    await runGitLabCleanupSafely(async () => {
      if (state?.projectId) {
        await GitLabApiHelper.deleteProject(state.projectId, true);
      }
    });
    deleteGitLabDiscoverySharedState(playwrightProjectName);
    await GitLabApiHelper.dispose();
    await CatalogApiHelper.dispose();
  });

  test("GitLab integration for discovering catalog entities from GitLab", async ({
    page,
    uiHelper,
  }) => {
    test.setTimeout(240_000);

    // Discovery runs on a schedule, so the entity can take up to a minute.
    await expect
      .poll(
        () =>
          CatalogApiHelper.entityExists(
            rhdhUrl,
            CATALOG_TOKEN,
            "Component",
            entityName,
          ),
        {
          message: `Component ${entityName} should be discovered from GitLab`,
          timeout: 150_000,
          intervals: [5_000],
        },
      )
      .toBe(true);

    // Reopen the catalog so the table includes the newly discovered entity.
    await uiHelper.openSidebar("Catalog");
    await uiHelper.dismissQuickstartIfVisible();
    await page
      .getByRole("textbox", { name: "Search" })
      .waitFor({ state: "visible" });
    await uiHelper.searchInputPlaceholder(entityName);
    await uiHelper.verifyTextVisible(entityName, true, 10_000);
    await uiHelper.clickLink(entityName);
    await uiHelper.verifyHeading(entityName);
    await uiHelper.verifyText("My Description");
    await uiHelper.verifyText("experimental");
    await uiHelper.verifyText("website");
    await expect(page.getByRole("link", { name: "View Source" })).toBeVisible();
  });
});
