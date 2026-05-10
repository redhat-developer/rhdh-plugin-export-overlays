import {
  test,
  expect,
  Browser,
  TestInfo,
  Page,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  setupBrowser,
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  APIHelper,
  RbacApiHelper,
  Policy,
  Response,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
export {
  deploySonataflow,
  runOc,
  logOrchestratorDeployFailureDiagnostics,
} from "./workflow-deployment-helpers.js";
export {
  patchHttpbin,
  restartAndWait,
  cleanupAfterTest,
} from "./cluster-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRIMARY_USER = `user:default/${process.env.PRIMARY_TEST_USER || "test1"}`;
export const SECONDARY_USER = `user:default/${process.env.SECONDARY_TEST_USER || "test2"}`;

export const BASELINE_ROLE_NAME = "role:default/orchestrator-baseline";

const GREETING_COMPONENT_LOCATION =
  "https://github.com/testetson22/greeting_54mjks/blob/main/templates/greeting/skeleton/catalog-info.yaml";

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------

export type PolicySpec = {
  permission: string;
  policy: string;
  effect: string;
};

export function globalWorkflowPolicies(
  readEffect: "allow" | "deny",
  useEffect: "allow" | "deny",
): PolicySpec[] {
  return [
    {
      permission: "orchestrator.workflow",
      policy: "read",
      effect: readEffect,
    },
    {
      permission: "orchestrator.workflow.use",
      policy: "update",
      effect: useEffect,
    },
  ];
}

export function greetingWorkflowPolicies(
  readEffect: "allow" | "deny",
  useEffect: "allow" | "deny",
): PolicySpec[] {
  return [
    {
      permission: "orchestrator.workflow.greeting",
      policy: "read",
      effect: readEffect,
    },
    {
      permission: "orchestrator.workflow.use.greeting",
      policy: "update",
      effect: useEffect,
    },
  ];
}

export function roleApiName(roleName: string): string {
  return roleName.replace("role:", "").replace("default/", "");
}

export function buildPolicies(roleName: string, specs: PolicySpec[]) {
  return specs.map((spec) => ({ entityReference: roleName, ...spec }));
}

export async function createRoleWithPolicies(
  apiToken: string,
  roleName: string,
  memberReferences: string[],
  policySpecs: PolicySpec[],
): Promise<void> {
  const rbacApi = await RbacApiHelper.build(apiToken);
  const rolePostResponse = await rbacApi.createRoles({
    memberReferences,
    name: roleName,
  });
  const policyPostResponse = await rbacApi.createPolicies(
    buildPolicies(roleName, policySpecs),
  );
  expect(rolePostResponse.ok()).toBeTruthy();
  expect(policyPostResponse.ok()).toBeTruthy();
}

export async function verifyRoleWithPolicies(
  apiToken: string,
  roleName: string,
  expectedMembers: string[],
  expectedPolicies: PolicySpec[],
): Promise<void> {
  const rbacApi = await RbacApiHelper.build(apiToken);

  const rolesResponse = await rbacApi.getRoles();
  expect(rolesResponse.ok()).toBeTruthy();

  const roles = await rolesResponse.json();
  const workflowRole = roles.find(
    (role: { name: string; memberReferences: string[] }) =>
      role.name === roleName,
  );
  expect(workflowRole).toBeDefined();
  for (const member of expectedMembers) {
    expect(workflowRole?.memberReferences).toContain(member);
  }

  const policiesResponse = await rbacApi.getPoliciesByRole(
    roleApiName(roleName),
  );
  expect(policiesResponse.ok()).toBeTruthy();

  const policies = await policiesResponse.json();
  expect(policies).toHaveLength(expectedPolicies.length);

  for (const expectedPolicy of expectedPolicies) {
    const actualPolicy = policies.find(
      (policy: { permission: string; policy: string; effect: string }) =>
        policy.permission === expectedPolicy.permission &&
        policy.policy === expectedPolicy.policy,
    );
    expect(actualPolicy).toBeDefined();
    expect(actualPolicy.effect).toBe(expectedPolicy.effect);
  }
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
  {
    permission: "scaffolder.template.parameter.read",
    policy: "read",
    effect: "allow",
  },
  {
    permission: "scaffolder.template.step.read",
    policy: "read",
    effect: "allow",
  },
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

export async function launchGreetingTemplateFromSelfService(
  page: Page,
  uiHelper: UIhelper,
): Promise<void> {
  await uiHelper.clickLink({ ariaLabel: "Self-service" });
  await uiHelper.verifyHeading("Self-service");
  await page.waitForLoadState("domcontentloaded");
  await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");
  await uiHelper.verifyHeading(/Greeting Test Picker/i, 30_000);
}

export async function waitForScaffolderTerminalState(
  page: Page,
  timeoutMs = 120_000,
): Promise<void> {
  const completed = page.getByText(/Completed|succeeded|finished/i);
  const conflictError = page.getByText(/409 Conflict/i);
  const startOver = page.getByRole("button", { name: "Start Over" });
  await completed
    .or(conflictError)
    .or(startOver)
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

export async function clickCreateAndWaitForScaffolderTerminalState(
  page: Page,
  timeoutMs = 120_000,
): Promise<void> {
  const createButton = page.getByRole("button", { name: /Create/i });
  await createButton.waitFor({ state: "visible", timeout: 10_000 });
  await createButton.click();
  await waitForScaffolderTerminalState(page, timeoutMs);
}

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
  } catch {
    // role may not exist yet
  }
}

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
    });
  });
}

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

      const rbacApi = await RbacApiHelper.build(token);
      const verifyResponse = await rbacApi.getRoles();
      if (verifyResponse.ok()) {
        const roles = await verifyResponse.json();
        const found = roles.find(
          (r: { name: string }) => r.name === BASELINE_ROLE_NAME,
        );
        if (found) {
          console.warn(
            "[rbac-baseline] WARNING: Baseline role was NOT removed successfully!",
          );
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Catalog cleanup
// ---------------------------------------------------------------------------

export async function cleanupGreetingComponentEntity(): Promise<void> {
  try {
    const locationId = await APIHelper.getLocationIdByTarget(
      GREETING_COMPONENT_LOCATION,
    );
    if (locationId) {
      await APIHelper.deleteEntityLocationById(locationId);
    }
  } catch (e) {
    console.warn("Cleanup of greeting-test-component location failed:", e);
  }
}
