import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import type {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { Page } from "@playwright/test";
import { CatalogUsersPO } from "../support/page-objects/catalog-users-obj";
import { KeycloakAPI, type KeycloakUser } from "../support/keycloak-api";

test.describe("Test Keycloak plugin", () => {
  let keycloakAPI: KeycloakAPI;
  let token: string;

  test.beforeAll(async ({ rhdh }: { rhdh: RHDHDeployment }) => {
    test.info().annotations.push({
      type: "component",
      description: "plugins",
    });

    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh.yaml",
    });
    await rhdh.deploy();

    keycloakAPI = new KeycloakAPI();
    token = await keycloakAPI.getAuthenticationToken();
  });

  test.beforeEach(
    async ({ page, loginHelper }: { page: Page; loginHelper: LoginHelper }) => {
      await loginHelper.loginAsGuest();
      await CatalogUsersPO.visitBaseURL(page);
    },
  );

  test("Users on keycloak should match users on backstage", async ({
    page,
    uiHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
  }) => {
    const keycloakUsers = await keycloakAPI.getUsers(token);
    const backStageUsersLocator = CatalogUsersPO.getListOfUsers(page);
    await uiHelper.waitForLoad();
    await backStageUsersLocator.first().waitFor({ state: "visible" });
    const backStageUsersCount = await backStageUsersLocator.count();

    expect(keycloakUsers.length).toBeGreaterThan(0);
    expect(backStageUsersCount).toBeGreaterThan(0);

    for (let i = 0; i < backStageUsersCount; i++) {
      const backStageUser = backStageUsersLocator.nth(i);
      const backStageUserText = await backStageUser.textContent();
      const userFound = keycloakUsers.find(
        (user) => user.username === backStageUserText,
      );
      expect(userFound).not.toBeNull();

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (userFound) {
        await checkUserDetails(page, userFound, token, uiHelper, keycloakAPI);
      }
    }
  });
});

async function checkUserDetails(
  page: Page,
  keycloakUser: KeycloakUser,
  authToken: string,
  uiHelper: UIhelper,
  keycloakAPI: KeycloakAPI,
) {
  await CatalogUsersPO.visitUserPage(page, keycloakUser.username);
  const emailLink = CatalogUsersPO.getEmailLink(page);
  await expect(emailLink).toBeVisible();
  await uiHelper.verifyText(
    `${keycloakUser.firstName} ${keycloakUser.lastName}`,
  );

  const groups = await keycloakAPI.getGroupsOfUser(authToken, keycloakUser.id);
  for (const group of groups) {
    const groupLink = CatalogUsersPO.getGroupLink(page, group.name);
    await expect(groupLink).toBeVisible();
  }

  await CatalogUsersPO.visitBaseURL(page);
}

// TODO: Re-add "Test Keycloak plugin metrics" block once metrics are reachable
// (e.g. route or k8s port-forward helper in e2e-test-utils). Original test:
// port-forward to RHDH metrics service 9464, GET /metrics, assert
// backend_keycloak_fetch_task_failure_count_total.
