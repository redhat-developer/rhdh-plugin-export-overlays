import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import type { Page } from "@playwright/test";

import { CatalogApiHelper } from "./api/catalog-api-helper.js";
import { GitLabApiHelper } from "./api/gitlab-api-helper.js";

const CATALOG_MEMBERSHIP_POLL_MS = 60_000;
const CATALOG_MEMBERSHIP_INTERVAL_MS = 2_000;
const CATALOG_ENTITY_WAIT_MS = 60_000;
const CATALOG_ENTITY_INTERVAL_MS = 2_000;

const GITLAB_EVENTS_RHDH_CONFIG = {
  auth: "keycloak" as const,
  appConfig: "tests/config/gitlab-events/app-config-rhdh.yaml",
  secrets: "tests/config/gitlab-events/rhdh-secrets.yaml",
  dynamicPlugins: "tests/config/gitlab-events/dynamic-plugins.yaml",
};

/** Worker fixture shape used by GitLab events E2E suites */
export type GitLabEventsRhdhWorker = {
  configure: (options: typeof GITLAB_EVENTS_RHDH_CONFIG) => Promise<void>;
  deploy: () => Promise<void>;
  rhdhUrl: string;
};

export function requireGitLabEventsVaultEnv(): void {
  requireEnv("VAULT_EVENTS_GITLAB_TOKEN");
  requireEnv("VAULT_EVENTS_GITLAB_HOST");
  requireEnv("VAULT_EVENTS_GITLAB_PARENT_ORG");
  requireEnv("VAULT_GITLAB_WEBHOOK_SECRET");
}

/**
 * Validates vault/GitLab env, initializes {@link GitLabApiHelper}, and returns a
 * unique resource prefix for this run.
 */
export function bootstrapGitLabEventsApiClient(): string {
  requireGitLabEventsVaultEnv();
  const host = process.env.VAULT_EVENTS_GITLAB_HOST;
  const token = process.env.VAULT_EVENTS_GITLAB_TOKEN;
  if (typeof host !== "string" || host.length === 0) {
    throw new TypeError("VAULT_EVENTS_GITLAB_HOST must be set");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("VAULT_EVENTS_GITLAB_TOKEN must be set");
  }
  GitLabApiHelper.init(`https://${host}`, token);
  return GitLabApiHelper.generateTestPrefix();
}

export async function deployGitLabEventsHub(
  rhdh: GitLabEventsRhdhWorker,
): Promise<string> {
  await rhdh.configure(GITLAB_EVENTS_RHDH_CONFIG);
  await rhdh.deploy();
  return rhdh.rhdhUrl;
}

export async function prepareGitLabEventsParentGroup(): Promise<{
  parentGroupId: number;
  parentGroupPath: string;
}> {
  const parentGroup = await GitLabApiHelper.getGroupByPath(
    process.env.VAULT_EVENTS_GITLAB_PARENT_ORG,
  );
  await GitLabApiHelper.cleanupStaleResources(parentGroup.id, "e2e-", 1);
  return {
    parentGroupId: parentGroup.id,
    parentGroupPath: parentGroup.full_path,
  };
}

type UiLoadHelper = { waitForLoad: () => Promise<void> };

/**
 * After Keycloak login: opens RHDH and polls until {@link AuthApiHelper#getToken}
 * returns a non-empty catalog session token. Callers should guard with `if (!token)`.
 */
export async function fetchCatalogSessionToken(
  page: Page,
  uiHelper: UiLoadHelper,
  rhdhUrl: string,
): Promise<string> {
  const authApiHelper = new AuthApiHelper(page);
  await page.goto(rhdhUrl);
  await uiHelper.waitForLoad();
  await page.locator("nav").first().waitFor({ state: "visible" });
  await page
    .locator('button[data-testid="user-settings-menu"], [aria-label*="user"]')
    .first()
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});

  let token: string | undefined;
  await expect
    .poll(
      async () => {
        try {
          const next = await authApiHelper.getToken();
          if (next && next.length > 0) {
            token = next;
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

  if (!token) {
    throw new TypeError("Catalog session token was not captured after polling");
  }
  return token;
}

export async function runGitLabEventsCleanupSafely(
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    console.warn(
      `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Creates a GitLab group and user, then waits until both appear in the RHDH catalog.
 */
export async function createGitLabGroupAndUserVisibleInCatalog(options: {
  parentGroupId: number;
  rhdhUrl: string;
  catalogToken: string;
  groupName: string;
  userName: string;
}): Promise<{ groupId: number; userId: number }> {
  const { parentGroupId, rhdhUrl, catalogToken, groupName, userName } = options;
  const userEmail = `${userName}@example.com`;
  const groupId = await GitLabApiHelper.createGroup(parentGroupId, groupName);
  const userId = await GitLabApiHelper.createUser(
    userName,
    userName,
    userEmail,
  );
  await CatalogApiHelper.waitForEntity(
    rhdhUrl,
    catalogToken,
    "Group",
    groupName,
    "default",
    CATALOG_ENTITY_WAIT_MS,
    CATALOG_ENTITY_INTERVAL_MS,
  );
  await CatalogApiHelper.waitForEntity(
    rhdhUrl,
    catalogToken,
    "User",
    userName,
    "default",
    CATALOG_ENTITY_WAIT_MS,
    CATALOG_ENTITY_INTERVAL_MS,
  );
  return { groupId, userId };
}

/**
 * Adds the GitLab user to the group and polls the catalog until the membership edge exists.
 */
export async function addGitLabUserToGroupAndWaitForCatalogMember(options: {
  rhdhUrl: string;
  catalogToken: string;
  groupName: string;
  userName: string;
  groupId: number;
  userId: number;
}): Promise<void> {
  const { rhdhUrl, catalogToken, groupName, userName, groupId, userId } =
    options;
  await GitLabApiHelper.addUserToGroup(groupId, userId);
  await expect(async () => {
    const groupMembers = await CatalogApiHelper.getGroupMembers(
      rhdhUrl,
      catalogToken,
      groupName,
    );
    expect(groupMembers).toContain(userName);
  }).toPass({
    timeout: CATALOG_MEMBERSHIP_POLL_MS,
    intervals: [CATALOG_MEMBERSHIP_INTERVAL_MS],
  });
}

/**
 * Polls the catalog until the user no longer appears in the group's member list.
 */
export async function waitForCatalogGroupMemberAbsent(options: {
  rhdhUrl: string;
  catalogToken: string;
  groupName: string;
  userName: string;
}): Promise<void> {
  const { rhdhUrl, catalogToken, groupName, userName } = options;
  await expect(async () => {
    const groupMembers = await CatalogApiHelper.getGroupMembers(
      rhdhUrl,
      catalogToken,
      groupName,
    );
    expect(groupMembers).not.toContain(userName);
  }).toPass({
    timeout: CATALOG_MEMBERSHIP_POLL_MS,
    intervals: [CATALOG_MEMBERSHIP_INTERVAL_MS],
  });
}

/** Hard-deletes a GitLab user and group (e.g. after membership tests). */
export async function permanentlyDeleteGitLabUserAndGroup(
  userId: number,
  groupId: number,
): Promise<void> {
  await GitLabApiHelper.deleteUser(userId, true);
  await GitLabApiHelper.deleteGroup(groupId, true);
}
