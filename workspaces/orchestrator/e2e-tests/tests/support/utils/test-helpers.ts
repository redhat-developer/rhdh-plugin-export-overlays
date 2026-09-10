import { request } from "@playwright/test";
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
import { OrchestratorPO } from "../pages/orchestrator-po.js";

export {
  configureOrchestratorLoki,
  waitForLokiWorkflowLogs,
} from "./orchestrator-loki-helpers.js";
export { configureOrchestratorKafka } from "./orchestrator-kafka-helpers.js";
export {
  deployLockFlowWorkflow,
  deploySonataflow,
  prepareRhdhHelmRedeploy,
  runOc,
  logOrchestratorDeployFailureDiagnostics,
} from "./workflow-deployment-helpers.js";
export { patchHttpbin, cleanupAfterTest } from "./cluster-helpers.js";

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

export const GREETING_WORKFLOW_ID = "greeting";

export type PolicySpec = {
  permission: string;
  policy: string;
  effect: string;
};

export type WorkflowConditionSpec = {
  permissionMapping: Array<"read" | "update">;
  workflowIds: string[];
};

type RoleConditionRecord = {
  id?: number | string;
  roleEntityRef?: string;
  permissionMapping?: string[];
  conditions?: RoleConditionCriteria;
};

type RoleConditionCriteria = {
  rule?: string;
  params?: {
    workflowIds?: string[];
  };
  anyOf?: RoleConditionCriteria[];
  allOf?: RoleConditionCriteria[];
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

export function greetingWorkflowConditions(
  readEffect: "allow" | "deny",
  useEffect: "allow" | "deny",
): WorkflowConditionSpec[] {
  const permissionMapping: Array<"read" | "update"> = [];
  if (readEffect === "allow") {
    permissionMapping.push("read");
  }
  if (useEffect === "allow") {
    permissionMapping.push("update");
  }
  if (permissionMapping.length === 0) {
    return [];
  }
  return [
    {
      permissionMapping,
      workflowIds: [GREETING_WORKFLOW_ID],
    },
  ];
}

export function roleApiName(roleName: string): string {
  return roleName.replace("role:", "").replace("default/", "");
}

export function buildPolicies(roleName: string, specs: PolicySpec[]) {
  return specs.map((spec) => ({ entityReference: roleName, ...spec }));
}

function permissionApiUrl(): string {
  return `${process.env.RHDH_BASE_URL}/api/permission/`;
}

async function listRoleConditions(
  rbacApi: RbacApiHelper,
  roleName: string,
): Promise<RoleConditionRecord[]> {
  const response = await rbacApi.getConditions();
  if (!response.ok()) {
    return [];
  }
  const body: unknown = await response.json();
  const all = Array.isArray(body) ? (body as RoleConditionRecord[]) : [];
  return all.filter((condition) => condition.roleEntityRef === roleName);
}

function collectWorkflowIds(
  criteria: RoleConditionCriteria | undefined,
): string[] {
  if (!criteria) {
    return [];
  }
  if (Array.isArray(criteria.params?.workflowIds)) {
    return criteria.params.workflowIds;
  }
  const nested = [...(criteria.anyOf ?? []), ...(criteria.allOf ?? [])];
  return nested.flatMap((item) => collectWorkflowIds(item));
}

function conditionMatchesSpec(
  actual: RoleConditionRecord,
  expected: WorkflowConditionSpec,
): boolean {
  const mapping = actual.permissionMapping ?? [];
  if (
    mapping.length !== expected.permissionMapping.length ||
    !expected.permissionMapping.every((action) => mapping.includes(action))
  ) {
    return false;
  }
  const workflowIds = collectWorkflowIds(actual.conditions);
  return (
    workflowIds.length === expected.workflowIds.length &&
    expected.workflowIds.every((workflowId) => workflowIds.includes(workflowId))
  );
}

export async function createOrchestratorWorkflowConditions(
  apiToken: string,
  roleName: string,
  specs: WorkflowConditionSpec[],
): Promise<void> {
  if (specs.length === 0) {
    return;
  }
  // RbacApiHelper can list/delete conditions but has no create method.
  const context = await request.newContext({
    baseURL: permissionApiUrl(),
    extraHTTPHeaders: {
      Accept: "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
  });
  try {
    for (const spec of specs) {
      const response = await context.post("roles/conditions", {
        data: {
          result: "CONDITIONAL",
          roleEntityRef: roleName,
          pluginId: "orchestrator",
          resourceType: "orchestrator-workflow",
          permissionMapping: spec.permissionMapping,
          conditions: {
            rule: "IS_ALLOWED_WORKFLOW_ID",
            resourceType: "orchestrator-workflow",
            params: { workflowIds: spec.workflowIds },
          },
        },
      });
      if (!response.ok()) {
        throw new Error(
          `Failed to create conditional policy for ${roleName}: ${response.status()} ${await response.text()}`,
        );
      }
    }
  } finally {
    await context.dispose();
  }
}

export async function createRoleWithPolicies(
  apiToken: string,
  roleName: string,
  memberReferences: string[],
  policySpecs: PolicySpec[],
  conditionSpecs: WorkflowConditionSpec[] = [],
): Promise<void> {
  const rbacApi = await RbacApiHelper.build(apiToken);
  const rolePostResponse = await rbacApi.createRoles({
    memberReferences,
    name: roleName,
  });
  expect(rolePostResponse.ok()).toBeTruthy();
  if (policySpecs.length > 0) {
    const policyPostResponse = await rbacApi.createPolicies(
      buildPolicies(roleName, policySpecs),
    );
    expect(policyPostResponse.ok()).toBeTruthy();
  }
  await createOrchestratorWorkflowConditions(
    apiToken,
    roleName,
    conditionSpecs,
  );
}

export async function verifyRoleWithPolicies(
  apiToken: string,
  roleName: string,
  expectedMembers: string[],
  expectedPolicies: PolicySpec[],
  expectedConditions: WorkflowConditionSpec[] = [],
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

  if (expectedPolicies.length > 0) {
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

  const roleConditions = await listRoleConditions(rbacApi, roleName);
  expect(roleConditions).toHaveLength(expectedConditions.length);
  for (const expectedCondition of expectedConditions) {
    expect(
      roleConditions.some((condition) =>
        conditionMatchesSpec(condition, expectedCondition),
      ),
    ).toBeTruthy();
  }
}

const BASELINE_POLICY_SPECS: PolicySpec[] = [
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
];

async function createBaselineRoleViaApi(browser: Browser): Promise<void> {
  if (!process.env.RHDH_BASE_URL?.trim()) {
    throw new Error(
      "RHDH_BASE_URL is not set — deploy RHDH in this worker before baseline RBAC setup (withTempPage needs a live hub URL).",
    );
  }
  await withTempPage(browser, async (page) => {
    const loginHelper = new LoginHelper(page);
    await loginHelper.loginAsKeycloakUser();
    const token = await new AuthApiHelper(page).getToken();
    await deleteRoleAndPolicies(token, BASELINE_ROLE_NAME);
    await createRoleWithPolicies(
      token,
      BASELINE_ROLE_NAME,
      [PRIMARY_USER],
      BASELINE_POLICY_SPECS,
    );
  });
}

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

export function createOrchestratorPO(
  page: Page,
  uiHelper: UIhelper,
): OrchestratorPO {
  return new OrchestratorPO(page, uiHelper);
}

export async function launchGreetingTemplateFromSelfService(
  page: Page,
  uiHelper: UIhelper,
): Promise<void> {
  await createOrchestratorPO(
    page,
    uiHelper,
  ).openGreetingTemplateFromSelfService();
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
    const conditions = await listRoleConditions(rbacApi, roleName);
    for (const condition of conditions) {
      if (condition.id == null) {
        continue;
      }
      await rbacApi.deleteCondition(String(condition.id));
    }
  } catch {
    // conditions may not exist yet
  }
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
  testInfo: TestInfo,
): Promise<void> {
  await test.runOnce(`rbac-baseline-setup-${testInfo.project.name}`, () =>
    createBaselineRoleViaApi(browser),
  );
}

/** Re-applies baseline after Orchestrator RBAC tests call removeBaselineRole. */
export async function restoreBaselineRole(
  browser: Browser,
  testInfo: TestInfo,
): Promise<void> {
  await test.runOnce(`rbac-baseline-restore-${testInfo.project.name}`, () =>
    createBaselineRoleViaApi(browser),
  );
}

export async function removeBaselineRole(
  browser: Browser,
  testInfo: TestInfo,
): Promise<void> {
  await test.runOnce(
    `rbac-baseline-cleanup-${testInfo.project.name}`,
    async () => {
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
    },
  );
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
