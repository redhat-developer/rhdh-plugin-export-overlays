import { test, Browser, TestInfo, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  setupBrowser,
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  RbacApiHelper,
  Policy,
  Response,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

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
  console.log(
    `[rbac-baseline] Setting up authenticated page for test: "${testInfo.title}"`,
  );
  const { page } = await setupBrowser(browser, testInfo);
  const uiHelper = new UIhelper(page);
  const loginHelper = new LoginHelper(page);
  console.log("[rbac-baseline] Logging in as Keycloak user...");
  await loginHelper.loginAsKeycloakUser();
  console.log("[rbac-baseline] Obtaining API token...");
  const apiToken = await new AuthApiHelper(page).getToken();
  console.log(
    `[rbac-baseline] Authenticated page ready (token length: ${apiToken?.length || 0})`,
  );
  return { page, uiHelper, loginHelper, apiToken };
}

/** Deletes a role and all its policies, swallowing errors if the role doesn't exist. */
export async function deleteRoleAndPolicies(
  apiToken: string,
  roleName: string,
): Promise<void> {
  console.log(`[rbac] Deleting role and policies for: ${roleName}`);
  const rbacApi = await RbacApiHelper.build(apiToken);
  const apiName = roleApiName(roleName);
  try {
    const policiesResponse = await rbacApi.getPoliciesByRole(apiName);
    console.log(
      `[rbac] Get policies for ${apiName}: HTTP ${policiesResponse.status()}`,
    );
    if (policiesResponse.ok()) {
      const policies =
        await Response.removeMetadataFromResponse(policiesResponse);
      console.log(
        `[rbac] Deleting ${(policies as Policy[]).length} policies for ${apiName}`,
      );
      await rbacApi.deletePolicy(apiName, policies as Policy[]);
      console.log(`[rbac] Policies deleted for ${apiName}`);
    } else {
      console.log(
        `[rbac] No policies found for ${apiName} (HTTP ${policiesResponse.status()})`,
      );
    }
    await rbacApi.deleteRole(apiName);
    console.log(`[rbac] Role ${apiName} deleted`);
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
    console.log(
      `[rbac-baseline] Creating baseline role ${BASELINE_ROLE_NAME} for ${PRIMARY_USER}`,
    );
    console.log(
      `[rbac-baseline] Baseline policies (${BASELINE_POLICIES.length}):`,
    );
    for (const p of BASELINE_POLICIES) {
      console.log(
        `[rbac-baseline]   ${p.permission} / ${p.policy} / ${p.effect}`,
      );
    }
    await withTempPage(browser, async (page) => {
      const loginHelper = new LoginHelper(page);
      console.log("[rbac-baseline] Logging in to create baseline role...");
      await loginHelper.loginAsKeycloakUser();
      const token = await new AuthApiHelper(page).getToken();
      const rbacApi = await RbacApiHelper.build(token);

      const roleResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: BASELINE_ROLE_NAME,
      });
      console.log(
        `[rbac-baseline] Role creation: HTTP ${roleResponse.status()}`,
      );
      if (!roleResponse.ok()) {
        const body = await roleResponse.text();
        console.log(`[rbac-baseline] Role creation error: ${body}`);
      }

      const policyResponse = await rbacApi.createPolicies(BASELINE_POLICIES);
      console.log(
        `[rbac-baseline] Policy creation: HTTP ${policyResponse.status()}`,
      );
      if (!policyResponse.ok()) {
        const body = await policyResponse.text();
        console.log(`[rbac-baseline] Policy creation error: ${body}`);
      }

      console.log(`[rbac-baseline] Verifying baseline role was created...`);
      const verifyResponse = await rbacApi.getRoles();
      if (verifyResponse.ok()) {
        const roles = await verifyResponse.json();
        const found = roles.find(
          (r: { name: string }) => r.name === BASELINE_ROLE_NAME,
        );
        console.log(`[rbac-baseline] Baseline role found: ${!!found}`);
      }

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
    console.log(
      `[rbac-baseline] Removing baseline role ${BASELINE_ROLE_NAME} for clean RBAC slate`,
    );
    await withTempPage(browser, async (page) => {
      const loginHelper = new LoginHelper(page);
      console.log("[rbac-baseline] Logging in to remove baseline role...");
      await loginHelper.loginAsKeycloakUser();
      const token = await new AuthApiHelper(page).getToken();
      await deleteRoleAndPolicies(token, BASELINE_ROLE_NAME);

      console.log("[rbac-baseline] Verifying baseline role was removed...");
      const rbacApi = await RbacApiHelper.build(token);
      const verifyResponse = await rbacApi.getRoles();
      if (verifyResponse.ok()) {
        const roles = await verifyResponse.json();
        const found = roles.find(
          (r: { name: string }) => r.name === BASELINE_ROLE_NAME,
        );
        console.log(`[rbac-baseline] Baseline role still exists: ${!!found}`);
        if (found) {
          console.warn(
            "[rbac-baseline] WARNING: Baseline role was NOT removed successfully!",
          );
        }
      }

      console.log("[rbac-baseline] Removed baseline role");
    });
  });
}
