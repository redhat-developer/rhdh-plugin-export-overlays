import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import { CatalogApiHelper } from "../../support/api/catalog-api-helper.js";

test.describe("GitLab Events - Org Data", () => {
  let testPrefix: string;
  let parentGroupId: number;
  let testGroupId: number;
  let testUserId: number;
  let systemHookId: number;
  let rhdhUrl: string;
  let catalogToken: string;

  test.beforeAll(async ({ rhdh }) => {
    // Environment validation
    requireEnv("VAULT_EVENTS_GITLAB_TOKEN");
    requireEnv("VAULT_EVENTS_GITLAB_HOST");
    requireEnv("VAULT_EVENTS_GITLAB_PARENT_ORG");
    requireEnv("VAULT_GITLAB_WEBHOOK_SECRET");

    const gitlabToken = process.env.VAULT_EVENTS_GITLAB_TOKEN!;

    // Initialize GitLab API helper with admin-privileged token
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
      process.env.VAULT_EVENTS_GITLAB_PARENT_ORG,
    );
    parentGroupId = parentGroup.id;

    // Clean up stale resources (older than 1 hour)
    await GitLabApiHelper.cleanupStaleResources(parentGroupId, "e2e-", 1);

    // Set up system hook for org data events
    const webhookUrl = `${rhdhUrl}/api/events/http/gitlab`;
    systemHookId = await GitLabApiHelper.createSystemHook(
      webhookUrl,
      process.env.VAULT_GITLAB_WEBHOOK_SECRET!,
    );
  });

  test.beforeEach(async ({ loginHelper, page, uiHelper }) => {
    await loginHelper.loginAsKeycloakUser();

    // Extract catalog token for API calls from authenticated session
    if (!catalogToken) {
      const authApiHelper = new AuthApiHelper(page);
      await page.goto(rhdhUrl);

      // Wait for page to be ready and user to be logged in
      await uiHelper.waitForLoad();
      await page.locator("nav").first().waitFor({ state: "visible" });

      // Wait for user settings or profile button to appear
      await page
        .locator(
          'button[data-testid="user-settings-menu"], [aria-label*="user"]',
        )
        .first()
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});

      // Retry getting token until session is ready
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
      if (testUserId) {
        await GitLabApiHelper.deleteUser(testUserId, true);
      }

      if (testGroupId) {
        await GitLabApiHelper.deleteGroup(testGroupId, true);
      }

      if (systemHookId) {
        await GitLabApiHelper.deleteSystemHook(systemHookId);
      }
    } catch (error) {
      console.warn(
        `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  test.describe.serial("Groups", () => {
    test("Creating group adds Group entity", async ({ page, uiHelper }) => {
      const groupName = `${testPrefix}-org-test-group`;

      // Create group in GitLab
      testGroupId = await GitLabApiHelper.createGroup(parentGroupId, groupName);

      // Wait for the Group entity to appear in the catalog via system hook (API check)
      await expect(async () => {
        const exists = await CatalogApiHelper.entityExists(
          rhdhUrl,
          catalogToken,
          "Group",
          groupName,
        );
        expect(exists).toBe(true);
      }).toPass({
        timeout: 60000,
        intervals: [2000],
      });

      // Additional UI verification
      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "Group");
            await uiHelper.searchInputPlaceholder(groupName);
            return await page
              .getByRole("link", { name: groupName })
              .isVisible();
          },
          {
            message: `Group ${groupName} should appear in catalog UI`,
            timeout: 30000,
            intervals: [5000],
          },
        )
        .toBe(true);
    });

    test("Deleting group removes Group entity", async ({ page, uiHelper }) => {
      const groupName = `${testPrefix}-org-test-group`;

      // Delete group from GitLab with permanent removal to avoid "pending deletion" state
      await GitLabApiHelper.deleteGroup(testGroupId, true);

      // Wait for the Group entity to be removed from the catalog (API check)
      await CatalogApiHelper.waitForEntityRemoval(
        rhdhUrl,
        catalogToken,
        "Group",
        groupName,
        "default",
        60000,
        2000,
      );

      // Additional UI verification that group is removed
      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "Group");
            await uiHelper.searchInputPlaceholder(groupName);
            return await page
              .getByRole("link", { name: groupName })
              .isVisible();
          },
          {
            message: `Group ${groupName} should be removed from catalog UI`,
            timeout: 30000,
            intervals: [5000],
          },
        )
        .toBe(false);

      testGroupId = 0; // Reset so afterAll doesn't try to delete again
    });
  });

  test.describe.serial("Users", () => {
    test("Creating user adds User entity", async ({ page, uiHelper }) => {
      const userName = `${testPrefix}-test-user`;
      const userEmail = `${userName}@example.com`;

      // Create user in GitLab
      testUserId = await GitLabApiHelper.createUser(
        userName,
        userName,
        userEmail,
      );

      // Wait for the User entity to appear in the catalog via system hook (API check)
      await expect(async () => {
        const exists = await CatalogApiHelper.entityExists(
          rhdhUrl,
          catalogToken,
          "User",
          userName,
        );
        expect(exists).toBe(true);
      }).toPass({
        timeout: 60000,
        intervals: [2000],
      });

      // Additional UI verification
      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "User");
            await uiHelper.searchInputPlaceholder(userName);
            return await page.getByRole("link", { name: userName }).isVisible();
          },
          {
            message: `User ${userName} should appear in catalog UI`,
            timeout: 30000,
            intervals: [5000],
          },
        )
        .toBe(true);
    });

    test("Deleting user removes User entity", async ({ page, uiHelper }) => {
      const userName = `${testPrefix}-test-user`;

      // Delete user from GitLab with hard delete to avoid "pending deletion" state
      await GitLabApiHelper.deleteUser(testUserId, true);

      // Wait for the User entity to be removed from the catalog (API check)
      await CatalogApiHelper.waitForEntityRemoval(
        rhdhUrl,
        catalogToken,
        "User",
        userName,
        "default",
        60000,
        2000,
      );

      // Additional UI verification that user is removed
      await expect
        .poll(
          async () => {
            await page.reload();
            await uiHelper.openSidebar("Catalog");
            await uiHelper.selectMuiBox("Kind", "User");
            await uiHelper.searchInputPlaceholder(userName);
            return await page.getByRole("link", { name: userName }).isVisible();
          },
          {
            message: `User ${userName} should be removed from catalog UI`,
            timeout: 30000,
            intervals: [5000],
          },
        )
        .toBe(false);

      testUserId = 0; // Reset so afterAll doesn't try to delete again
    });
  });

  test.describe.serial("Membership", () => {
    test("Adding user to group updates membership", async () => {
      // Create test group and user for membership tests
      const groupName = `${testPrefix}-membership-group`;
      const userName = `${testPrefix}-membership-user`;
      const userEmail = `${userName}@example.com`;

      const groupId = await GitLabApiHelper.createGroup(
        parentGroupId,
        groupName,
      );
      const userId = await GitLabApiHelper.createUser(
        userName,
        userName,
        userEmail,
      );

      // Wait for entities to be created
      await CatalogApiHelper.waitForEntity(
        rhdhUrl,
        catalogToken,
        "Group",
        groupName,
        "default",
        60000,
        2000,
      );
      await CatalogApiHelper.waitForEntity(
        rhdhUrl,
        catalogToken,
        "User",
        userName,
        "default",
        60000,
        2000,
      );

      // Add user to group
      await GitLabApiHelper.addUserToGroup(groupId, userId);

      // Wait for membership to be reflected in the catalog
      await expect(async () => {
        const groupMembers = await CatalogApiHelper.getGroupMembers(
          rhdhUrl,
          catalogToken,
          groupName,
        );
        expect(groupMembers).toContain(userName);
      }).toPass({
        timeout: 60000,
        intervals: [2000],
      });

      // Clean up for next test with permanent removal
      await GitLabApiHelper.removeUserFromGroup(groupId, userId);
      await GitLabApiHelper.deleteUser(userId, true);
      await GitLabApiHelper.deleteGroup(groupId, true);
    });

    test("Removing user from group updates membership", async () => {
      // Create test group and user
      const groupName = `${testPrefix}-removal-group`;
      const userName = `${testPrefix}-removal-user`;
      const userEmail = `${userName}@example.com`;

      const groupId = await GitLabApiHelper.createGroup(
        parentGroupId,
        groupName,
      );
      const userId = await GitLabApiHelper.createUser(
        userName,
        userName,
        userEmail,
      );

      // Wait for entities and add user to group
      await CatalogApiHelper.waitForEntity(
        rhdhUrl,
        catalogToken,
        "Group",
        groupName,
        "default",
        60000,
        2000,
      );
      await CatalogApiHelper.waitForEntity(
        rhdhUrl,
        catalogToken,
        "User",
        userName,
        "default",
        60000,
        2000,
      );
      await GitLabApiHelper.addUserToGroup(groupId, userId);

      // Wait for membership to be established
      await expect(async () => {
        const groupMembers = await CatalogApiHelper.getGroupMembers(
          rhdhUrl,
          catalogToken,
          groupName,
        );
        expect(groupMembers).toContain(userName);
      }).toPass({
        timeout: 60000,
        intervals: [2000],
      });

      // Remove user from group
      await GitLabApiHelper.removeUserFromGroup(groupId, userId);

      // Wait for membership to be removed from the catalog
      await expect(async () => {
        const groupMembers = await CatalogApiHelper.getGroupMembers(
          rhdhUrl,
          catalogToken,
          groupName,
        );
        expect(groupMembers).not.toContain(userName);
      }).toPass({
        timeout: 60000,
        intervals: [2000],
      });

      // Clean up with permanent removal
      await GitLabApiHelper.deleteUser(userId, true);
      await GitLabApiHelper.deleteGroup(groupId, true);
    });
  });
});
