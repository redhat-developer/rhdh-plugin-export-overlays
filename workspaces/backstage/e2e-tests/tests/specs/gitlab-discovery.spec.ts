import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import {
  bootstrapSelfHostedGitLabApiClient,
  prepareGitLabParentGroup,
  requireSelfHostedGitLabEnv,
  runGitLabCleanupSafely,
} from "../../support/gitlab/common-test-setup.js";

/** Static token from tests/config/gitlab-discovery/app-config-rhdh.yaml */
const CATALOG_TOKEN = "test-token";

test.describe("gitlab discovery UI tests", () => {
  let entityName: string;
  let projectId: number | undefined;
  let rhdhUrl: string;

  test.beforeAll(async ({ rhdh }) => {
    // A restarted worker runs this again: it creates a fresh project, which the
    // provider's one-minute schedule discovers on the already deployed hub.
    const testPrefix = bootstrapSelfHostedGitLabApiClient();
    const parent = await prepareGitLabParentGroup(
      requireSelfHostedGitLabEnv().parentGroupPath,
    );

    entityName = `${testPrefix}-discovery`;
    projectId = await GitLabApiHelper.createProject(
      parent.parentGroupId,
      entityName,
    );
    await GitLabApiHelper.createFile(
      projectId,
      "catalog-info.yaml",
      `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${entityName}
  description: My Description
spec:
  type: website
  lifecycle: experimental
  owner: guests`,
      `Add catalog-info.yaml for ${entityName}`,
    );

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
    await runGitLabCleanupSafely(async () => {
      if (projectId) {
        await GitLabApiHelper.deleteProject(projectId, true);
      }
    });
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
