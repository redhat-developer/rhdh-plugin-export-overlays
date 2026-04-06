import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { type RoleBasedPolicy } from "@backstage-community/plugin-rbac-common";
import {
  CONDITIONAL_RULE_COMPONENTS,
  DELETE_ROLE_COMPONENTS,
  ROLE_FORM_COMPONENTS,
  ROLE_OVERVIEW_COMPONENTS,
  ROLES_PAGE_COMPONENTS,
  SEARCH_COMPONENTS,
} from "./rbac-obj";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
type PermissionPolicyType = "anyOf" | "not";

export class RbacPO {
  private readonly page: Page;
  private readonly uiHelper: UIhelper;

  constructor(page: Page, uiHelper: UIhelper) {
    this.page = page;
    this.uiHelper = uiHelper;
  }

  public async go(): Promise<void> {
    await this.page.goto("/rbac");
    await this.uiHelper.waitForLoad();
  }

  public async navigateToRBACPage(timeout?: number) {
    await this.go();
    await this.uiHelper.waitForLoad();
    await this.uiHelper.verifyHeading("RBAC", timeout);
  }

  /**
   * Builds a regex string that matches the UI's "X users, Y groups" / "Y groups, X users"
   * summary text in either order (the backend can return them in either sequence).
   * Zero counts are omitted, e.g. 0 groups + 2 users → matches "2 users".
   * The result is wrapped in a non-capturing group so it can be composed into a
   * larger pattern by `regexpLongUsersAndGroups`.
   */
  private readonly stringForRegexUsersAndGroups = (
    numUsers: number,
    numGroups: number,
  ): string => {
    const userPluralized = numUsers === 1 ? "user" : "users";
    const usersText = numUsers === 0 ? "" : `${numUsers} ${userPluralized}`;

    const groupsPluralized = numGroups === 1 ? "group" : "groups";
    const groupsText =
      numGroups === 0 ? "" : `${numGroups} ${groupsPluralized}`;

    return `(${groupsText}${numGroups === 0 ? "" : ", "}${usersText}|${usersText}${numUsers === 0 ? "" : ", "}${groupsText})`;
  };

  public regexpShortUsersAndGroups = (
    numUsers: number,
    numGroups: number,
  ): RegExp => {
    return new RegExp(this.stringForRegexUsersAndGroups(numUsers, numGroups));
  };

  private readonly regexpLongUsersAndGroups = (
    numUsers: number,
    numGroups: number,
  ): RegExp => {
    return new RegExp(
      String.raw`Users and groups \(${this.stringForRegexUsersAndGroups(numUsers, numGroups)}\)`,
    );
  };

  public async verifyGeneralRbacViewHeading() {
    await this.uiHelper.verifyHeading(/All roles \(\d+\)/);
  }

  private async verifyRoleHeading(role: string) {
    await this.uiHelper.verifyHeading(role);
  }

  private async verifyRoleIsListed(role: string) {
    await this.uiHelper.verifyLink(role);
  }

  private async clickOnRoleLink(role: string) {
    await this.uiHelper.clickLink(role);
  }

  private async switchToOverView() {
    await this.uiHelper.clickTab("Overview");
  }

  public async verifyRoleAndSwitchToOverview(
    role: string,
    description: string,
    headings: (string | RegExp)[],
  ) {
    await this.verifyRoleIsListed(role);
    await this.clickOnRoleLink(role);
    await this.verifyRoleHeading(role);
    await this.switchToOverView();
    await this.uiHelper.verifyText("About");

    await this.uiHelper.verifyText(description);

    for (const heading of headings) {
      await this.uiHelper.verifyHeading(heading);
    }
  }

  private async verifyPermissionPoliciesHeader(policies: number) {
    await this.uiHelper.verifyText(`Permission policies (${policies})`);
  }

  private async next() {
    await this.uiHelper.clickButton("Next");
  }

  private async create() {
    await this.uiHelper.clickButton("Create");
  }

  public async openPluginsDropdown() {
    await ROLE_FORM_COMPONENTS.getSelectPluginsCombobox(this.page).click();
  }

  public async selectOption(
    option:
      | "catalog"
      | "kubernetes"
      | "catalog.entity.read"
      | "scaffolder"
      | "scaffolder-template.read"
      | "permission",
  ) {
    const optionSelector = `li[role="option"]:has-text("${option}")`;
    await this.page.waitForSelector(optionSelector);
    await this.page.click(optionSelector);
  }

  private async clickOpenSidebar() {
    await CONDITIONAL_RULE_COMPONENTS.getRulesSidebar(this.page)
      .getByLabel("Open")
      .click();
  }

  public async selectPermissionCheckbox(name: string) {
    await this.page
      .getByRole("cell", { name: name })
      .getByRole("checkbox")
      .click();
  }

  private async pluginRuleCount(number: string) {
    await expect(
      CONDITIONAL_RULE_COMPONENTS.getRuleBadge(this.page, number),
    ).toBeVisible();
  }

  private async searchAndVerifyRoleHeading(
    role: string,
    header: string = "All roles (1)",
  ) {
    const searchInput = SEARCH_COMPONENTS.getAriaLabelSearchInput(this.page);
    await searchInput.waitFor();
    await searchInput.fill(role);
    await this.uiHelper.verifyHeading(header);
  }

  public async filterRolesList(roleName: string): Promise<void> {
    await ROLES_PAGE_COMPONENTS.getFilterInput(this.page).fill(roleName);
  }

  public async verifyRoleOverviewTables(
    allGridColumnsText: RegExp[] | string[],
    allCellsIdentifier: RegExp[] | string[],
  ): Promise<void> {
    await this.uiHelper.verifyColumnHeading(allGridColumnsText);
    await this.uiHelper.verifyCellsInTable(allCellsIdentifier);
  }

  public async navigateToCatalogComponent(
    componentName: string,
  ): Promise<void> {
    await this.uiHelper.goToPageUrl("/catalog");
    await this.uiHelper.selectMuiBox("Kind", "Component");
    await this.uiHelper.searchInputPlaceholder(componentName);
    await expect(
      this.page.getByRole("link", { name: componentName, exact: true }),
    ).toBeVisible();
    await this.page
      .getByRole("link", { name: componentName, exact: true })
      .click();
  }

  public async verifyComponentOwner(ownerPattern: string): Promise<void> {
    await expect(
      this.page.getByRole("article").getByRole("link", {
        name: new RegExp(ownerPattern),
      }),
    ).toBeVisible();
  }

  private async openPermissionsDropdown(): Promise<void> {
    await ROLE_FORM_COMPONENTS.getPermissionsSelectPlaceholder(
      this.page,
    ).click();
  }

  private async createRoleUsers(
    name: string,
    users: string[],
    groups: string[],
    owner?: string,
  ) {
    if (!this.page.url().includes("rbac")) await this.go();
    await this.create();
    await this.uiHelper.verifyHeading("Create role");
    await ROLE_FORM_COMPONENTS.getRoleNameInput(this.page).fill(name);
    if (owner) {
      await ROLE_FORM_COMPONENTS.getRoleOwnerInput(this.page).fill(owner);
    }
    await this.uiHelper.clickButton("Next");
    await ROLE_FORM_COMPONENTS.getUsersAndGroupsField(this.page).click();

    for (const userOrGroup of users.concat(groups)) {
      await ROLE_FORM_COMPONENTS.getMemberOption(
        this.page,
        userOrGroup,
      ).click();
    }

    // Close dropdown after selecting users and groups
    await ROLE_FORM_COMPONENTS.getDropdownToggle(this.page).click();

    // Dynamically verify the heading based on users and groups added
    await this.uiHelper.verifyHeading(
      this.regexpShortUsersAndGroups(users.length, groups.length),
    );

    await this.next();
  }

  async createRole(
    name: string,
    users: string[],
    groups: string[],
    policies: RoleBasedPolicy[],
    pluginId: "catalog" | "kubernetes" | "scaffolder" = "catalog",
    owner?: string,
  ) {
    await this.createRoleUsers(name, users, groups, owner);

    await this.openPluginsDropdown();
    await this.selectOption(pluginId);
    await this.openPermissionsDropdown();

    for (const policy of policies) {
      if (!policy.permission) continue;
      await this.selectPermissionCheckbox(policy.permission);
    }

    await this.next();
    await this.uiHelper.verifyHeading("Review and create");
    await this.uiHelper.verifyText(
      this.regexpLongUsersAndGroups(users.length, groups.length),
    );
    await this.verifyPermissionPoliciesHeader(policies.length);
    await this.create();

    // Check for error alert first
    const errorAlert = this.page
      .getByRole("alert")
      .filter({ hasText: /error/i });
    const errorCount = await errorAlert.count();

    if (errorCount > 0) {
      const errorMessage = await errorAlert.textContent();
      throw new Error(
        `Failed to create role: ${errorMessage}. This may indicate insufficient permissions.`,
      );
    }

    // Wait for success message before proceeding to roles list
    await this.uiHelper.verifyText(
      `Role role:default/${name} created successfully`,
    );

    // Now we should be on the roles list page
    await this.searchAndVerifyRoleHeading(name);
  }

  async createConditionalRole(
    name: string,
    users: string[],
    groups: string[],
    permissionPolicyType: PermissionPolicyType,
    pluginId: "catalog" | "kubernetes" | "scaffolder" = "catalog",
    owner?: string,
  ) {
    await this.createRoleUsers(name, users, groups, owner);

    await this.openPluginsDropdown();
    await this.selectOption(pluginId);
    await this.openPermissionsDropdown();

    if (permissionPolicyType === "anyOf") {
      // Conditional Scenario 1: Permission policies using AnyOf
      await this.selectPermissionCheckbox("catalog.entity.read");
      await this.page
        .getByRole("row", { name: "catalog.entity.read" })
        .getByLabel("remove")
        .click();
      await CONDITIONAL_RULE_COMPONENTS.getAnyOfButton(this.page).click();
      await this.clickOpenSidebar();
      await CONDITIONAL_RULE_COMPONENTS.getIsEntityKindButton(
        this.page,
      ).click();
      await this.page.getByPlaceholder("string, string").click();
      await this.page
        .getByPlaceholder("string, string")
        .fill("component,template,user,group");
      await CONDITIONAL_RULE_COMPONENTS.getAddRuleButton(this.page).click();
      await this.page.getByLabel("Open").nth(2).click();
      await CONDITIONAL_RULE_COMPONENTS.getHasSpecButton(this.page).click();
      const keyInput = CONDITIONAL_RULE_COMPONENTS.getKeyInput(this.page);
      await keyInput.click();
      await keyInput.fill("lifecycle");
      await keyInput.press("Tab");
      await keyInput.fill("experimental");
      await CONDITIONAL_RULE_COMPONENTS.getAddRuleButton(this.page).click();
      await this.page.getByLabel("Open").nth(3).click();
      await CONDITIONAL_RULE_COMPONENTS.getHasLabelButton(this.page).click();
      const labelInput = CONDITIONAL_RULE_COMPONENTS.getLabelInput(this.page);
      await labelInput.click();
      await labelInput.fill("partner");
      // Add nested condition
      await CONDITIONAL_RULE_COMPONENTS.getAddNestedConditionButton(
        this.page,
      ).click();
      await this.page.getByLabel("Open").nth(4).click();
      await CONDITIONAL_RULE_COMPONENTS.getHasAnnotationButton(
        this.page,
      ).click();
      const annotationInput = CONDITIONAL_RULE_COMPONENTS.getAnnotationInput(
        this.page,
      );
      await annotationInput.click();
      await annotationInput.fill("test");
      await CONDITIONAL_RULE_COMPONENTS.getSaveConditionsButton(
        this.page,
      ).click();
      await this.pluginRuleCount("4");
      await this.next();
      await this.uiHelper.verifyHeading("Review and create");
      await this.uiHelper.verifyText(
        this.regexpLongUsersAndGroups(users.length, groups.length),
      );
      await this.verifyPermissionPoliciesHeader(1);
      await this.uiHelper.verifyText("4 rules");
      await this.uiHelper.clickButton("Create");
      await this.uiHelper.verifyText(
        `Role role:default/${name} created successfully`,
      );
    } else if (permissionPolicyType === "not") {
      // Conditional Scenario 2: Permission policies using Not
      await this.selectPermissionCheckbox("catalog.entity.read");
      await this.page
        .getByRole("row", { name: "catalog.entity.read" })
        .getByLabel("remove")
        .click();
      await CONDITIONAL_RULE_COMPONENTS.getNotButton(this.page).click();
      await this.clickOpenSidebar();
      await CONDITIONAL_RULE_COMPONENTS.getHasSpecButton(this.page).click();
      const keyInput = CONDITIONAL_RULE_COMPONENTS.getKeyInput(this.page);
      await keyInput.click();
      await keyInput.fill("lifecycle");
      await keyInput.press("Tab");
      await keyInput.fill("experimental");
      await CONDITIONAL_RULE_COMPONENTS.getSaveConditionsButton(
        this.page,
      ).click();
      await this.pluginRuleCount("1");
      await this.next();
      await this.uiHelper.verifyHeading("Review and create");
      await this.verifyPermissionPoliciesHeader(1);
      await this.uiHelper.verifyText("1 rule");
      await this.uiHelper.clickButton("Create");
      await this.uiHelper.verifyText(`role:default/${name}`);

      await this.searchAndVerifyRoleHeading(name);
    }
  }

  async deleteRole(
    name: string,
    header: string = "All roles (0)",
    skipVerify?: boolean,
  ) {
    // Ensure we always navigate back to the RBAC page
    await this.go();

    await this.uiHelper.searchInputAriaLabel(name);
    const button = ROLES_PAGE_COMPONENTS.getDeleteRoleButton(this.page, name);
    await button.waitFor({ state: "visible" });
    await button.click();
    await this.uiHelper.verifyHeading("Delete this role?");
    const roleNameInput = DELETE_ROLE_COMPONENTS.getRoleNameInput(this.page);
    await roleNameInput.click();
    await roleNameInput.fill(name);
    await this.uiHelper.clickButton("Delete");

    if (!skipVerify) {
      await this.uiHelper.verifyText(`Role ${name} deleted successfully`);

      await this.searchAndVerifyRoleHeading(name, header);
    }
  }

  /**
   * Adds an `IS_ENTITY_OWNER` conditional policy for each of the three
   * policy-management permissions.  These are the permissions that allow a
   * non-admin user to manage RBAC — the IsOwner condition scopes them to
   * entities the user already owns so they cannot escalate their own access.
   */
  private async createRBACConditions(owner: string) {
    const permissions = [
      "policy.entity.read",
      "policy.entity.update",
      "policy.entity.delete",
    ];
    for (const permission of permissions) {
      await this.selectPermissionCheckbox(permission);
      await this.page
        .getByRole("row", { name: permission })
        .getByLabel("remove")
        .click();
      await this.clickOpenSidebar();
      await CONDITIONAL_RULE_COMPONENTS.getIsOwnerButton(this.page).click();
      await this.page.getByPlaceholder("string, string").click();
      await this.page.getByPlaceholder("string, string").fill(owner);
      await CONDITIONAL_RULE_COMPONENTS.getSaveConditionsButton(
        this.page,
      ).click();
    }
  }

  async createRBACConditionRole(name: string, users: string[], owner: string) {
    if (!this.page.url().includes("rbac")) await this.go();
    await this.createRoleUsers(name, users, [], owner);

    await this.openPluginsDropdown();
    await this.selectOption("catalog");
    await this.openPermissionsDropdown();

    await this.selectPermissionCheckbox("catalog.entity.read");
    await ROLE_FORM_COMPONENTS.getExpandCatalogRow(this.page).click();

    await this.openPluginsDropdown();
    await this.selectOption("permission");
    await this.openPermissionsDropdown();

    await this.selectPermissionCheckbox("policy.entity.create");

    await this.createRBACConditions(owner);

    await this.next();
    await this.uiHelper.verifyHeading("Review and create");
    await this.verifyPermissionPoliciesHeader(5);
    await this.create();

    await this.searchAndVerifyRoleHeading(name);
  }

  public async editRoleMembers(
    role: string,
    user: string,
    numUsers: number,
    numGroups: number,
  ) {
    await this.uiHelper.verifyHeading("Edit Role");
    // When navigating from the roles list inline-edit button the form opens
    // directly at the users/groups step, but when invoked from the overview
    // page an initial "Next" button is shown on a preceding step — handle both
    const isNextButtonVisible = await ROLE_FORM_COMPONENTS.getNextButton(
      this.page,
    ).isVisible();

    if (isNextButtonVisible)
      await ROLE_FORM_COMPONENTS.getNextButton(this.page).click();

    // Wait for users and groups step to be ready
    await expect(this.page.getByLabel("Select users and groups")).toBeVisible();

    await ROLE_FORM_COMPONENTS.getUsersAndGroupsField(this.page).click();
    await ROLE_FORM_COMPONENTS.getMemberOption(this.page, user).click();
    // Close dropdown after selecting users and groups
    await ROLE_FORM_COMPONENTS.getDropdownToggle(this.page).click();

    await this.uiHelper.verifyHeading(
      this.regexpShortUsersAndGroups(numUsers, numGroups),
    );

    await ROLE_FORM_COMPONENTS.getUserAndGroupNextButton(this.page).click();

    // Wait for permissions step to be ready (use .first() to handle multiple Next buttons)
    await this.page.getByText(/\d plugins/).waitFor({ state: "visible" });
    const nextPermissionPolicyButton =
      ROLE_FORM_COMPONENTS.getPermissionPolicyNextButton(this.page);
    await expect(nextPermissionPolicyButton).toBeVisible();
    await expect(nextPermissionPolicyButton).toBeEnabled();
    await nextPermissionPolicyButton.click();

    // The "users are not granted access" banner is shown while the review step
    // is still loading; wait for it to disappear before the Save button becomes
    // clickable
    await this.page
      .getByText("users are not granted access")
      .waitFor({ state: "hidden" });
    const saveButton = this.page.getByRole("button", { name: "Save" });
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await this.uiHelper.verifyText(`Role ${role} updated successfully`);
  }

  public async editRolePermissions() {
    await ROLE_OVERVIEW_COMPONENTS.getUpdatePoliciesButton(this.page).click();
    await this.uiHelper.verifyHeading("Edit Role");
    await this.openPluginsDropdown();
    await this.selectOption("scaffolder");

    // Close the plugins dropdown to access the permissions table
    await this.page.getByRole("button", { name: "Close" }).click();

    // Expand the Scaffolder row to access its permissions
    await this.page
      .getByRole("row", { name: /Scaffolder/i })
      .getByRole("button", { name: "expand row" })
      .click();

    await this.selectPermissionCheckbox("scaffolder.template.parameter");
    await ROLE_FORM_COMPONENTS.getPermissionPolicyNextButton(this.page).click();

    // The "users are not granted access" banner is shown while the review step
    // is still loading; wait for it to disappear before the Save button becomes
    // clickable
    await this.page
      .getByText("users are not granted access")
      .waitFor({ state: "hidden" });
    await expect(this.page.getByRole("button", { name: "Save" })).toBeVisible();
    await this.uiHelper.clickButton("Save");
  }
}
