import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { CatalogApiHelper } from "../../support/api/catalog-api-helper.js";
import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import {
  addGitLabUserToGroupAndWaitForCatalogMember,
  bootstrapGitLabEventsApiClient,
  createGitLabGroupAndUserVisibleInCatalog,
  deployGitLabEventsHub,
  fetchCatalogSessionToken,
  permanentlyDeleteGitLabUserAndGroup,
  prepareGitLabEventsParentGroup,
  runGitLabEventsCleanupSafely,
  waitForCatalogGroupMemberAbsent,
} from "../../support/gitlab-events-test-setup.js";

test.describe("GitLab Events - Org Data", () => {
  let testPrefix: string;
  let parentGroupId: number;
  let testGroupId: number;
  let testUserId: number;
  let systemHookId: number;
  let rhdhUrl: string;
  let catalogToken: string;

  test.beforeAll(async ({ rhdh }) => {
    testPrefix = bootstrapGitLabEventsApiClient();
    rhdhUrl = await deployGitLabEventsHub(rhdh);

    parentGroupId = (await prepareGitLabEventsParentGroup()).parentGroupId;

    // Set up system hook for org data events
    const webhookUrl = `${rhdhUrl}/api/events/http/gitlab`;
    systemHookId = await GitLabApiHelper.createSystemHook(
      webhookUrl,
      process.env.VAULT_GITLAB_WEBHOOK_SECRET,
    );
  });

  test.beforeEach(async ({ loginHelper, page, uiHelper }) => {
    await loginHelper.loginAsKeycloakUser();

    if (!catalogToken) {
      catalogToken = await fetchCatalogSessionToken(page, uiHelper, rhdhUrl);
    }
  });

  test.afterAll(async () => {
    await runGitLabEventsCleanupSafely(async () => {
      if (testUserId) {
        await GitLabApiHelper.deleteUser(testUserId, true);
      }

      if (testGroupId) {
        await GitLabApiHelper.deleteGroup(testGroupId, true);
      }

      if (systemHookId) {
        await GitLabApiHelper.deleteSystemHook(systemHookId);
      }
    });
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
      const groupName = `${testPrefix}-membership-group`;
      const userName = `${testPrefix}-membership-user`;

      const { groupId, userId } =
        await createGitLabGroupAndUserVisibleInCatalog({
          parentGroupId,
          rhdhUrl,
          catalogToken,
          groupName,
          userName,
        });

      await addGitLabUserToGroupAndWaitForCatalogMember({
        rhdhUrl,
        catalogToken,
        groupName,
        userName,
        groupId,
        userId,
      });

      await GitLabApiHelper.removeUserFromGroup(groupId, userId);
      await permanentlyDeleteGitLabUserAndGroup(userId, groupId);
    });

    test("Removing user from group updates membership", async () => {
      const groupName = `${testPrefix}-removal-group`;
      const userName = `${testPrefix}-removal-user`;

      const { groupId, userId } =
        await createGitLabGroupAndUserVisibleInCatalog({
          parentGroupId,
          rhdhUrl,
          catalogToken,
          groupName,
          userName,
        });

      await addGitLabUserToGroupAndWaitForCatalogMember({
        rhdhUrl,
        catalogToken,
        groupName,
        userName,
        groupId,
        userId,
      });

      await GitLabApiHelper.removeUserFromGroup(groupId, userId);

      await waitForCatalogGroupMemberAbsent({
        rhdhUrl,
        catalogToken,
        groupName,
        userName,
      });

      await permanentlyDeleteGitLabUserAndGroup(userId, groupId);
    });
  });
});
