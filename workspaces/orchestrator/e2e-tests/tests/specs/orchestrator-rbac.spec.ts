import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  RbacApiHelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import {
  removeBaselineRole,
  setupAuthenticatedPage,
  deleteRoleAndPolicies,
  buildPolicies,
  roleApiName,
  PRIMARY_USER,
  SECONDARY_USER,
} from "./rbac-baseline.js";
import { deploySonataflow } from "./deploy-sonataflow.js";

test.describe.serial("Test Orchestrator RBAC", () => {
  test.beforeAll(async ({ rhdh, browser }, testInfo) => {
    test.setTimeout(20 * 60 * 1000);
    await rhdh.configure({ namespace: "orchestrator" });
    await test.runOnce("orchestrator-setup", async () => {
      const project = rhdh.deploymentConfig.namespace;
      await rhdh.configure({ auth: "keycloak" });
      await deploySonataflow(project);
      process.env.SONATAFLOW_DATA_INDEX_URL =
        "http://sonataflow-platform-data-index-service";
      await rhdh.deploy({ timeout: null });
    });
    await removeBaselineRole(browser, testInfo);
    testInfo.annotations.push({
      type: "component",
      description: "orchestrator",
    });
  });

  test.describe.serial("Test Orchestrator RBAC: Global Workflow Access", () => {
    test.describe.configure({ retries: 0 });
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/workflowReadwrite";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Create role with global orchestrator.workflow read and update permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
        buildPolicies(roleName, [
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
        ]),
      );

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
    });

    test("Verify role exists via API", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolesResponse = await rbacApi.getRoles();
      expect(rolesResponse.ok()).toBeTruthy();

      const roles = await rolesResponse.json();
      const workflowRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === roleName,
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        roleApiName(roleName),
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const readPolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow" && p.policy === "read",
      );
      const updatePolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.use" && p.policy === "update",
      );

      expect(readPolicy).toBeDefined();
      expect(updatePolicy).toBeDefined();
      expect(readPolicy.effect).toBe("allow");
      expect(updatePolicy.effect).toBe("allow");
    });

    test("Verify global orchestrator workflow access is allowed", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      const orchestrator = new OrchestratorPage(page);
      await orchestrator.selectGreetingWorkflowItem();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      const runButton = page.getByRole("button", { name: "Run" });
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeEnabled();

      await runButton.click();
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Global Workflow Read-Only Access", () => {
    test.describe.configure({ retries: 0 });
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/workflowReadonly";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Create role with global orchestrator.workflow read-only permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
        buildPolicies(roleName, [
          {
            permission: "orchestrator.workflow",
            policy: "read",
            effect: "allow",
          },
          {
            permission: "orchestrator.workflow.use",
            policy: "update",
            effect: "deny",
          },
        ]),
      );

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
    });

    test("Verify read-only role exists via API", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolesResponse = await rbacApi.getRoles();
      expect(rolesResponse.ok()).toBeTruthy();

      const roles = await rolesResponse.json();
      const workflowRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === roleName,
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        roleApiName(roleName),
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const readPolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow" && p.policy === "read",
      );
      const denyUpdatePolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.use" && p.policy === "update",
      );

      expect(readPolicy).toBeDefined();
      expect(denyUpdatePolicy).toBeDefined();
      expect(readPolicy.effect).toBe("allow");
      expect(denyUpdatePolicy.effect).toBe("deny");
    });

    test("Verify global orchestrator workflow read-only access - Run button disabled", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      const orchestrator = new OrchestratorPage(page);
      await orchestrator.selectGreetingWorkflowItem();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      // For read-only access, the button should either not exist or be disabled
      const runButton = page.getByRole("button", { name: "Run" });

      const buttonCount = await runButton.count();

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (buttonCount === 0) {
        // eslint-disable-next-line playwright/no-conditional-expect
        expect(buttonCount).toBe(0);
      } else {
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(runButton).toBeDisabled();
      }
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Global Workflow Denied Access", () => {
    test.describe.configure({ retries: 0 });
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/workflowDenied";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Create role with global orchestrator.workflow denied permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
        buildPolicies(roleName, [
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
        ]),
      );

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
    });

    test("Verify denied role exists via API", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolesResponse = await rbacApi.getRoles();
      expect(rolesResponse.ok()).toBeTruthy();

      const roles = await rolesResponse.json();
      const workflowRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === roleName,
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        roleApiName(roleName),
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const denyReadPolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow" && p.policy === "read",
      );
      const denyUpdatePolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.use" && p.policy === "update",
      );

      expect(denyReadPolicy).toBeDefined();
      expect(denyUpdatePolicy).toBeDefined();
      expect(denyReadPolicy.effect).toBe("deny");
      expect(denyUpdatePolicy.effect).toBe("deny");
    });

    test("Verify global orchestrator workflow denied access - no workflows visible", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      // With denied access, the workflows table should be empty
      await uiHelper.verifyTableIsEmpty();

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toHaveCount(0);
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Individual Workflow Denied Access", () => {
    test.describe.configure({ retries: 0 });
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/workflowGreetingDenied";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Create role with greeting workflow denied permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
        buildPolicies(roleName, [
          {
            permission: "orchestrator.workflow.greeting",
            policy: "read",
            effect: "deny",
          },
          {
            permission: "orchestrator.workflow.use.greeting",
            policy: "update",
            effect: "deny",
          },
        ]),
      );

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
    });

    test("Verify greeting workflow denied role exists via API", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolesResponse = await rbacApi.getRoles();
      expect(rolesResponse.ok()).toBeTruthy();

      const roles = await rolesResponse.json();
      const workflowRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === roleName,
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        roleApiName(roleName),
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const denyReadPolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.greeting" &&
          p.policy === "read",
      );
      const denyUpdatePolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.use.greeting" &&
          p.policy === "update",
      );

      expect(denyReadPolicy).toBeDefined();
      expect(denyUpdatePolicy).toBeDefined();
      expect(denyReadPolicy.effect).toBe("deny");
      expect(denyUpdatePolicy.effect).toBe("deny");
    });

    test("Verify individual workflow denied access - no workflows visible", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toHaveCount(0);

      const userOnboardingLink = page.getByRole("link", {
        name: "User Onboarding",
      });
      await expect(userOnboardingLink).toHaveCount(0);

      await uiHelper.verifyTableIsEmpty();
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Individual Workflow Read-Write Access", () => {
    test.describe.configure({ retries: 0 });
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/workflowGreetingReadwrite";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Create role with greeting workflow read-write permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
        buildPolicies(roleName, [
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

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
    });

    test("Verify greeting workflow read-write role exists via API", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolesResponse = await rbacApi.getRoles();
      expect(rolesResponse.ok()).toBeTruthy();

      const roles = await rolesResponse.json();
      const workflowRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === roleName,
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        roleApiName(roleName),
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const allowReadPolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.greeting" &&
          p.policy === "read",
      );
      const allowUpdatePolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.use.greeting" &&
          p.policy === "update",
      );

      expect(allowReadPolicy).toBeDefined();
      expect(allowUpdatePolicy).toBeDefined();
      expect(allowReadPolicy.effect).toBe("allow");
      expect(allowUpdatePolicy.effect).toBe("allow");
    });

    test("Verify individual workflow read-write access - only Greeting workflow visible and runnable", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toBeVisible();

      const userOnboardingLink = page.getByRole("link", {
        name: "User Onboarding",
      });
      await expect(userOnboardingLink).toHaveCount(0);

      await greetingWorkflowLink.click();
      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      const runButton = page.getByRole("button", { name: "Run" });
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeEnabled();
      await runButton.click();
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Individual Workflow Read-Only Access", () => {
    test.describe.configure({ retries: 0 });
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/workflowGreetingReadonly";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Create role with greeting workflow read-only permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
        buildPolicies(roleName, [
          {
            permission: "orchestrator.workflow.greeting",
            policy: "read",
            effect: "allow",
          },
          {
            permission: "orchestrator.workflow.use.greeting",
            policy: "update",
            effect: "deny",
          },
        ]),
      );

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
    });

    test("Verify greeting workflow read-only role exists via API", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolesResponse = await rbacApi.getRoles();
      expect(rolesResponse.ok()).toBeTruthy();

      const roles = await rolesResponse.json();
      const workflowRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === roleName,
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        roleApiName(roleName),
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const allowReadPolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.greeting" &&
          p.policy === "read",
      );
      const denyUpdatePolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.use.greeting" &&
          p.policy === "update",
      );

      expect(allowReadPolicy).toBeDefined();
      expect(denyUpdatePolicy).toBeDefined();
      expect(allowReadPolicy.effect).toBe("allow");
      expect(denyUpdatePolicy.effect).toBe("deny");
    });

    test("Verify individual workflow read-only access - only Greeting workflow visible, Run button disabled", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toBeVisible();

      const userOnboardingLink = page.getByRole("link", {
        name: "User Onboarding",
      });
      await expect(userOnboardingLink).toHaveCount(0);

      await greetingWorkflowLink.click();
      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      const runButton = page.getByRole("button", { name: "Run" });
      const buttonCount = await runButton.count();

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (buttonCount === 0) {
        // eslint-disable-next-line playwright/no-conditional-expect
        expect(buttonCount).toBe(0);
      } else {
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(runButton).toBeDisabled();
      }
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Workflow Instance Initiator Access and Admin Override", () => {
    test.describe.configure({ retries: 0 });
    let loginHelper: LoginHelper;
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    let workflowInstanceId: string;
    let workflowUserRoleName: string;
    let workflowAdminRoleName: string;

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, loginHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));

      const rbacApi = await RbacApiHelper.build(apiToken);
      try {
        const rolesResponse = await rbacApi.getRoles();
        if (rolesResponse.ok()) {
          const roles = await rolesResponse.json();
          const lingeringRoles = roles.filter(
            (role: { name: string }) =>
              role.name.includes("workflowUser") ||
              role.name.includes("workflowAdmin"),
          );

          for (const role of lingeringRoles) {
            await deleteRoleAndPolicies(apiToken, role.name);
          }
        }
      } catch {
        /* ignore cleanup errors */
      }
    });

    test.afterAll(async () => {
      try {
        await page.goto("/");
        await page.context().clearCookies();

        try {
          await loginHelper.loginAsKeycloakUser();
          apiToken = await new AuthApiHelper(page).getToken();
        } catch {
          return;
        }

        if (workflowUserRoleName) {
          await deleteRoleAndPolicies(apiToken, workflowUserRoleName);
        }
        if (workflowAdminRoleName) {
          await deleteRoleAndPolicies(apiToken, workflowAdminRoleName);
        }
      } catch (error) {
        console.error("Error during cleanup in afterAll:", error);
      }
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Clean up any existing workflowUser role", async () => {
      workflowUserRoleName = "role:default/workflowUser";
      await deleteRoleAndPolicies(apiToken, workflowUserRoleName);
    });

    test("Create role with greeting workflow read-write permissions for both users", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      // Users can always see their own workflow instances (initiator-based access)
      // without needing orchestrator.instanceAdminView permission
      workflowUserRoleName = "role:default/workflowUser";

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER, SECONDARY_USER],
        name: workflowUserRoleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
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

      const roleOk = rolePostResponse.ok();
      const policyOk = policyPostResponse.ok();

      expect(roleOk).toBeTruthy();
      expect(policyOk).toBeTruthy();
    });

    test("Verify workflow user role exists via API with both users", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolesResponse = await rbacApi.getRoles();
      expect(rolesResponse.ok()).toBeTruthy();

      const roles = await rolesResponse.json();
      const workflowRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === workflowUserRoleName,
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);
      expect(workflowRole?.memberReferences).toContain(SECONDARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        roleApiName(workflowUserRoleName),
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const allowReadPolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.greeting" &&
          p.policy === "read",
      );
      const allowUpdatePolicy = policies.find(
        (p: { permission: string; policy: string; effect: string }) =>
          p.permission === "orchestrator.workflow.use.greeting" &&
          p.policy === "update",
      );

      expect(allowReadPolicy).toBeDefined();
      expect(allowUpdatePolicy).toBeDefined();
      expect(allowReadPolicy.effect).toBe("allow");
      expect(allowUpdatePolicy.effect).toBe("allow");
    });

    test("Primary user runs greeting workflow and captures instance ID", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toBeVisible();
      await greetingWorkflowLink.click();
      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      const runButton = page.getByRole("button", { name: "Run" });
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeEnabled();
      await runButton.click();

      const nextButton = page.getByRole("button", { name: "Next" });
      await expect(nextButton).toBeVisible();
      await nextButton.click();

      const finalRunButton = page.getByRole("button", { name: "Run" });
      await expect(finalRunButton).toBeVisible();
      await finalRunButton.click();

      await page.waitForURL(/\/orchestrator\/instances\/[a-f0-9-]+/);
      const url = page.url();
      const match = url.match(/\/orchestrator\/instances\/([a-f0-9-]+)/);
      expect(match).not.toBeNull();
      workflowInstanceId = match![1];

      await expect(page.getByText(/Run completed at/i)).toBeVisible({
        timeout: 30000,
      });
    });

    test("Primary user can see their workflow instance", async () => {
      await uiHelper.goToPageUrl(
        `/orchestrator/instances/${workflowInstanceId}`,
      );

      await page.waitForLoadState("load");

      await expect(page.getByText("Completed", { exact: true })).toBeVisible({
        timeout: 30000,
      });
    });

    test("Secondary user cannot access primary user's workflow instance", async () => {
      await page.context().clearCookies();
      await page.goto("/");
      await page.waitForLoadState("load");

      try {
        await loginHelper.loginAsKeycloakUser(
          process.env.GH_USER2_ID || "test2",
          process.env.GH_USER2_PASS || "test2@123",
        );
      } catch {
        // ignore
      }

      await uiHelper.goToPageUrl(
        `/orchestrator/instances/${workflowInstanceId}`,
      );
      await page.waitForLoadState("load");

      const pageContent = await page.locator("body").textContent();

      const hasAccessDenied =
        pageContent?.includes("not found") ||
        pageContent?.includes("Not Found") ||
        pageContent?.includes("denied") ||
        pageContent?.includes("unauthorized") ||
        pageContent?.includes("Unauthorized") ||
        !pageContent?.includes("Completed");

      expect(hasAccessDenied).toBe(true);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Clean up any existing workflowAdmin role", async () => {
      workflowAdminRoleName = "role:default/workflowAdmin";
      await deleteRoleAndPolicies(apiToken, workflowAdminRoleName);
    });

    test("Create workflow admin role and update secondary user membership", async () => {
      // Set role names in case running individual tests
      workflowUserRoleName = "role:default/workflowUser";
      workflowAdminRoleName = "role:default/workflowAdmin";

      await page.context().clearCookies();
      await page.goto("/");
      await page.waitForLoadState("load");

      await loginHelper.loginAsKeycloakUser();
      apiToken = await new AuthApiHelper(page).getToken();

      const rbacApi = await RbacApiHelper.build(apiToken);

      try {
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
      } catch {
        /* workflowUser may already exist (serial runs) */
      }

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [SECONDARY_USER],
        name: workflowAdminRoleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
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

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();

      // eslint-disable-next-line playwright/no-wait-for-timeout
      await page.waitForTimeout(2000);

      const oldWorkflowUserRole = {
        memberReferences: [PRIMARY_USER, SECONDARY_USER],
        name: workflowUserRoleName,
      };
      const updatedWorkflowUserRole = {
        memberReferences: [PRIMARY_USER],
        name: workflowUserRoleName,
      };

      const roleUpdateResponse = await rbacApi.updateRole(
        roleApiName(workflowUserRoleName),
        oldWorkflowUserRole,
        updatedWorkflowUserRole,
      );

      const roleUpdateOk = roleUpdateResponse.ok();

      expect(roleUpdateOk).toBeTruthy();
    });

    test("Verify workflow admin role exists and secondary user is removed from workflowUser", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolesResponse = await rbacApi.getRoles();
      expect(rolesResponse.ok()).toBeTruthy();

      const roles = await rolesResponse.json();
      const adminRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === workflowAdminRoleName,
      );
      expect(adminRole).toBeDefined();
      expect(adminRole?.memberReferences).toContain(SECONDARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        roleApiName(workflowAdminRoleName),
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(3);

      const workflowUserRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === workflowUserRoleName,
      );
      expect(workflowUserRole).toBeDefined();
      expect(workflowUserRole?.memberReferences).toContain(PRIMARY_USER);
      expect(workflowUserRole?.memberReferences).not.toContain(SECONDARY_USER);
    });

    test("Secondary user with instanceAdminView CAN access primary user's workflow instance", async () => {
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
      await page.waitForLoadState("load");

      await expect(page.getByText("Completed", { exact: true })).toBeVisible({
        timeout: 30000,
      });
    });
  });

  /**
   * Entity-Workflow RBAC Tests
   *
   * Test Cases: RHIDP-11839, RHIDP-11840
   *
   * These tests verify the RBAC boundary between template execution and
   * workflow execution in the context of entity-workflow integration.
   *
   * Templates used (from catalog locations):
   * - greeting_w_component.yaml: name=greetingComponent, title="Greeting Test Picker" - HAS annotation
   */
  test.describe
    .serial("RHIDP-11839: Template run WITHOUT workflow permissions", () => {
    test.describe.configure({ retries: 0 });
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/catalogSuperuserNoWorkflowTest";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Setup: Create role with catalog+scaffolder but NO orchestrator permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
        buildPolicies(roleName, [
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
          // Explicitly DENY orchestrator permissions
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
        ]),
      );

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
    });

    test("Navigate to Catalog and find orchestrator-tagged template", async () => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading(/Catalog|All/);
      await uiHelper.selectMuiBox("Kind", "Template");

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByRole("heading").first()).toBeVisible();
    });

    test("Launch template and attempt to run workflow - verify unauthorized", async () => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");
      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      // Template goes straight to Review step with just a Create button
      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      await createButton.click();

      // Template execution should succeed, but workflow execution should be denied
      // eslint-disable-next-line playwright/no-wait-for-timeout
      await page.waitForTimeout(10000);

      const errorIndicators = [
        page.getByText(/unauthorized/i),
        page.getByText(/denied/i),
        page.getByText(/permission/i),
        page.getByText(/forbidden/i),
        page.getByText(/failed/i),
      ];

      let hasError = false;
      for (const indicator of errorIndicators) {
        // eslint-disable-next-line playwright/no-conditional-in-test
        if ((await indicator.count()) > 0) {
          hasError = true;
          break;
        }
      }

      // If no explicit error, verify workflow is not accessible in Orchestrator
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!hasError) {
        await uiHelper.openSidebar("Orchestrator");
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(
          page.getByRole("heading", { name: "Workflows" }),
        ).toBeVisible();

        const greetingWorkflow = page.getByRole("link", {
          name: "Greeting workflow",
        });
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(greetingWorkflow).toHaveCount(0);
      }
    });
  });

  test.describe
    .serial("RHIDP-11840: Template run WITH workflow permissions", () => {
    test.describe.configure({ retries: 0 });
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;
    const roleName = "role:default/catalogSuperuserWithWorkflowTest";

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ page, uiHelper, apiToken } = await setupAuthenticatedPage(
        browser,
        testInfo,
      ));
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });

    test("Setup: Create role with catalog+scaffolder+orchestrator permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      const policyPostResponse = await rbacApi.createPolicies(
        buildPolicies(roleName, [
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
          // Orchestrator permissions - ALLOW
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
        ]),
      );

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
    });

    test("Navigate to Catalog and find orchestrator-tagged template", async () => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading(/Catalog|All/);
      await uiHelper.selectMuiBox("Kind", "Template");

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByRole("heading").first()).toBeVisible();
    });

    test("Launch template and run workflow - verify success", async () => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");

      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      await createButton.click();

      // Accept success or 409 Conflict (entity already registered from a prior run)
      const completed = page.getByText(/Completed|succeeded|finished/i);
      const conflictError = page.getByText(/409 Conflict/i);
      const startOver = page.getByRole("button", { name: "Start Over" });

      await expect(completed.or(conflictError).or(startOver)).toBeVisible({
        timeout: 120000,
      });
    });

    test("Verify workflow run appears in Orchestrator", async () => {
      await uiHelper.openSidebar("Orchestrator");
      await expect(
        page.getByRole("heading", { name: "Workflows" }),
      ).toBeVisible();

      const greetingWorkflow = page.getByRole("link", {
        name: /Greeting workflow/i,
      });
      await expect(greetingWorkflow).toBeVisible({ timeout: 30000 });

      await greetingWorkflow.click();

      await expect(
        page.getByRole("heading", { name: /Greeting workflow/i }),
      ).toBeVisible();

      const runButton = page.getByRole("button", { name: "Run" });
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeEnabled();
    });
  });
});
