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
} from "./test-helpers.js";

type RbacScenario = {
  name: string;
  roleName: string;
  policies: ReturnType<typeof globalWorkflowPolicies>;
  expectWorkflowVisible: boolean;
  expectRunState: "enabled" | "disabled" | "absent";
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
    expectRunState: "disabled",
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
    expectRunState: "disabled",
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

test.describe.serial("Orchestrator RBAC", () => {
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

  test.describe("RBAC: Workflow instance initiator and admin override", () => {
    let loginHelper: LoginHelper;
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    let workflowInstanceId = "";
    const workflowUserRoleName = "role:default/workflowUser";
    const workflowAdminRoleName = "role:default/workflowAdmin";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, loginHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
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
      const match = page.url().match(/\/orchestrator\/instances\/([a-f0-9-]+)/);
      expect(match).not.toBeNull();
      workflowInstanceId = match![1];
    });

    test("Secondary user cannot access instance before admin grant", async () => {
      await page.context().clearCookies();
      await page.goto("/");
      await page.waitForLoadState("load");
      await loginHelper.loginAsKeycloakUser(
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
      await loginHelper.loginAsKeycloakUser();
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
      await loginHelper.loginAsKeycloakUser(
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

  test.describe("RHIDP-11839: Template run WITHOUT workflow permissions", () => {
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/catalogSuperuserNoWorkflowTest";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
      await cleanupGreetingComponentEntity();
      await createRoleWithPolicies(
        apiToken,
        roleName,
        [PRIMARY_USER],
        [
          { permission: "catalog-entity", policy: "read", effect: "allow" },
          {
            permission: "catalog.entity.create",
            policy: "create",
            effect: "allow",
          },
          {
            permission: "catalog.location.read",
            policy: "read",
            effect: "allow",
          },
          {
            permission: "catalog.location.create",
            policy: "create",
            effect: "allow",
          },
          {
            permission: "scaffolder.action.execute",
            policy: "use",
            effect: "allow",
          },
          {
            permission: "scaffolder.task.create",
            policy: "create",
            effect: "allow",
          },
          {
            permission: "scaffolder.task.read",
            policy: "read",
            effect: "allow",
          },
          {
            permission: "orchestrator.workflow",
            policy: "read",
            effect: "deny",
          },
          {
            permission: "orchestrator.workflow.use",
            policy: "update",
            effect: "deny",
          },
        ],
      );
    });

    test.afterAll(async () => {
      await cleanupGreetingComponentEntity();
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Template launch is denied without workflow permissions", async () => {
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await orchestratorPo.openGreetingTemplateFromSelfService();
      await clickCreateAndWaitForScaffolderTerminalState(page, 120_000);
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestratorPo.verifyWorkflowHidden("Greeting workflow");
    });
  });

  test.describe("RHIDP-11840: Template run WITH workflow permissions", () => {
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/catalogSuperuserWithWorkflowTest";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
      await cleanupGreetingComponentEntity();
      await createRoleWithPolicies(
        apiToken,
        roleName,
        [PRIMARY_USER],
        [
          { permission: "catalog-entity", policy: "read", effect: "allow" },
          {
            permission: "catalog.entity.create",
            policy: "create",
            effect: "allow",
          },
          {
            permission: "catalog.location.read",
            policy: "read",
            effect: "allow",
          },
          {
            permission: "catalog.location.create",
            policy: "create",
            effect: "allow",
          },
          {
            permission: "scaffolder.action.execute",
            policy: "use",
            effect: "allow",
          },
          {
            permission: "scaffolder.task.create",
            policy: "create",
            effect: "allow",
          },
          {
            permission: "scaffolder.task.read",
            policy: "read",
            effect: "allow",
          },
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
        ],
      );
    });

    test.afterAll(async () => {
      await cleanupGreetingComponentEntity();
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Launch template and run workflow successfully", async () => {
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      test.setTimeout(240_000);

      let completed = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        await launchGreetingTemplateFromSelfService(page, uiHelper);
        try {
          await clickCreateAndWaitForScaffolderTerminalState(
            page,
            attempt === 1 ? 90_000 : 120_000,
          );
          completed = true;
          break;
        } catch (error) {
          if (attempt === 2) {
            throw error;
          }
          await page.goto("/");
          await page.waitForLoadState("domcontentloaded");
        }
      }

      expect(completed).toBeTruthy();
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestratorPo.openWorkflow(/Greeting workflow/i);
      await orchestratorPo.verifyRunButtonState("enabled");
    });
  });
});
