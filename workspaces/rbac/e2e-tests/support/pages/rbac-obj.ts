import {
  type Locator,
  type Page,
} from "@red-hat-developer-hub/e2e-test-utils/test";

/**
 * ROLES_PAGE_COMPONENTS - Roles list page: edit and delete buttons
 */
export const ROLES_PAGE_COMPONENTS = {
  getEditRoleButton: (page: Page, name: string): Locator =>
    page.getByTestId(`edit-role-${name}`),

  getDeleteRoleButton: (page: Page, name: string): Locator =>
    page.getByTestId(`delete-role-${name}`),

  getFilterInput: (page: Page): Locator => page.getByPlaceholder("Filter"),
};

/**
 * DELETE_ROLE_COMPONENTS - Delete role confirmation dialog
 */
export const DELETE_ROLE_COMPONENTS = {
  getRoleNameInput: (page: Page): Locator =>
    page.locator('input[name="delete-role"]'),
};

/**
 * ROLE_OVERVIEW_COMPONENTS - Role overview page action buttons
 */
export const ROLE_OVERVIEW_COMPONENTS = {
  getUpdatePoliciesButton: (page: Page): Locator =>
    page.getByTestId("update-policies"),

  getUpdateMembersButton: (page: Page): Locator =>
    page.getByTestId("update-members"),
};

/**
 * ROLE_FORM_COMPONENTS - Role creation / edit form fields
 */
export const ROLE_FORM_COMPONENTS = {
  getRoleNameInput: (page: Page): Locator => page.locator('input[name="name"]'),

  getRoleOwnerInput: (page: Page): Locator =>
    page.locator('textarea[name="owner"]'),

  getUsersAndGroupsField: (page: Page): Locator =>
    page.locator('input[name="add-users-and-groups"]'),

  getMemberOption: (page: Page, label: string): Locator =>
    page.locator(`span[data-testid="${label}"]`),

  getDropdownToggle: (page: Page): Locator =>
    page.getByTestId("ArrowDropDownIcon"),

  getSelectPluginsCombobox: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Select plugins" }),

  getExpandCatalogRow: (page: Page): Locator =>
    page.getByTestId("expand-row-catalog"),

  getNextButton: (page: Page): Locator =>
    page.getByTestId("nextButton-0").first(),

  getUserAndGroupNextButton: (page: Page): Locator =>
    page.getByTestId("nextButton-1").first(),

  getPermissionPolicyNextButton: (page: Page): Locator =>
    page.getByTestId("nextButton-2").first(),

  getPermissionsSelectPlaceholder: (page: Page): Locator =>
    page.getByText("Select..."),
};

/**
 * CONDITIONAL_RULE_COMPONENTS - Conditions sidebar and rule builder
 */
export const CONDITIONAL_RULE_COMPONENTS = {
  getRulesSidebar: (page: Page): Locator => page.getByTestId("rules-sidebar"),

  getSaveConditionsButton: (page: Page): Locator =>
    page.getByTestId("save-conditions"),

  getAnyOfButton: (page: Page): Locator =>
    page.getByRole("button", { name: "AnyOf" }),

  getNotButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Not" }),

  getAddRuleButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Add rule" }),

  getAddNestedConditionButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Add Nested Condition" }),

  getHasSpecButton: (page: Page): Locator => page.getByText("HAS_SPEC"),

  getHasAnnotationButton: (page: Page): Locator =>
    page.getByText("HAS_ANNOTATION"),

  getHasLabelButton: (page: Page): Locator => page.getByText("HAS_LABEL"),

  getIsEntityKindButton: (page: Page): Locator =>
    page.getByText("IS_ENTITY_KIND"),

  getIsOwnerButton: (page: Page): Locator => page.getByText("IS_OWNER"),

  getKeyInput: (page: Page): Locator => page.getByLabel("key *"),

  getAnnotationInput: (page: Page): Locator => page.getByLabel("annotation *"),

  getLabelInput: (page: Page): Locator => page.getByLabel("label *"),

  getRuleBadge: (page: Page, count: string): Locator =>
    page.locator('span[class*="MuiBadge-badge"]').filter({ hasText: count }),
};

/**
 * SEARCH_COMPONENTS - Search inputs on the roles list page
 */
export const SEARCH_COMPONENTS = {
  getAriaLabelSearchInput: (page: Page): Locator =>
    page.locator('input[aria-label="Search"]'),

  getPlaceholderSearchInput: (page: Page): Locator =>
    page.locator('input[placeholder="Search"]'),
};
