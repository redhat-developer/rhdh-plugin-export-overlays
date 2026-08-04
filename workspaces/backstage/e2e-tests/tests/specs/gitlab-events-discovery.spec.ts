import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import {
  bootstrapGitLabEventsApiClient,
  deployGitLabEventsHub,
  prepareGitLabEventsParentGroup,
} from "../../support/gitlab/events-test-setup.js";
import { runGitLabCleanupSafely } from "../../support/gitlab/common-test-setup.js";

test.describe.serial("GitLab Events - Discovery", () => {
  let testPrefix: string;
  let parentGroupPath: string;
  let parentGroupId: number;
  let testGroupId: number;
  let testProjectId: number;
  let projectWebhookId: number;
  let rhdhUrl: string;
  let catalogToken: string;

  test.beforeAll(async ({ rhdh }) => {
    testPrefix = bootstrapGitLabEventsApiClient();
    ({ rhdhUrl, catalogToken } = await deployGitLabEventsHub(rhdh));

    const parent = await prepareGitLabEventsParentGroup();
    parentGroupPath = parent.parentGroupPath;
    parentGroupId = parent.parentGroupId;

    const testGroupName = `${testPrefix}-test-group`;
    testGroupId = await GitLabApiHelper.createGroup(
      parentGroupId,
      testGroupName,
    );

    const testProjectName = `${testPrefix}-test-project`;
    testProjectId = await GitLabApiHelper.createProject(
      testGroupId,
      testProjectName,
    );

    const webhookUrl = `${rhdhUrl}/api/events/http/gitlab`;
    projectWebhookId = await GitLabApiHelper.createProjectWebhook(
      testProjectId,
      webhookUrl,
      process.env.VAULT_GITLAB_WEBHOOK_SECRET,
    );
  });

  test.afterAll(async () => {
    await runGitLabCleanupSafely(async () => {
      if (projectWebhookId && testProjectId) {
        await GitLabApiHelper.deleteProjectWebhook(
          testProjectId,
          projectWebhookId,
        );
      }

      if (testProjectId) {
        await GitLabApiHelper.deleteProject(testProjectId, true);
      }

      if (testGroupId) {
        await GitLabApiHelper.deleteGroup(testGroupId, true);
      }
    });
    await GitLabApiHelper.dispose();
    await CatalogApiHelper.dispose();
  });

  test("Adding catalog-info.yaml creates entity", async () => {
    const entityName = `${testPrefix}-component`;
    const catalogContent = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${entityName}
  annotations:
    gitlab.com/project-slug: ${parentGroupPath}/${testPrefix}-test-project
spec:
  type: service
  lifecycle: experimental
  owner: guests`;

    await GitLabApiHelper.createFile(
      testProjectId,
      "catalog-info.yaml",
      catalogContent,
      `Add catalog-info.yaml for ${entityName}`,
    );

    await expect
      .poll(
        async () =>
          await CatalogApiHelper.entityExists(
            rhdhUrl,
            catalogToken,
            "Component",
            entityName,
          ),
        {
          message: `Component ${entityName} should appear in catalog`,
          timeout: 60_000,
          intervals: [2_000],
        },
      )
      .toBe(true);

    const entity = await CatalogApiHelper.getEntity(
      rhdhUrl,
      catalogToken,
      "Component",
      entityName,
    );
    expect(entity.metadata.name).toBe(entityName);
  });

  test("Updating catalog-info.yaml updates entity", async () => {
    const entityName = `${testPrefix}-component`;
    const updatedDescription = "Updated description via webhook";
    const updatedCatalogContent = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${entityName}
  description: "${updatedDescription}"
  annotations:
    gitlab.com/project-slug: ${parentGroupPath}/${testPrefix}-test-project
spec:
  type: service
  lifecycle: production
  owner: guests`;

    await GitLabApiHelper.updateFile(
      testProjectId,
      "catalog-info.yaml",
      updatedCatalogContent,
      `Update catalog-info.yaml for ${entityName}`,
    );

    await expect
      .poll(
        async () => {
          const entity = await CatalogApiHelper.getEntity(
            rhdhUrl,
            catalogToken,
            "Component",
            entityName,
          );
          return (
            (entity.metadata as { description?: string })?.description ===
            updatedDescription
          );
        },
        {
          message: `Component ${entityName} description should update in catalog`,
          timeout: 60_000,
          intervals: [2_000],
        },
      )
      .toBe(true);
  });

  test("Deleting catalog-info.yaml removes entity from catalog", async () => {
    test.setTimeout(7 * 60 * 1000);

    const entityName = `${testPrefix}-component`;

    await GitLabApiHelper.deleteFile(
      testProjectId,
      "catalog-info.yaml",
      `Remove catalog-info.yaml for ${entityName}`,
    );

    await expect
      .poll(
        async () =>
          !(await CatalogApiHelper.entityExists(
            rhdhUrl,
            catalogToken,
            "Component",
            entityName,
          )),
        {
          message: `Component ${entityName} should be removed from catalog`,
          timeout: 180_000,
          intervals: [5_000],
        },
      )
      .toBe(true);
  });
});
