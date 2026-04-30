import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { RbacPO } from "../../support/pages/rbac-po";

import { createUsersAndGroups } from "../../support/utils/create-users";
import { cleanupRoles } from "../../support/utils/cleanup";
import { RBAC_DESCRIPTIVE_USERS } from "../../support/constants/users-and-groups";
import { RBAC_ROLES } from "../../support/constants/roles";
import { loginAs } from "../../support/utils/login";
import {
  AuthApiHelper,
  LoginHelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

test.describe("Check default RBAC permissions", () => {
  let rbacPO: RbacPO;
  let apiToken: string;

  test.beforeAll(async ({ rhdh, browser }) => {
    await createUsersAndGroups();

    await rhdh.configure({
      auth: "keycloak",
      appConfig:
        "tests/config/app-config-rhdh-default-permissions-overlay.yaml",
      valueFile: "tests/config/values.yaml",
      dynamicPlugins: "tests/config/dynamic-plugins.yaml",
    });
    await rhdh.deploy();
    await rhdh.waitUntilReady();

    // `beforeAll` does not receive a `page` fixture, so a temporary browser
    // context is created solely to perform the admin login and extract the
    // API token used by `afterAll` for programmatic cleanup.
    const context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
    });

    const page = await context.newPage();
    const loginHelper = new LoginHelper(page);
    // todo move to afterAll?
    await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.rbacAdmin);
    const authApiHelper = new AuthApiHelper(page);
    apiToken = await authApiHelper.getToken();
    await context.close();
  });

  test("User should got default permissions", async ({
    page,
    uiHelper,
    loginHelper,
  }) => {
    await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.noAccess);

    rbacPO = new RbacPO(page, uiHelper);
    await uiHelper.openSidebar("Catalog");
    await uiHelper.waitForLoad();
    await rbacPO.navigateToCatalogComponent("test-rhdh-qe-2");
  });

  test("Default role should appear in the RBAC page", async ({
    page,
    uiHelper,
    loginHelper,
  }) => {
    await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.rbacAdmin);

    rbacPO = new RbacPO(page, uiHelper);

    await rbacPO.navigateToRBACPage();
    await uiHelper.waitForLoad();
    await rbacPO.filterRolesList(RBAC_ROLES.defaultRole.name);
    await rbacPO.verifyRoleAndSwitchToOverview(
      RBAC_ROLES.defaultRole.ref,
      "Role with default permissions for all users and groups.",
      ["1 permission"],
    );
  });

  // Ensure we clean up in the event that a test fails so that we do not impact other tests
  test.afterAll(async () => {
    await cleanupRoles(RBAC_ROLES, apiToken);
  });
});
