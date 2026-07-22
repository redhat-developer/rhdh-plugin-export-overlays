import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { GitLabApiHelper } from "../../support/api/gitlab-api-helper.js";
import {
  bootstrapGitLabEventsApiClient,
  deployGitLabEventsHub,
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
    ({ rhdhUrl, catalogToken } = await deployGitLabEventsHub(rhdh));

    parentGroupId = (await prepareGitLabEventsParentGroup()).parentGroupId;

    const webhookUrl = `${rhdhUrl}/api/events/http/gitlab`;
    systemHookId = await GitLabApiHelper.createSystemHook(
      webhookUrl,
      process.env.VAULT_GITLAB_WEBHOOK_SECRET,
    );
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
    await GitLabApiHelper.dispose();
    await CatalogApiHelper.dispose();
  });

  test.describe.serial("Groups", () => {
    test("Creating group adds Group entity", async () => {
      const groupName = `${testPrefix}-org-test-group`;

      testGroupId = await GitLabApiHelper.createGroup(parentGroupId, groupName);

      await expect
        .poll(
          async () =>
            await CatalogApiHelper.entityExists(
              rhdhUrl,
              catalogToken,
              "Group",
              groupName,
            ),
          {
            message: `Group ${groupName} should appear in catalog`,
            timeout: 60_000,
            intervals: [2_000],
          },
        )
        .toBe(true);

      const entity = await CatalogApiHelper.getEntity(
        rhdhUrl,
        catalogToken,
        "Group",
        groupName,
      );
      expect(entity.metadata.name).toBe(groupName);
    });

    test("Deleting group removes Group entity", async () => {
      test.setTimeout(7 * 60 * 1000);

      const groupName = `${testPrefix}-org-test-group`;

      await GitLabApiHelper.deleteGroup(testGroupId, true);

      await expect
        .poll(
          async () =>
            !(await CatalogApiHelper.entityExists(
              rhdhUrl,
              catalogToken,
              "Group",
              groupName,
            )),
          {
            message: `Group ${groupName} should be removed from catalog`,
            timeout: 180_000,
            intervals: [2_000],
          },
        )
        .toBe(true);

      testGroupId = 0;
    });
  });

  test.describe.serial("Users", () => {
    test("Creating user adds User entity", async () => {
      const userName = `${testPrefix}-test-user`;
      const userEmail = `${userName}@example.com`;

      testUserId = await GitLabApiHelper.createUser(
        userName,
        userName,
        userEmail,
      );

      await expect
        .poll(
          async () =>
            await CatalogApiHelper.entityExists(
              rhdhUrl,
              catalogToken,
              "User",
              userName,
            ),
          {
            message: `User ${userName} should appear in catalog`,
            timeout: 60_000,
            intervals: [2_000],
          },
        )
        .toBe(true);

      const entity = await CatalogApiHelper.getEntity(
        rhdhUrl,
        catalogToken,
        "User",
        userName,
      );
      expect(entity.metadata.name).toBe(userName);
    });

    test("Deleting user removes User entity", async () => {
      test.setTimeout(7 * 60 * 1000);

      const userName = `${testPrefix}-test-user`;

      await GitLabApiHelper.deleteUser(testUserId, true);

      await expect
        .poll(
          async () =>
            !(await CatalogApiHelper.entityExists(
              rhdhUrl,
              catalogToken,
              "User",
              userName,
            )),
          {
            message: `User ${userName} should be removed from catalog`,
            timeout: 180_000,
            intervals: [2_000],
          },
        )
        .toBe(true);

      testUserId = 0;
    });
  });

  test.describe.serial("Membership", () => {
    let membershipGroupId: number;
    let membershipUserId: number;
    let membershipGroupName: string;
    let membershipUserName: string;

    test.beforeAll(async () => {
      membershipGroupName = `${testPrefix}-membership-group`;
      membershipUserName = `${testPrefix}-membership-user`;
      const userEmail = `${membershipUserName}@example.com`;

      membershipGroupId = await GitLabApiHelper.createGroup(
        parentGroupId,
        membershipGroupName,
      );
      membershipUserId = await GitLabApiHelper.createUser(
        membershipUserName,
        membershipUserName,
        userEmail,
      );

      await expect
        .poll(
          async () =>
            await CatalogApiHelper.entityExists(
              rhdhUrl,
              catalogToken,
              "Group",
              membershipGroupName,
            ),
          {
            message: `Group ${membershipGroupName} should appear in catalog`,
            timeout: 60_000,
            intervals: [2_000],
          },
        )
        .toBe(true);

      await expect
        .poll(
          async () =>
            await CatalogApiHelper.entityExists(
              rhdhUrl,
              catalogToken,
              "User",
              membershipUserName,
            ),
          {
            message: `User ${membershipUserName} should appear in catalog`,
            timeout: 60_000,
            intervals: [2_000],
          },
        )
        .toBe(true);
    });

    test.afterAll(async () => {
      if (membershipUserId) {
        await GitLabApiHelper.deleteUser(membershipUserId, true);
        membershipUserId = 0;
      }

      if (membershipGroupId) {
        await GitLabApiHelper.deleteGroup(membershipGroupId, true);
        membershipGroupId = 0;
      }
    });

    test("Adding user to group updates membership", async () => {
      await GitLabApiHelper.addUserToGroup(membershipGroupId, membershipUserId);

      await expect
        .poll(
          async () => {
            const groupMembers = await CatalogApiHelper.getGroupMembers(
              rhdhUrl,
              catalogToken,
              membershipGroupName,
            );
            return groupMembers.includes(membershipUserName);
          },
          {
            message: `User ${membershipUserName} should appear in group ${membershipGroupName} members`,
            timeout: 60_000,
            intervals: [2_000],
          },
        )
        .toBe(true);

      await GitLabApiHelper.removeUserFromGroup(
        membershipGroupId,
        membershipUserId,
      );
    });

    test("Removing user from group updates membership", async () => {
      await GitLabApiHelper.addUserToGroup(membershipGroupId, membershipUserId);

      await expect
        .poll(
          async () => {
            const groupMembers = await CatalogApiHelper.getGroupMembers(
              rhdhUrl,
              catalogToken,
              membershipGroupName,
            );
            return groupMembers.includes(membershipUserName);
          },
          {
            message: `User ${membershipUserName} should appear in group ${membershipGroupName} members`,
            timeout: 60_000,
            intervals: [2_000],
          },
        )
        .toBe(true);

      await GitLabApiHelper.removeUserFromGroup(
        membershipGroupId,
        membershipUserId,
      );

      await expect
        .poll(
          async () => {
            const groupMembers = await CatalogApiHelper.getGroupMembers(
              rhdhUrl,
              catalogToken,
              membershipGroupName,
            );
            return !groupMembers.includes(membershipUserName);
          },
          {
            message: `User ${membershipUserName} should be removed from group ${membershipGroupName}`,
            timeout: 60_000,
            intervals: [2_000],
          },
        )
        .toBe(true);
    });
  });
});
