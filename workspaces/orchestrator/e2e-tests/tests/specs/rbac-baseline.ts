import { test, Browser, TestInfo } from "rhdh-e2e-test-utils/test";
import {
  LoginHelper,
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
export const PRIMARY_USER =
  `user:default/${process.env.PRIMARY_TEST_USER || "test1"}`;
export const SECONDARY_USER =
  `user:default/${process.env.SECONDARY_TEST_USER || "test2"}`;

export const BASELINE_ROLE_NAME = "role:default/orchestrator-baseline";
const BASELINE_ROLE_API_NAME = "orchestrator-baseline";

const BASELINE_POLICIES = [
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "orchestrator.workflow",
    policy: "read",
    effect: "allow",
  },
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "orchestrator.workflow.use",
    policy: "update",
    effect: "allow",
  },
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "catalog-entity",
    policy: "read",
    effect: "allow",
  },
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "catalog.entity.create",
    policy: "create",
    effect: "allow",
  },
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "catalog.location.read",
    policy: "read",
    effect: "allow",
  },
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "catalog.location.create",
    policy: "create",
    effect: "allow",
  },
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "scaffolder.action.execute",
    policy: "use",
    effect: "allow",
  },
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "scaffolder.task.create",
    policy: "create",
    effect: "allow",
  },
  {
    entityReference: BASELINE_ROLE_NAME,
    permission: "scaffolder.task.read",
    policy: "read",
    effect: "allow",
  },
];

async function withTempPage(
  browser: Browser,
  testInfo: TestInfo,
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

/**
 * Creates a baseline RBAC role granting the primary test user full orchestrator,
 * catalog, and scaffolder permissions. Runs once per test run via test.runOnce.
 *
 * Call from non-RBAC specs' beforeAll to ensure the logged-in user has access
 * when permission.rbac.pluginsWithPermission includes orchestrator.
 */
export async function ensureBaselineRole(
  browser: Browser,
  testInfo: TestInfo,
): Promise<void> {
  await test.runOnce("rbac-baseline-setup", async () => {
    await withTempPage(browser, testInfo, async (page) => {
      const loginHelper = new LoginHelper(page);
      await loginHelper.loginAsKeycloakUser();
      const token = await new AuthApiHelper(page).getToken();
      const rbacApi = await RbacApiHelper.build(token);

      await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: BASELINE_ROLE_NAME,
      });
      await rbacApi.createPolicies(BASELINE_POLICIES);

      console.log(
        `[rbac-baseline] Created baseline role for ${PRIMARY_USER}`,
      );
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
  testInfo: TestInfo,
): Promise<void> {
  await test.runOnce("rbac-baseline-cleanup", async () => {
    await withTempPage(browser, testInfo, async (page) => {
      const loginHelper = new LoginHelper(page);
      await loginHelper.loginAsKeycloakUser();
      const token = await new AuthApiHelper(page).getToken();
      const rbacApi = await RbacApiHelper.build(token);

      try {
        const policiesResponse =
          await rbacApi.getPoliciesByRole(BASELINE_ROLE_API_NAME);
        if (policiesResponse.ok()) {
          const policies =
            await Response.removeMetadataFromResponse(policiesResponse);
          await rbacApi.deletePolicy(
            BASELINE_ROLE_API_NAME,
            policies as Policy[],
          );
        }
        await rbacApi.deleteRole(BASELINE_ROLE_API_NAME);
        console.log("[rbac-baseline] Removed baseline role");
      } catch (error) {
        console.log("[rbac-baseline] Cleanup (role may not exist):", error);
      }
    });
  });
}
