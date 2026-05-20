import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { CatalogApiHelper } from "../../support/api/catalog-api-helper.js";
import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import {
  addGitLabUserToGroupAndWaitForCatalogMember,
  bootstrapGitLabEventsApiClient,
  createGitLabGroupAndUserVisibleInCatalog,
  deployGitLabEventsHub,
  fetchCatalogSessionToken,
  prepareGitLabEventsParentGroup,
  runGitLabEventsCleanupSafely,
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
    test("Creating group adds Group entity", async () => {
      const groupName = `${testPrefix}-org-test-group`;

      // Create group in GitLab
      testGroupId = await GitLabApiHelper.createGroup(parentGroupId, groupName);

      // Wait for the Group entity to appear in the catalog
      const entity = await CatalogApiHelper.waitForEntity(
        rhdhUrl,
        catalogToken,
        "Group",
        groupName,
        "default",
        60_000,
        2_000,
      );
      expect(entity.metadata.name).toBe(groupName);
    });

    test("Deleting group removes Group entity", async () => {
      test.setTimeout(7 * 60 * 1000);

      const groupName = `${testPrefix}-org-test-group`;

      // Delete group from GitLab with permanent removal to avoid "pending deletion" state
      await GitLabApiHelper.deleteGroup(testGroupId, true);

      // Wait for the Group entity to be removed from the catalog
      await CatalogApiHelper.waitForEntityRemoval(
        rhdhUrl,
        catalogToken,
        "Group",
        groupName,
        "default",
        180_000,
        2_000,
      );
      expect(
        await CatalogApiHelper.entityExists(
          rhdhUrl,
          catalogToken,
          "Group",
          groupName,
        ),
      ).toBe(false);

      testGroupId = 0; // Reset so afterAll doesn't try to delete again
    });
  });

  test.describe.serial("Users", () => {
    test("Creating user adds User entity", async () => {
      const userName = `${testPrefix}-test-user`;
      const userEmail = `${userName}@example.com`;

      // Create user in GitLab
      testUserId = await GitLabApiHelper.createUser(
        userName,
        userName,
        userEmail,
      );

      // Wait for the User entity to appear in the catalog
      const entity = await CatalogApiHelper.waitForEntity(
        rhdhUrl,
        catalogToken,
        "User",
        userName,
        "default",
        60_000,
        2_000,
      );
      expect(entity.metadata.name).toBe(userName);
    });

    test("Deleting user removes User entity", async () => {
      test.setTimeout(7 * 60 * 1000);

      const userName = `${testPrefix}-test-user`;

      // Delete user from GitLab with hard delete to avoid "pending deletion" state
      await GitLabApiHelper.deleteUser(testUserId, true);

      // Wait for the User entity to be removed from the catalog
      await CatalogApiHelper.waitForEntityRemoval(
        rhdhUrl,
        catalogToken,
        "User",
        userName,
        "default",
        180_000,
        2_000,
      );
      expect(
        await CatalogApiHelper.entityExists(
          rhdhUrl,
          catalogToken,
          "User",
          userName,
        ),
      ).toBe(false);

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

      const groupMembers = await CatalogApiHelper.getGroupMembers(
        rhdhUrl,
        catalogToken,
        groupName,
      );
      expect(groupMembers).toContain(userName);

      // Clean up
      await GitLabApiHelper.removeUserFromGroup(groupId, userId);
      await GitLabApiHelper.deleteUser(userId, true);
      await GitLabApiHelper.deleteGroup(groupId, true);
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

      // Polls the catalog until the user no longer appears in the group's member list.
      await expect(async () => {
        const groupMembers = await CatalogApiHelper.getGroupMembers(
          rhdhUrl,
          catalogToken,
          groupName,
        );
        expect(groupMembers).not.toContain(userName);
      }).toPass({
        timeout: 60_000,
        intervals: [2_000],
      });

      // Clean up
      await GitLabApiHelper.deleteUser(userId, true);
      await GitLabApiHelper.deleteGroup(groupId, true);
    });
  });
});
