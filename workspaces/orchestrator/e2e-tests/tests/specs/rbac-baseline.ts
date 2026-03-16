import { test, Browser, TestInfo, Page } from "rhdh-e2e-test-utils/test";
import {
  setupBrowser,
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  RbacApiHelper,
  Policy,
  Response,
} from "rhdh-e2e-test-utils/helpers";

/**
 * User entity references matching the default Keycloak users from rhdh-e2e-test-utils.
 * Override via PRIMARY_TEST_USER / SECONDARY_TEST_USER env vars for CI environments
 * that use different Keycloak users (e.g., rhdh-qe / rhdh-qe-2).
 */
export const PRIMARY_USER = `user:default/${process.env.PRIMARY_TEST_USER || "test1"}`;
export const SECONDARY_USER = `user:default/${process.env.SECONDARY_TEST_USER || "test2"}`;

export const BASELINE_ROLE_NAME = "role:default/orchestrator-baseline";

export type PolicySpec = {
  permission: string;
  policy: string;
  effect: string;
};

/** Strips the `role:default/` prefix to produce the API-friendly role name. */
export function roleApiName(roleName: string): string {
  return roleName.replace("role:", "").replace("default/", "");
}

/** Builds a full policy array by stamping `entityReference` onto each spec. */
export function buildPolicies(roleName: string, specs: PolicySpec[]) {
  return specs.map((spec) => ({ entityReference: roleName, ...spec }));
}

const BASELINE_POLICIES = buildPolicies(BASELINE_ROLE_NAME, [
  { permission: "orchestrator.workflow", policy: "read", effect: "allow" },
  {
    permission: "orchestrator.workflow.use",
    policy: "update",
    effect: "allow",
  },
  { permission: "catalog-entity", policy: "read", effect: "allow" },
  { permission: "catalog.entity.create", policy: "create", effect: "allow" },
  { permission: "catalog.location.read", policy: "read", effect: "allow" },
  { permission: "catalog.location.create", policy: "create", effect: "allow" },
  {
    permission: "scaffolder.action.execute",
    policy: "use",
    effect: "allow",
  },
  { permission: "scaffolder.task.create", policy: "create", effect: "allow" },
  { permission: "scaffolder.task.read", policy: "read", effect: "allow" },
]);

async function withTempPage(
  browser: Browser,
  fn: (page: Awaited<ReturnType<typeof browser.newPage>>) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: process.env.RHDH_BASE_URL,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  try {
    await fn(page);
  } finally {
    await context.close();
  }
}

/** Sets up a browser page, logs in via Keycloak, and returns ready-to-use helpers. */
export async function setupAuthenticatedPage(
  browser: Browser,
  testInfo: TestInfo,
): Promise<{
  page: Page;
  uiHelper: UIhelper;
  loginHelper: LoginHelper;
  apiToken: string;
}> {
  const { page } = await setupBrowser(browser, testInfo);
  const uiHelper = new UIhelper(page);
  const loginHelper = new LoginHelper(page);
  await loginHelper.loginAsKeycloakUser();
  const apiToken = await new AuthApiHelper(page).getToken();
  return { page, uiHelper, loginHelper, apiToken };
}

/** Deletes a role and all its policies, swallowing errors if the role doesn't exist. */
export async function deleteRoleAndPolicies(
  apiToken: string,
  roleName: string,
): Promise<void> {
  const rbacApi = await RbacApiHelper.build(apiToken);
  const apiName = roleApiName(roleName);
  try {
    const policiesResponse = await rbacApi.getPoliciesByRole(apiName);
    if (policiesResponse.ok()) {
      const policies =
        await Response.removeMetadataFromResponse(policiesResponse);
      await rbacApi.deletePolicy(apiName, policies as Policy[]);
    }
    await rbacApi.deleteRole(apiName);
  } catch (error) {
    console.log(`[rbac] Cleanup for ${roleName} (may not exist):`, error);
  }
}

/**
 * Creates a baseline RBAC role granting the primary test user full orchestrator,
 * catalog, and scaffolder permissions. Runs once per test run via test.runOnce.
 *
 * Call from non-RBAC specs' beforeAll to ensure the logged-in user has access
 * when permission.rbac.pluginsWithPermission includes orchestrator.
 */
export async function ensureBaselineRole(
  browser: Browser,
  _testInfo: TestInfo,
): Promise<void> {
  await test.runOnce("rbac-baseline-setup", async () => {
    await withTempPage(browser, async (page) => {
      const loginHelper = new LoginHelper(page);
      await loginHelper.loginAsKeycloakUser();
      const token = await new AuthApiHelper(page).getToken();
      const rbacApi = await RbacApiHelper.build(token);

      await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: BASELINE_ROLE_NAME,
      });
      await rbacApi.createPolicies(BASELINE_POLICIES);

      console.log(`[rbac-baseline] Created baseline role for ${PRIMARY_USER}`);
    });
  });
}

/**
 * Removes the baseline RBAC role so RBAC tests can manage permissions
 * from a clean slate. Runs once per test run via test.runOnce.
 *
 * Call from RBAC specs' beforeAll before any test block creates its own roles.
 */
export async function removeBaselineRole(
  browser: Browser,
  _testInfo: TestInfo,
): Promise<void> {
  await test.runOnce("rbac-baseline-cleanup", async () => {
    await withTempPage(browser, async (page) => {
      const loginHelper = new LoginHelper(page);
      await loginHelper.loginAsKeycloakUser();
      const token = await new AuthApiHelper(page).getToken();
      await deleteRoleAndPolicies(token, BASELINE_ROLE_NAME);
      console.log("[rbac-baseline] Removed baseline role");
    });
  });
}
