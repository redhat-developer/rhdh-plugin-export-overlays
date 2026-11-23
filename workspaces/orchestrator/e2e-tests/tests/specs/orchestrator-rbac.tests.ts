import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  RbacApiHelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { ORCHESTRATOR_COMPONENTS } from "../support/pages/orchestrator-obj.js";
import {
  TEMPLATE_PERMISSION_BASE_POLICIES,
  removeBaselineRole,
  setupAuthenticatedPage,
  createOrchestratorPO,
  deleteRoleAndPolicies,
  createRoleWithPolicies,
  verifyRoleWithPolicies,
  buildPolicies,
  globalWorkflowPolicies,
  greetingWorkflowConditions,
  roleApiName,
  PRIMARY_USER,
  SECONDARY_USER,
  type PolicySpec,
  type WorkflowConditionSpec,
  cleanupGreetingComponentEntity,
} from "../support/utils/test-helpers.js";

type RbacScenario = {
  name: string;
  roleName: string;
  policies: PolicySpec[];
  conditions: WorkflowConditionSpec[];
  expectWorkflowVisible: boolean;
  expectRunState: "enabled" | "disabled" | "absent" | "disabled-or-absent";
  workflowScope: "global" | "greeting";
};

const KEYCLOAK_FORM_VISIBLE_TIMEOUT_MS = 5_000;
const LOGIN_SUCCESS_TIMEOUT_MS = 15_000;
const WORKFLOW_INSTANCE_VISIBLE_TIMEOUT_MS = 30_000;

const RBAC_SCENARIOS: RbacScenario[] = [
  {
    name: "Global Read-Write",
    roleName: "role:default/workflowReadwrite",
    policies: globalWorkflowPolicies("allow", "allow"),
    conditions: [],
    expectWorkflowVisible: true,
    expectRunState: "enabled",
    workflowScope: "global",
  },
  {
    name: "Global Read-Only",
    roleName: "role:default/workflowReadonly",
    policies: globalWorkflowPolicies("allow", "deny"),
    conditions: [],
    expectWorkflowVisible: true,
    expectRunState: "disabled-or-absent",
    workflowScope: "global",
  },
  {
    name: "Global Denied",
    roleName: "role:default/workflowDenied",
    policies: globalWorkflowPolicies("deny", "deny"),
    conditions: [],
    expectWorkflowVisible: false,
    expectRunState: "absent",
    workflowScope: "global",
  },
  {
    name: "Greeting Denied",
    roleName: "role:default/workflowGreetingDenied",
    // IS_ALLOWED_WORKFLOW_ID has no deny form. No grant → no access.
    policies: [],
    conditions: [],
    expectWorkflowVisible: false,
    expectRunState: "absent",
    workflowScope: "greeting",
  },
  {
    name: "Greeting Read-Write",
    roleName: "role:default/workflowGreetingReadwrite",
    policies: [],
    conditions: greetingWorkflowConditions("allow", "allow"),
    expectWorkflowVisible: true,
    expectRunState: "enabled",
    workflowScope: "greeting",
  },
  {
    name: "Greeting Read-Only",
    roleName: "role:default/workflowGreetingReadonly",
    policies: [],
    conditions: greetingWorkflowConditions("allow", "deny"),
    expectWorkflowVisible: true,
    expectRunState: "disabled-or-absent",
    workflowScope: "greeting",
  },
];

async function assertRbacScenario(
  page: Page,
  uiHelper: UIhelper,
  loginHelper: LoginHelper,
  scenario: RbacScenario,
): Promise<void> {
  const orchestratorPo = createOrchestratorPO(page, uiHelper);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // Role/policy churn after beforeAll can bounce the SPA to Sign In on reload.
  // Re-auth here only — do not recover mid-navigation inside OrchestratorPO.
  const signInButton = page.getByRole("button", { name: /Sign In/i });
  const signInHeading = page.getByRole("heading", {
    name: /Select a sign-in method/i,
  });
  if (
    (await signInButton.isVisible().catch(() => false)) ||
    (await signInHeading.isVisible().catch(() => false))
  ) {
    await loginAsKeycloakUserWithRetry(page, loginHelper);
  }

  await orchestratorPo.openWorkflowsPage();

  if (!scenario.expectWorkflowVisible) {
    await orchestratorPo.verifyWorkflowHidden("Greeting workflow");
    await uiHelper.verifyTableIsEmpty();
    return;
  }

  await orchestratorPo.openWorkflow("Greeting workflow");
  await expect(
    page.getByRole("heading", { name: /Greeting workflow/i }),
  ).toBeVisible();
  await orchestratorPo.verifyRunButtonState(scenario.expectRunState);

  if (scenario.workflowScope === "greeting") {
    await orchestratorPo.verifyWorkflowHidden("User Onboarding");
  }
}

export async function loginAsKeycloakUserWithRetry(
  page: Page,
  loginHelper: LoginHelper,
  username?: string,
  password?: string,
): Promise<void> {
  const resolvedUsername = username || process.env.GH_USER_ID || "test1";
  const resolvedPassword = password || process.env.GH_USER_PASS || "test1@123";
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await loginHelper.loginAsKeycloakUser(resolvedUsername, resolvedPassword);
      return;
    } catch (error) {
      lastError = error;

      // Fallback path: handle non-popup Keycloak auth flow directly in-page.
      try {
        await page.goto("/");
        await page.waitForLoadState("domcontentloaded");
        const userInput = page.locator("#username");
        if (
          await userInput.isVisible({
            timeout: KEYCLOAK_FORM_VISIBLE_TIMEOUT_MS,
          })
        ) {
          await userInput.fill(resolvedUsername);
          await page.locator("#password").fill(resolvedPassword);
          await page.locator("#kc-login").click();
          await expect(page.locator("nav a").first()).toBeVisible({
            timeout: LOGIN_SUCCESS_TIMEOUT_MS,
          });
          return;
        }
      } catch (fallbackError) {
        lastError = fallbackError;
      }

      await page.goto("/");
      await page.waitForLoadState("load");
      await page.waitForLoadState("domcontentloaded");
    }
  }
  throw lastError;
}

function registerTemplatePermissionRole(
  roleName: string,
  effect: "allow" | "deny",
) {
  let page: Page;
  let uiHelper: UIhelper;
  let apiToken: string;

  test.beforeAll(async ({ browser }, testInfo) => {
    ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
      browser,
      testInfo,
    ));
    await cleanupGreetingComponentEntity(apiToken);
    await createRoleWithPolicies(
      apiToken,
      roleName,
      [PRIMARY_USER],
      [
        ...TEMPLATE_PERMISSION_BASE_POLICIES,
        ...globalWorkflowPolicies(effect, effect),
      ],
    );
  });

  test.afterAll(async () => {
    try {
      await cleanupGreetingComponentEntity(apiToken);
    } finally {
      await deleteRoleAndPolicies(apiToken, roleName);
    }
  });

  return () => ({
    page,
    orchestratorPo: createOrchestratorPO(page, uiHelper),
    apiToken,
  });
}

async function expectGreetingWorkflowDenied(
  page: Page,
  apiToken: string,
): Promise<void> {
  await page.waitForURL(/\/create\/tasks\/[a-f0-9-]+$/i, {
    timeout: 30_000,
  });
  const taskId = new URL(page.url()).pathname.split("/").at(-1);
  const eventsUrl = new URL(
    `/api/scaffolder/v2/tasks/${taskId}/events`,
    process.env.RHDH_BASE_URL,
  );
  let events: unknown;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(eventsUrl.href, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        try {
          if (!response.ok()) {
            throw new Error(
              `Scaffolder task events request failed: ${response.status()}`,
            );
          }
          events = await response.json();
          return events;
        } finally {
          await response.dispose();
        }
      },
      { timeout: 120_000 },
    )
    .toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "completion" })]),
    );
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "log",
        body: expect.objectContaining({
          stepId: "runWorkflow",
          status: "failed",
        }),
      }),
      expect.objectContaining({
        type: "completion",
        body: expect.objectContaining({
          error: {
            name: "NotAllowedError",
            message: "Unauthorized",
          },
        }),
      }),
    ]),
  );
}

export function registerOrchestratorRbacTests(): void {
  test.describe("Orchestrator RBAC", () => {
    test.beforeAll(async ({ browser }, testInfo) => {
      await removeBaselineRole(browser, testInfo);
    });

    for (const scenario of RBAC_SCENARIOS) {
      test.describe(`RBAC: ${scenario.name}`, () => {
        let uiHelper: UIhelper;
        let loginHelper: LoginHelper;
        let page: Page;
        let apiToken: string;

        test.beforeAll(async ({ browser }, testInfo) => {
          ({ page, uiHelper, loginHelper, apiToken } =
            await setupAuthenticatedPage(browser, testInfo));
          await createRoleWithPolicies(
            apiToken,
            scenario.roleName,
            [PRIMARY_USER],
            scenario.policies,
            scenario.conditions,
          );
          await verifyRoleWithPolicies(
            apiToken,
            scenario.roleName,
            [PRIMARY_USER],
            scenario.policies,
            scenario.conditions,
          );
        });

        test.afterAll(async () => {
          await deleteRoleAndPolicies(apiToken, scenario.roleName);
        });

        test(`Validate ${scenario.name} workflow behavior`, async ({}) => {
          // openWorkflowsPage uses sidebar nav (avoids OIDC drop from URL goto).
          test.setTimeout(180_000);
          await assertRbacScenario(page, uiHelper, loginHelper, scenario);
          await expect(page).toHaveURL(/\/orchestrator/);
        });
      });
    }

    test.describe
      .serial("RBAC: Workflow instance initiator and admin override", () => {
      test.describe.configure({ timeout: 180_000 });
      let loginHelper: LoginHelper;
      let uiHelper: UIhelper;
      let page: Page;
      let apiToken: string;
      let workflowInstanceId = "";
      const workflowUserRoleName = "role:default/workflowUser";
      const workflowAdminRoleName = "role:default/workflowAdmin";

      test.beforeAll(async ({ browser }, testInfo) => {
        ({ page, uiHelper, loginHelper, apiToken } =
          await setupAuthenticatedPage(browser, testInfo));
        await deleteRoleAndPolicies(apiToken, workflowUserRoleName);
        await deleteRoleAndPolicies(apiToken, workflowAdminRoleName);

        await createRoleWithPolicies(
          apiToken,
          workflowUserRoleName,
          [PRIMARY_USER, SECONDARY_USER],
          [],
          greetingWorkflowConditions("allow", "allow"),
        );
      });

      test.afterAll(async () => {
        await deleteRoleAndPolicies(apiToken, workflowAdminRoleName);
        await deleteRoleAndPolicies(apiToken, workflowUserRoleName);
      });

      test("Primary user runs greeting workflow and captures instance ID", async ({}) => {
        const orchestratorPo = createOrchestratorPO(page, uiHelper);
        await orchestratorPo.openGreetingWorkflowFromSidebar();
        await orchestratorPo.verifyRunButtonState("enabled");
        workflowInstanceId =
          await orchestratorPo.runGreetingWorkflowAndCaptureInstanceId();
        expect(workflowInstanceId).toBeTruthy();
      });

      test("Secondary user cannot access instance before admin grant", async ({}) => {
        const secondaryUser = process.env.GH_USER2_ID || "test2";
        const secondaryPass = process.env.GH_USER2_PASS || "test2@123";
        const orchestratorPo = createOrchestratorPO(page, uiHelper);
        await page.context().clearCookies();
        await page.goto("/");
        await page.waitForLoadState("load");
        await loginAsKeycloakUserWithRetry(
          page,
          loginHelper,
          secondaryUser,
          secondaryPass,
        );
        await orchestratorPo.openWorkflowInstance(workflowInstanceId);
        expect(
          await orchestratorPo.isWorkflowCompletedStatusVisible(),
        ).toBeFalsy();
      });

      test("Grant admin role and verify secondary user access", async ({}) => {
        await page.context().clearCookies();
        await page.goto("/");
        await loginAsKeycloakUserWithRetry(page, loginHelper);
        apiToken = await new AuthApiHelper(page).getToken();
        const rbacApi = await RbacApiHelper.build(apiToken);

        const rolePostResponse = await rbacApi.createRoles({
          memberReferences: [SECONDARY_USER],
          name: workflowAdminRoleName,
        });
        expect(rolePostResponse.ok()).toBeTruthy();
        const policyResponse = await rbacApi.createPolicies(
          buildPolicies(workflowAdminRoleName, [
            {
              permission: "orchestrator.workflow",
              policy: "read",
              effect: "allow",
            },
            {
              permission: "orchestrator.workflow.use",
              policy: "update",
              effect: "allow",
            },
            {
              permission: "orchestrator.instanceAdminView",
              policy: "read",
              effect: "allow",
            },
          ]),
        );
        expect(policyResponse.ok()).toBeTruthy();

        const roleUpdateResponse = await rbacApi.updateRole(
          roleApiName(workflowUserRoleName),
          {
            memberReferences: [PRIMARY_USER, SECONDARY_USER],
            name: workflowUserRoleName,
          },
          {
            memberReferences: [PRIMARY_USER],
            name: workflowUserRoleName,
          },
        );
        expect(roleUpdateResponse.ok()).toBeTruthy();

        const secondaryUser = process.env.GH_USER2_ID || "test2";
        const secondaryPass = process.env.GH_USER2_PASS || "test2@123";
        await page.context().clearCookies();
        await page.goto("/");
        await loginAsKeycloakUserWithRetry(
          page,
          loginHelper,
          secondaryUser,
          secondaryPass,
        );
        const orchestratorPo = createOrchestratorPO(page, uiHelper);
        await orchestratorPo.openWorkflowInstance(workflowInstanceId);
        await orchestratorPo.verifyWorkflowCompletedStatusVisible(
          WORKFLOW_INSTANCE_VISIBLE_TIMEOUT_MS,
        );
      });
    });

    test.describe("RHIDP-11839: Template run WITHOUT workflow permissions", () => {
      const getSession = registerTemplatePermissionRole(
        "role:default/catalogSuperuserNoWorkflowTest",
        "deny",
      );

      test("Validate RHIDP-11839 behavior", async ({}) => {
        test.setTimeout(180_000);
        const { page, orchestratorPo, apiToken } = getSession();
        await orchestratorPo.openGreetingTemplateFromCatalog();
        await page
          .getByRole("link", { name: "Launch Template" })
          .or(page.getByRole("button", { name: "Launch Template" }))
          .click();
        await page.waitForURL(/\/create\/templates\//, { timeout: 30_000 });
        await orchestratorPo.fillGreetingTemplateFormAndSubmit();
        await expectGreetingWorkflowDenied(page, apiToken);

        await orchestratorPo.openOrchestratorFromSidebar();
        await orchestratorPo.verifyWorkflowHidden("Greeting workflow");
        await expect(page).toHaveURL(/\/orchestrator/);
      });
    });

    test.describe("RHIDP-11840: Template run WITH workflow permissions", () => {
      const getSession = registerTemplatePermissionRole(
        "role:default/catalogSuperuserWithWorkflowTest",
        "allow",
      );

      test("Validate RHIDP-11840 behavior", async ({}) => {
        test.setTimeout(240_000);
        const { page, orchestratorPo } = getSession();
        await orchestratorPo.openGreetingTemplateFromSelfService();
        await orchestratorPo.fillGreetingTemplateFormAndSubmit();
        await expect(
          ORCHESTRATOR_COMPONENTS.openWorkflowRunLink(page),
        ).toHaveAttribute("href", /\/greeting\/[a-f0-9-]+$/i, {
          timeout: 120_000,
        });

        await orchestratorPo.openGreetingWorkflowFromSidebar();
        await orchestratorPo.verifyRunButtonState("enabled");
        await expect(page).toHaveURL(/\/orchestrator/);
      });
    });
  });
}
