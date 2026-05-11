import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { CatalogApiHelper } from "../../support/api/catalog-api-helper.js";
import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";

test.describe("GitLab Events - Discovery", () => {
  let testPrefix: string;
  let parentGroupId: number;
  let testGroupId: number;
  let testProjectId: number;
  let projectWebhookId: number;
  let rhdhUrl: string;
  let catalogToken: string;

  test.beforeAll(async ({ rhdh }) => {
    // Environment validation
    requireEnv("VAULT_EVENTS_GITLAB_TOKEN");
    requireEnv("VAULT_EVENTS_GITLAB_HOST");
    requireEnv("VAULT_EVENTS_GITLAB_PARENT_ORG");
    requireEnv("VAULT_GITLAB_WEBHOOK_SECRET");

    const gitlabToken = process.env.VAULT_EVENTS_GITLAB_TOKEN!;

    // Initialize GitLab API helper with the same token for both regular and admin operations
    GitLabApiHelper.init(
      `https://${process.env.VAULT_EVENTS_GITLAB_HOST!}`,
      gitlabToken,
    );

    // Generate unique test prefix
    testPrefix = GitLabApiHelper.generateTestPrefix();

    // Configure and deploy RHDH
    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/gitlab-events/app-config-rhdh.yaml",
      secrets: "tests/config/gitlab-events/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/gitlab-events/dynamic-plugins.yaml",
    });

    await rhdh.deploy();
    rhdhUrl = rhdh.rhdhUrl;

    // Get parent group ID
    const parentGroup = await GitLabApiHelper.getGroupByPath(
      process.env.VAULT_EVENTS_GITLAB_PARENT_ORG!,
    );
    parentGroupId = parentGroup.id;

    // Clean up stale resources (older than 1 hour)
    await GitLabApiHelper.cleanupStaleResources(parentGroupId, "e2e-", 1);

    // Create test group for this run
    const testGroupName = `${testPrefix}-test-group`;
    testGroupId = await GitLabApiHelper.createGroup(
      parentGroupId,
      testGroupName,
    );

    // Create test project in the group
    const testProjectName = `${testPrefix}-test-project`;
    testProjectId = await GitLabApiHelper.createProject(
      testGroupId,
      testProjectName,
    );

    // Set up project webhook for discovery events
    const webhookUrl = `${rhdhUrl}/api/events/http/gitlab`;
    projectWebhookId = await GitLabApiHelper.createProjectWebhook(
      testProjectId,
      webhookUrl,
      process.env.VAULT_GITLAB_WEBHOOK_SECRET!,
    );
  });

  test.beforeEach(async ({ loginHelper, page, uiHelper }) => {
    await loginHelper.loginAsKeycloakUser();

    if (!catalogToken) {
      const authApiHelper = new AuthApiHelper(page);
      await page.goto(rhdhUrl);
      await uiHelper.waitForLoad();
      await page.locator("nav").first().waitFor({ state: "visible" });
      await page
        .locator(
          'button[data-testid="user-settings-menu"], [aria-label*="user"]',
        )
        .first()
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});

      await expect
        .poll(
          async () => {
            try {
              const token = await authApiHelper.getToken();
              if (token && token.length > 0) {
                catalogToken = token;
                return true;
              }
              return false;
            } catch {
              return false;
            }
          },
          {
            message: "Token should be retrieved after session is established",
            timeout: 30000,
            intervals: [2000],
          },
        )
        .toBe(true);
    }
  });

  test.afterAll(async () => {
    // Clean up test resources with permanent removal
    try {
      // Webhook must go before removing the project
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
    } catch (error) {
      console.warn(
        `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  test.describe.serial("Catalog Sync via Webhooks", () => {
    test("Adding catalog-info.yaml creates entity", async ({
      page,
      uiHelper,
    }) => {
      const entityName = `${testPrefix}-component`;
      const catalogContent = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${entityName}
  annotations:
    gitlab.com/project-slug: ${process.env.VAULT_EVENTS_GITLAB_PARENT_ORG!}/${testPrefix}-test-project
spec:
  type: service
  lifecycle: experimental
  owner: guests`;

      // Create catalog-info.yaml in the test project
      await GitLabApiHelper.createFile(
        testProjectId,
        "catalog-info.yaml",
        catalogContent,
        `Add catalog-info.yaml for ${entityName}`,
      );

      // UI verification
      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "Component");
            await uiHelper.searchInputPlaceholder(entityName);
            return await page
              .getByRole("link", { name: entityName })
              .isVisible();
          },
          {
            message: `Component ${entityName} should appear in catalog UI`,
            timeout: 30000,
            intervals: [5000],
          },
        )
        .toBe(true);
    });

    test("Updating catalog-info.yaml updates entity", async ({
      page,
      uiHelper,
    }) => {
      const entityName = `${testPrefix}-component`;
      const updatedCatalogContent = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: ${entityName}
  description: "Updated description via webhook"
  annotations:
    gitlab.com/project-slug: ${process.env.VAULT_EVENTS_GITLAB_PARENT_ORG!}/${testPrefix}-test-project
spec:
  type: service
  lifecycle: production
  owner: guests`;

      // Update catalog-info.yaml in the test project
      await GitLabApiHelper.updateFile(
        testProjectId,
        "catalog-info.yaml",
        updatedCatalogContent,
        `Update catalog-info.yaml for ${entityName}`,
      );

      // UI verification for updated content
      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "Component");
            await uiHelper.searchInputPlaceholder(entityName);
            await page.getByRole("link", { name: entityName }).click();
            await uiHelper.verifyHeading(entityName);
            return await page
              .getByText("Updated description via webhook")
              .isVisible();
          },
          {
            message: `Component ${entityName} should show updated description in UI`,
            timeout: 30000,
            intervals: [5000],
          },
        )
        .toBe(true);
    });

    test("Deleting catalog-info.yaml removes entity from catalog", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(7 * 60 * 1000);

      const entityName = `${testPrefix}-component`;

      await GitLabApiHelper.deleteFile(
        testProjectId,
        "catalog-info.yaml",
        `Remove catalog-info.yaml for ${entityName}`,
      );

      await CatalogApiHelper.waitForEntityRemoval(
        rhdhUrl,
        catalogToken,
        "Component",
        entityName,
        "default",
        180_000,
        5000,
      );

      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "Component");
            await uiHelper.searchInputPlaceholder(entityName);
            return !(await page
              .getByRole("link", { name: entityName })
              .isVisible());
          },
          {
            message: `Component ${entityName} should not appear in catalog UI after catalog-info.yaml is removed`,
            timeout: 180_000,
            intervals: [5000],
          },
        )
        .toBe(true);
    });
  });
});
