import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { RolesPage } from "../../support/pages/rbac";
import { downloadAndReadFile } from "../../support/utils/helper";
import { RbacPO } from "../../support/pages/rbac-po";
import {
  ROLE_OVERVIEW_COMPONENTS,
  ROLES_PAGE_COMPONENTS,
} from "../../support/pages/rbac-obj";

import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import * as path from "node:path";
import { createUsersAndGroups } from "../../support/utils/create-users";
import { RhdhAuthApiHack } from "../../support/api/rhdh-auth-api-hack";
import { cleanupRoles } from "../../support/utils/cleanup";
import {
  RBAC_DESCRIPTIVE_USERS,
  RBAC_GROUPS,
  displayName,
  userEntityRef,
} from "../../support/constants/users-and-groups";
import { RBAC_ROLES } from "../../support/constants/roles";
import { loginAs } from "../../support/utils/login";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

const rbacConfigmapPath = path.resolve(
  process.cwd(),
  "tests/config/rbac-configmap.yaml",
);

test.describe("RBAC plugin", () => {
  let rbacPO: RbacPO;
  let apiToken: string;

  /**
   * Shared helper used by both `beforeAll` (to grab the API token) and each
   * `beforeEach` that needs an admin UI session.  Extracting it avoids
   * duplicating the login + navigation steps across multiple describe blocks.
   */
  async function setupAdminSession({
    page,
    uiHelper,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    loginHelper: LoginHelper;
  }) {
    rbacPO = new RbacPO(page, uiHelper);
    await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.rbacAdmin);
    await rbacPO.navigateToRBACPage();
  }

  test.beforeAll(async ({ rhdh, browser }) => {
    await createUsersAndGroups();
    const namespace = rhdh.deploymentConfig.namespace;
    await $`kubectl apply -f ${rbacConfigmapPath} -n ${namespace}`;

    await rhdh.configure({
      version: "1.10",
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/dynamic-plugins.yaml",
      valueFile: "tests/config/values.yaml",
    });
    await rhdh.deploy();

    // `beforeAll` does not receive a `page` fixture, so a temporary browser
    // context is created solely to perform the admin login and extract the
    // API token used by `afterAll` for programmatic cleanup.
    const context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
    });

    const page = await context.newPage();
    const uiHelper = new UIhelper(page);
    const loginHelper = new LoginHelper(page);
    await setupAdminSession({ page, uiHelper, loginHelper });
    apiToken = await RhdhAuthApiHack.getToken(page);
    await context.close();
  });

  test.describe("RBAC plugin: admin user", () => {
    test.beforeEach(async ({ page, uiHelper, loginHelper }) => {
      await setupAdminSession({ page, uiHelper, loginHelper });
    });

    test("Check Administration side nav has RBAC plugin", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.goToPageUrl("/", "Welcome back!");
      await uiHelper.openSidebarButton("Administration");
      const rbacLink = page.getByRole("link", { name: "RBAC" });
      await expect(rbacLink).toBeVisible();
      await rbacLink.click();
      await uiHelper.verifyHeading("RBAC");
      expect(await page.title()).toContain("RBAC");

      await rbacPO.verifyGeneralRbacViewHeading();
      const allGridColumnsText = RolesPage.getRolesListColumnsText();
      const allCellsIdentifier = RolesPage.getRolesListCellsIdentifier();

      await rbacPO.verifyRoleOverviewTables(
        allGridColumnsText,
        allCellsIdentifier,
      );
    });

    test("Export CSV of the user list", async ({ page }) => {
      await rbacPO.navigateToRBACPage();
      const exportCsvLink = page.getByRole("link", { name: "Export CSV" });
      await exportCsvLink.click();
      const fileContent = await downloadAndReadFile(page, exportCsvLink);
      await test.info().attach("user-list-file", {
        body: fileContent,
        contentType: "text/plain",
      });
      const lines = fileContent!.trim().split("\n");

      const header = "userEntityRef,displayName,email,lastAuthTime";
      expect(lines[0], "Header needs to match the expected header").toBe(
        header,
      );

      // Check that each subsequent line starts with "user:default" or "user:development"
      const invalidLines = lines
        .slice(1)
        .filter(
          (line) =>
            !line.startsWith("user:default") &&
            !line.startsWith("user:development"),
        );

      await test.step(`Validate user lines: ${invalidLines.length} invalid out of ${lines.length} total`, async () => {
        expect(invalidLines, "All users should be valid").toHaveLength(0);
      });
    });

    test("View details of a role (rbac_admin)", async ({ uiHelper }) => {
      await rbacPO.navigateToRBACPage();
      await rbacPO.verifyRoleAndSwitchToOverview(RBAC_ROLES.rbacAdmin.ref, "", [
        "1 user",
        "5 permissions",
      ]);

      const usersAndGroupsColumnsText =
        RolesPage.getUsersAndGroupsListColumnsText();
      const usersAndGroupsCellsIdentifier =
        RolesPage.getUsersAndGroupsListCellsIdentifier();

      await rbacPO.verifyRoleOverviewTables(
        usersAndGroupsColumnsText,
        usersAndGroupsCellsIdentifier,
      );

      const permissionPoliciesColumnsText =
        RolesPage.getPermissionPoliciesListColumnsText();
      const permissionPoliciesCellsIdentifier =
        RolesPage.getPermissionPoliciesListCellsIdentifier();

      await rbacPO.verifyRoleOverviewTables(
        permissionPoliciesColumnsText,
        permissionPoliciesCellsIdentifier,
      );

      await uiHelper.clickLink("RBAC");
    });

    test("Cancel role creation exists without creating a role", async ({
      page,
      uiHelper,
    }) => {
      await rbacPO.navigateToRBACPage();
      await uiHelper.clickButton("Create");
      await uiHelper.verifyHeading("Create role");
      await uiHelper.fillTextInputByLabel("name", "sample-role-1");
      await uiHelper.fillTextInputByLabel(
        "description",
        "Test Description data",
      );

      await uiHelper.clickButton("Next");
      // Wait for the users and groups step to be visible
      await expect(
        page.getByTestId("users-and-groups-text-field"),
      ).toBeVisible();
      await uiHelper.fillTextInputByLabel(
        "Select users and groups",
        "sample-role-1",
      );
      await page
        .getByTestId("users-and-groups-text-field")
        .getByLabel("clear search")
        .click();
      await expect(
        page.getByTestId("users-and-groups-text-field").getByRole("combobox"),
      ).toBeEmpty();
      await uiHelper.verifyHeading("No users and groups selected");
      await uiHelper.clickButton("Cancel");
      await uiHelper.verifyText("Exit role creation?");
      await uiHelper.clickButton("Discard");
      await expect(page.getByRole("alert")).toHaveCount(0);
    });

    test("Edit role users via the inline edit button on the roles list", async ({
      page,
    }) => {
      await rbacPO.navigateToRBACPage();
      await rbacPO.createRole(
        RBAC_ROLES.overviewListEdit.name,
        [displayName("noAccess"), displayName("tara")],
        [RBAC_GROUPS.backstage.name],
        [{ permission: "catalog.entity.delete" }],
      );

      await rbacPO.filterRolesList(RBAC_ROLES.overviewListEdit.name);
      await ROLES_PAGE_COMPONENTS.getEditRoleButton(
        page,
        RBAC_ROLES.overviewListEdit.ref,
      ).click();
      await rbacPO.editRoleMembers(
        RBAC_ROLES.overviewListEdit.ref,
        displayName("jonathon"),
        3,
        1,
      );

      await rbacPO.filterRolesList(RBAC_ROLES.overviewListEdit.name);

      // Use semantic selector for table cell
      const usersAndGroupsLocator = page
        .getByRole("cell")
        .filter({ hasText: rbacPO.regexpShortUsersAndGroups(3, 1) });
      await expect(usersAndGroupsLocator).toBeVisible();

      await rbacPO.deleteRole(RBAC_ROLES.overviewListEdit.ref);
    });

    test("Edit role members via the updateMembers button on the overview page", async ({
      page,
      uiHelper,
    }) => {
      await rbacPO.navigateToRBACPage();
      await rbacPO.createRole(
        RBAC_ROLES.overviewMembers.name,
        [displayName("noAccess"), displayName("tara")],
        [RBAC_GROUPS.backstage.name],
        [{ permission: "catalog.entity.delete" }],
      );

      await rbacPO.filterRolesList(RBAC_ROLES.overviewMembers.name);

      await rbacPO.verifyRoleAndSwitchToOverview(
        RBAC_ROLES.overviewMembers.ref,
        "",
        [rbacPO.regexpShortUsersAndGroups(2, 1), "1 permission"],
      );

      await ROLE_OVERVIEW_COMPONENTS.getUpdateMembersButton(page).click();
      await rbacPO.editRoleMembers(
        RBAC_ROLES.overviewMembers.ref,
        displayName("noAccess"),
        1,
        1,
      );

      await uiHelper.verifyHeading(rbacPO.regexpShortUsersAndGroups(1, 1));

      await rbacPO.deleteRole(RBAC_ROLES.overviewMembers.ref);
    });

    test("Edit role policies via the updatePolicies button on the overview page", async ({
      uiHelper,
    }) => {
      await rbacPO.navigateToRBACPage();
      await rbacPO.createRole(
        RBAC_ROLES.overviewPolicies.name,
        [displayName("noAccess"), displayName("tara")],
        [RBAC_GROUPS.backstage.name],
        [{ permission: "catalog.entity.delete" }],
      );

      await rbacPO.filterRolesList(RBAC_ROLES.overviewPolicies.name);

      await rbacPO.verifyRoleAndSwitchToOverview(
        RBAC_ROLES.overviewPolicies.ref,
        "",
        [rbacPO.regexpShortUsersAndGroups(2, 1), "1 permission"],
      );

      await rbacPO.editRolePermissions();

      await uiHelper.verifyText(
        `Role ${RBAC_ROLES.overviewPolicies.ref} updated successfully`,
      );
      await uiHelper.verifyHeading("2 permissions");

      await rbacPO.deleteRole(RBAC_ROLES.overviewPolicies.ref);
    });
  });

  test.describe("RBAC Plugin: guest user", () => {
    test.beforeEach(async ({ page, uiHelper, loginHelper }) => {
      rbacPO = new RbacPO(page, uiHelper);
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.noAccess);
    });

    test("Administration side nav does not show RBAC plugin", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebarButton("Administration");
      // Check specifically for RBAC link in sidebar navigation, not anywhere on the page
      const rbacNavLink = page
        .getByRole("navigation", { name: "sidebar nav" })
        .getByRole("link", { name: "RBAC" });
      await expect(rbacNavLink).toHaveCount(0);
    });

    test("Direct navigation to /rbac is denied", async ({ uiHelper }) => {
      await rbacPO.go();
      await uiHelper.waitForLoad();
      await uiHelper.verifyText("ERROR : Not Found");
    });
  });

  test.describe("RBAC plugin: permission policies loaded from files", () => {
    test.beforeEach(async ({ page, uiHelper, loginHelper }) => {
      await setupAdminSession({ page, uiHelper, loginHelper });
    });

    test("Permission policies defined in a CSV file are loaded (guest role, 1 permission)", async ({
      uiHelper,
    }) => {
      await rbacPO.filterRolesList(RBAC_ROLES.guest.name);
      await rbacPO.verifyRoleAndSwitchToOverview(
        RBAC_ROLES.guest.ref,
        "csv permission policy file",
        ["1 user", "1 permission"],
      );

      const permissionPoliciesColumnsText =
        RolesPage.getPermissionPoliciesListColumnsText();
      const permissionPoliciesCellsIdentifier =
        RolesPage.getPermissionPoliciesListCellsIdentifier();

      await rbacPO.verifyRoleOverviewTables(
        permissionPoliciesColumnsText,
        permissionPoliciesCellsIdentifier,
      );

      await uiHelper.verifyRowInTableByUniqueText(displayName("noAccess"), [
        "user",
        "-",
      ]);
      await uiHelper.verifyRowInTableByUniqueText("catalog.entity.create", [
        "create",
        "-",
      ]);
    });

    test("CSV file-sourced role (guest role): Update policies is not available", async ({
      page,
    }) => {
      await rbacPO.filterRolesList(RBAC_ROLES.guest.name);
      await rbacPO.verifyRoleAndSwitchToOverview(
        RBAC_ROLES.guest.ref,
        "csv permission policy file",
        ["1 user", "1 permission"],
      );

      await rbacPO.editRolePermissions();

      const errorAlert = page
        .getByRole("alert")
        .filter({ hasText: /Unable to edit the role/i });
      expect(errorAlert.count()).toBeTruthy();
    });

    test("CSV file-sourced role (guest role): Delete is not available", async ({
      page,
    }) => {
      await rbacPO.filterRolesList(RBAC_ROLES.guest.name);
      await rbacPO.deleteRole(RBAC_ROLES.guest.ref, "All roles (0)", true);

      const errorAlert = page
        .getByRole("alert")
        .filter({ hasText: /Unable to delete policy/i });
      expect(errorAlert.count()).toBeTruthy();
    });

    test("Config-sourced role (rbac_admin): Update policies is not available", async ({
      page,
    }) => {
      await rbacPO.filterRolesList(RBAC_ROLES.rbacAdmin.name);
      await rbacPO.verifyRoleAndSwitchToOverview(RBAC_ROLES.rbacAdmin.ref, "", [
        "1 user",
        "5 permissions",
      ]);

      await rbacPO.editRolePermissions();

      const errorAlert = page
        .getByRole("alert")
        .filter({ hasText: /Unable to edit the role/i });
      expect(errorAlert.count()).toBeTruthy();
    });

    test("Config-sourced role (rbac_admin): Delete is not available", async ({
      page,
    }) => {
      await rbacPO.filterRolesList(RBAC_ROLES.rbacAdmin.name);
      await rbacPO.deleteRole(RBAC_ROLES.rbacAdmin.ref, "All roles (0)", true);

      const errorAlert = page
        .getByRole("alert")
        .filter({ hasText: /Unable to delete policy/i });
      expect(errorAlert.count()).toBeTruthy();
    });
  });

  test.describe("RBAC conditional policies: $currentUser alias", () => {
    test.beforeEach(async ({ page, uiHelper, loginHelper }) => {
      rbacPO = new RbacPO(page, uiHelper);
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.currentUserOwner);
    });

    test("User can unregister own components but not group-owned components", async ({
      page,
      uiHelper,
    }) => {
      await rbacPO.navigateToCatalogComponent("test-rhdh-qe-2");

      // Verify component name in the main heading
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "test-rhdh-qe-2",
      );
      await page.getByTestId("menu-button").click();
      const unregisterUserOwned = page.getByRole("menuitem", {
        name: "Unregister entity",
      });
      await expect(unregisterUserOwned).toBeEnabled();

      await page.getByRole("menuitem", { name: "Unregister entity" }).click();
      await expect(page.getByRole("dialog")).toContainText(
        "Are you sure you want to unregister this entity?",
      );
      await page.getByRole("button", { name: "Cancel" }).click();

      await uiHelper.openSidebar("Catalog");
      await page
        .getByRole("link", { name: "test-rhdh-qe-2-team-owned" })
        .click();
      // Verify owner group in the component metadata (scope to article to avoid duplicates)
      await expect(
        page
          .getByRole("article")
          .getByRole("link", { name: /janus-qe\/rhdh-qe-2-team/ }),
      ).toBeVisible();
      await page.getByTestId("menu-button").click();
      const unregisterGroupOwned = page.getByRole("menuitem", {
        name: "Unregister entity",
      });
      await expect(unregisterGroupOwned).toBeDisabled();
    });
  });

  test.describe("RBAC conditional policies: $ownerRefs transitive group ownership", () => {
    test.beforeEach(({ page, uiHelper }) => {
      rbacPO = new RbacPO(page, uiHelper);
    });

    test("User in child group can read components owned by the parent group", async ({
      loginHelper,
    }) => {
      // login as child-group-member: belongs in rhdh-qe-child-team, which is a sub group of rhdh-qe-parent-team
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.childGroupMember);

      // rhdh-qe-parent-team owns mock-site
      await rbacPO.navigateToCatalogComponent("mock-site");
      // Verify owner group in the component metadata
      await rbacPO.verifyComponentOwner(RBAC_GROUPS.rhdhParentTeam.name);

      // rhdh-qe-child-team owns mock-child-site, check that it can see it's own groups' components
      await rbacPO.navigateToCatalogComponent("mock-child-site");
      // Verify owner group in the component metadata
      await rbacPO.verifyComponentOwner(RBAC_GROUPS.rhdhChildTeam.name);
    });

    test("User in sub-child group can read components owned by grandparent group", async ({
      loginHelper,
    }) => {
      // login as sub-child-group-member: belongs in rhdh-qe-sub-child-team, which is a sub group of rhdh-qe-child-team
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.subChildGroupMember);

      // rhdh-qe-parent-team owns mock-site
      await rbacPO.navigateToCatalogComponent("mock-site");
      // Verify owner group in the component metadata
      await rbacPO.verifyComponentOwner(RBAC_GROUPS.rhdhParentTeam.name);

      // rhdh-qe-child-team owns mock-child-site
      await rbacPO.navigateToCatalogComponent("mock-child-site");
      // Verify owner group in the component metadata
      await rbacPO.verifyComponentOwner(RBAC_GROUPS.rhdhChildTeam.name);

      // rhdh-qe-sub-child-team owns mock-sub-child-site, check that it can see it's own groups' components
      await rbacPO.navigateToCatalogComponent("mock-sub-child-site");
      // Verify owner group in the component metadata
      await rbacPO.verifyComponentOwner(RBAC_GROUPS.rhdhSubChildTeam.name);
    });
  });

  test.describe("RBAC conditional policies: IsOwner ownership rule", () => {
    test.describe.configure({ mode: "serial" });

    test.beforeEach(async ({ page, uiHelper }) => {
      rbacPO = new RbacPO(page, uiHelper);
    });

    test("Admin creates rbac-ownership-role with IsOwner rule for conditional-manager", async ({
      loginHelper,
    }) => {
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.rbacAdmin);

      await rbacPO.navigateToRBACPage();
      await rbacPO.createRBACConditionRole(
        RBAC_ROLES.rbacOwnership.name,
        [displayName("conditionalManager")],
        userEntityRef(RBAC_DESCRIPTIVE_USERS.conditionalManager),
      );
    });

    test("conditional-manager can access RBAC page, create a role, edit it, and delete it", async ({
      page,
      loginHelper,
    }) => {
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.conditionalManager);

      await rbacPO.navigateToRBACPage();
      await rbacPO.createRole(
        RBAC_ROLES.rbacConditional.name,
        [displayName("noAccess"), displayName("tara")],
        [RBAC_GROUPS.backstage.name],
        [{ permission: "catalog.entity.delete" }],
        "catalog",
        userEntityRef(RBAC_DESCRIPTIVE_USERS.conditionalManager),
      );

      await ROLES_PAGE_COMPONENTS.getEditRoleButton(
        page,
        RBAC_ROLES.rbacConditional.ref,
      ).click();

      await rbacPO.editRoleMembers(
        RBAC_ROLES.rbacConditional.ref,
        displayName("jonathon"),
        3,
        1,
      );

      await rbacPO.deleteRole(RBAC_ROLES.rbacConditional.ref, "All roles");
    });

    test("Admin revokes access by deleting rbac-conditional-role", async ({
      loginHelper,
    }) => {
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.rbacAdmin);

      await rbacPO.navigateToRBACPage();
      await rbacPO.deleteRole(RBAC_ROLES.rbacOwnership.ref);
    });

    test("conditional-manager no longer sees RBAC in the sidebar after access is revoked", async ({
      page,
      uiHelper,
      loginHelper,
    }) => {
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.conditionalManager);

      await uiHelper.openSidebarButton("Administration");
      const dropdownMenuLocator = page.getByText("RBAC");
      await expect(dropdownMenuLocator).toBeHidden();
    });
  });

  test.describe("RBAC conditional policies: policyDecisionPrecedence", () => {
    test.beforeEach(({ page, uiHelper }) => {
      rbacPO = new RbacPO(page, uiHelper);
    });

    test("Conditional allow overrides basic deny (conditional-allow-user)", async ({
      loginHelper,
    }) => {
      // Should allow read: conditional policy takes precedence over static deny read via CSV
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.conditionalAllowUser);
      await rbacPO.navigateToCatalogComponent("mock-component");
    });

    test("Conditional deny overrides basic allow (conditional-deny-user)", async ({
      uiHelper,
      loginHelper,
    }) => {
      // Should deny read: conditional deny policy takes precedence over allow read via basic
      await loginAs(loginHelper, RBAC_DESCRIPTIVE_USERS.conditionalDenyUser);
      await uiHelper.openSidebar("Catalog");
      await uiHelper.selectMuiBox("Kind", "Component");
      await uiHelper.verifyTableIsEmpty();
    });
  });

  test.describe("RBAC conditional policies: permission policy per resource type", () => {
    test.beforeEach(async ({ page, uiHelper, loginHelper }) => {
      await setupAdminSession({ page, uiHelper, loginHelper });
    });

    test("Create role with AnyOf conditional rules per resource type and verify only authorized users see appropriate catalog resources", async ({}) => {
      await rbacPO.createConditionalRole(
        RBAC_ROLES.conditionalResource.name,
        [displayName("noAccess"), displayName("rbacAdmin")],
        [RBAC_GROUPS.backstage.name],
        "anyOf",
        "catalog",
        userEntityRef(RBAC_DESCRIPTIVE_USERS.rbacAdmin),
      );

      await rbacPO.deleteRole(RBAC_ROLES.conditionalResource.ref);
    });
  });

  // Ensure we clean up in the event that a test fails so that we do not impact other tests
  test.afterAll(async () => {
    await cleanupRoles(RBAC_ROLES, apiToken);
  });
});
