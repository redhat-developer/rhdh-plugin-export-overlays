import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  RbacApiHelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { OrchestratorPO } from "../support/pages/orchestrator-po.js";
import {
  removeBaselineRole,
  setupAuthenticatedPage,
  deleteRoleAndPolicies,
  createRoleWithPolicies,
  verifyRoleWithPolicies,
  buildPolicies,
  globalWorkflowPolicies,
  greetingWorkflowPolicies,
  roleApiName,
  PRIMARY_USER,
  SECONDARY_USER,
  cleanupGreetingComponentEntity,
  launchGreetingTemplateFromSelfService,
  clickCreateAndWaitForScaffolderTerminalState,
} from "../support/utils/test-helpers.js";

type RbacScenario = {
  name: string;
  roleName: string;
  policies: ReturnType<typeof globalWorkflowPolicies>;
  expectWorkflowVisible: boolean;
  expectRunState: "enabled" | "disabled" | "absent" | "disabled-or-absent";
  workflowScope: "global" | "greeting";
};

const RBAC_SCENARIOS: RbacScenario[] = [
  {
    name: "Global Read-Write",
    roleName: "role:default/workflowReadwrite",
    policies: globalWorkflowPolicies("allow", "allow"),
    expectWorkflowVisible: true,
    expectRunState: "enabled",
    workflowScope: "global",
  },
  {
    name: "Global Read-Only",
    roleName: "role:default/workflowReadonly",
    policies: globalWorkflowPolicies("allow", "deny"),
    expectWorkflowVisible: true,
    expectRunState: "disabled-or-absent",
    workflowScope: "global",
  },
  {
    name: "Global Denied",
    roleName: "role:default/workflowDenied",
    policies: globalWorkflowPolicies("deny", "deny"),
    expectWorkflowVisible: false,
    expectRunState: "absent",
    workflowScope: "global",
  },
  {
    name: "Greeting Denied",
    roleName: "role:default/workflowGreetingDenied",
    policies: greetingWorkflowPolicies("deny", "deny"),
    expectWorkflowVisible: false,
    expectRunState: "absent",
    workflowScope: "greeting",
  },
  {
    name: "Greeting Read-Write",
    roleName: "role:default/workflowGreetingReadwrite",
    policies: greetingWorkflowPolicies("allow", "allow"),
    expectWorkflowVisible: true,
    expectRunState: "enabled",
    workflowScope: "greeting",
  },
  {
    name: "Greeting Read-Only",
    roleName: "role:default/workflowGreetingReadonly",
    policies: greetingWorkflowPolicies("allow", "deny"),
    expectWorkflowVisible: true,
    expectRunState: "disabled-or-absent",
    workflowScope: "greeting",
  },
];

async function assertRbacScenario(
  page: Page,
  uiHelper: UIhelper,
  scenario: RbacScenario,
): Promise<void> {
  const orchestratorPo = new OrchestratorPO(page, uiHelper);
  await page.reload();
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

async function loginAsKeycloakUserWithRetry(
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
        if (await userInput.isVisible({ timeout: 5_000 })) {
          await userInput.fill(resolvedUsername);
          await page.locator("#password").fill(resolvedPassword);
          await page.locator("#kc-login").click();
          await expect(page.locator("nav a").first()).toBeVisible({
            timeout: 15_000,
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

type TemplatePermissionScenario = {
  id: "RHIDP-11839" | "RHIDP-11840";
  name: string;
  roleName: string;
  orchestratorWorkflowEffect: "allow" | "deny";
  orchestratorWorkflowUseEffect: "allow" | "deny";
  expectWorkflowVisible: boolean;
  expectRunState: "enabled" | "absent";
  terminalTimeoutsMs: number[];
  testTimeoutMs: number;
};

const TEMPLATE_PERMISSION_BASE_POLICIES = [
  { permission: "catalog-entity", policy: "read", effect: "allow" as const },
  {
    permission: "catalog.entity.create",
    policy: "create",
    effect: "allow" as const,
  },
  {
    permission: "catalog.location.read",
    policy: "read",
    effect: "allow" as const,
  },
  {
    permission: "catalog.location.create",
    policy: "create",
    effect: "allow" as const,
  },
  {
    permission: "scaffolder.action.execute",
    policy: "use",
    effect: "allow" as const,
  },
  {
    permission: "scaffolder.task.create",
    policy: "create",
    effect: "allow" as const,
  },
  {
    permission: "scaffolder.task.read",
    policy: "read",
    effect: "allow" as const,
  },
];

const TEMPLATE_PERMISSION_SCENARIOS: TemplatePermissionScenario[] = [
  {
    id: "RHIDP-11839",
    name: "Template run WITHOUT workflow permissions",
    roleName: "role:default/catalogSuperuserNoWorkflowTest",
    orchestratorWorkflowEffect: "deny",
    orchestratorWorkflowUseEffect: "deny",
    expectWorkflowVisible: false,
    expectRunState: "absent",
    terminalTimeoutsMs: [120_000],
    testTimeoutMs: 180_000,
  },
  {
    id: "RHIDP-11840",
    name: "Template run WITH workflow permissions",
    roleName: "role:default/catalogSuperuserWithWorkflowTest",
    orchestratorWorkflowEffect: "allow",
    orchestratorWorkflowUseEffect: "allow",
    expectWorkflowVisible: true,
    expectRunState: "enabled",
    terminalTimeoutsMs: [90_000, 120_000],
    testTimeoutMs: 240_000,
  },
];

function buildTemplatePermissionPolicies(
  scenario: TemplatePermissionScenario,
): Array<{ permission: string; policy: string; effect: "allow" | "deny" }> {
  return [
    ...TEMPLATE_PERMISSION_BASE_POLICIES,
    {
      permission: "orchestrator.workflow",
      policy: "read",
      effect: scenario.orchestratorWorkflowEffect,
    },
    {
      permission: "orchestrator.workflow.use",
      policy: "update",
      effect: scenario.orchestratorWorkflowUseEffect,
    },
  ];
}

async function runGreetingTemplateAndWaitForScaffolderTerminal(
  page: Page,
  uiHelper: UIhelper,
  terminalTimeoutsMs: number[],
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < terminalTimeoutsMs.length; attempt++) {
    await launchGreetingTemplateFromSelfService(page, uiHelper);
    try {
      await clickCreateAndWaitForScaffolderTerminalState(
        page,
        terminalTimeoutsMs[attempt],
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt === terminalTimeoutsMs.length - 1) {
        throw error;
      }
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");
    }
  }
  throw lastError;
}

export function registerOrchestratorRbacTests(): void {
  test.describe("Orchestrator RBAC", () => {
    test.beforeAll(async ({ browser }, testInfo) => {
      await removeBaselineRole(browser, testInfo);
    });

    for (const scenario of RBAC_SCENARIOS) {
      test.describe(`RBAC: ${scenario.name}`, () => {
        let uiHelper: UIhelper;
        let page: Page;
        let apiToken: string;

        test.beforeAll(async ({ browser }, testInfo) => {
          ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
            browser,
            testInfo,
          ));
          await createRoleWithPolicies(
            apiToken,
            scenario.roleName,
            [PRIMARY_USER],
            scenario.policies,
          );
          await verifyRoleWithPolicies(
            apiToken,
            scenario.roleName,
            [PRIMARY_USER],
            scenario.policies,
          );
        });

        test.afterAll(async () => {
          await deleteRoleAndPolicies(apiToken, scenario.roleName);
        });

        test(`Validate ${scenario.name} workflow behavior`, async () => {
          await assertRbacScenario(page, uiHelper, scenario);
        });
      });
    }

    test.describe
      .serial("RBAC: Workflow instance initiator and admin override", () => {
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

        const rbacApi = await RbacApiHelper.build(apiToken);
        await rbacApi.createRoles({
          memberReferences: [PRIMARY_USER, SECONDARY_USER],
          name: workflowUserRoleName,
        });
        await rbacApi.createPolicies(
          buildPolicies(workflowUserRoleName, [
            {
              permission: "orchestrator.workflow.greeting",
              policy: "read",
              effect: "allow",
            },
            {
              permission: "orchestrator.workflow.use.greeting",
              policy: "update",
              effect: "allow",
            },
          ]),
        );
      });

      test.afterAll(async () => {
        await deleteRoleAndPolicies(apiToken, workflowAdminRoleName);
        await deleteRoleAndPolicies(apiToken, workflowUserRoleName);
      });

      test("Primary user runs greeting workflow and captures instance ID", async () => {
        const orchestratorPo = new OrchestratorPO(page, uiHelper);
        await orchestratorPo.openWorkflowsPage();
        await orchestratorPo.openWorkflow("Greeting workflow");
        await orchestratorPo.verifyRunButtonState("enabled");
        await page.getByRole("button", { name: "Run" }).click();
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByRole("button", { name: "Run" }).click();
        await page.waitForURL(/\/orchestrator\/instances\/[a-f0-9-]+/);
        const match = page
          .url()
          .match(/\/orchestrator\/instances\/([a-f0-9-]+)/);
        expect(match).not.toBeNull();
        workflowInstanceId = match![1];
      });

      test("Secondary user cannot access instance before admin grant", async () => {
        await page.context().clearCookies();
        await page.goto("/");
        await page.waitForLoadState("load");
        await loginAsKeycloakUserWithRetry(
          page,
          loginHelper,
          process.env.GH_USER2_ID || "test2",
          process.env.GH_USER2_PASS || "test2@123",
        );
        await uiHelper.goToPageUrl(
          `/orchestrator/instances/${workflowInstanceId}`,
        );
        const pageContent = await page.locator("body").textContent();
        expect(pageContent?.includes("Completed")).not.toBeTruthy();
      });

      test("Grant admin role and verify secondary user access", async () => {
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

        await page.context().clearCookies();
        await page.goto("/");
        await loginAsKeycloakUserWithRetry(
          page,
          loginHelper,
          process.env.GH_USER2_ID || "test2",
          process.env.GH_USER2_PASS || "test2@123",
        );
        await uiHelper.goToPageUrl(
          `/orchestrator/instances/${workflowInstanceId}`,
        );
        await expect(page.getByText("Completed", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
      });
    });

    for (const scenario of TEMPLATE_PERMISSION_SCENARIOS) {
      test.describe(`${scenario.id}: ${scenario.name}`, () => {
        let uiHelper: UIhelper;
        let page: Page;
        let apiToken: string;

        test.beforeAll(async ({ browser }, testInfo) => {
          ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
            browser,
            testInfo,
          ));
          await cleanupGreetingComponentEntity();
          await createRoleWithPolicies(
            apiToken,
            scenario.roleName,
            [PRIMARY_USER],
            buildTemplatePermissionPolicies(scenario),
          );
        });

        test.afterAll(async () => {
          await cleanupGreetingComponentEntity();
          await deleteRoleAndPolicies(apiToken, scenario.roleName);
        });

        test(`Validate ${scenario.id} behavior`, async () => {
          test.setTimeout(scenario.testTimeoutMs);
          const orchestratorPo = new OrchestratorPO(page, uiHelper);

          await runGreetingTemplateAndWaitForScaffolderTerminal(
            page,
            uiHelper,
            scenario.terminalTimeoutsMs,
          );
          await orchestratorPo.openOrchestratorFromSidebar();

          if (!scenario.expectWorkflowVisible) {
            await orchestratorPo.verifyWorkflowHidden("Greeting workflow");
            return;
          }

          await orchestratorPo.openWorkflow(/Greeting workflow/i);
          await orchestratorPo.verifyRunButtonState(scenario.expectRunState);
        });
      });
    }
  });
}
