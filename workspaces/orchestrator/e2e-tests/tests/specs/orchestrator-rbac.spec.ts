import { test, expect, Page } from "rhdh-e2e-test-utils/test";
import { $ } from "rhdh-e2e-test-utils/utils";
import {
  setupBrowser,
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  RbacApiHelper,
  Policy,
  Response,
} from "rhdh-e2e-test-utils/helpers";
import { OrchestratorPage } from "rhdh-e2e-test-utils/pages";
import path from "path";
import {
  removeBaselineRole,
  PRIMARY_USER,
  SECONDARY_USER,
} from "./rbac-baseline.js";

const sonataflowSetupScript = path.join(
  import.meta.dirname,
  "deploy-sonataflow.sh",
);

test.describe.serial("Test Orchestrator RBAC", () => {
  test.beforeAll(async ({ rhdh, browser }, testInfo) => {
    test.setTimeout(20 * 60 * 1000);
    await rhdh.configure({ namespace: "orchestrator" });
    await test.runOnce("orchestrator-setup", async () => {
      const project = rhdh.deploymentConfig.namespace;
      await rhdh.configure({ auth: "keycloak" });
      await $`bash ${sonataflowSetupScript} ${project}`;
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
    let loginHelper: LoginHelper;
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;

    test.beforeAll(async ({ browser }, testInfo) => {
      page = (await setupBrowser(browser, testInfo)).page;

      uiHelper = new UIhelper(page);
      loginHelper = new LoginHelper(page);

      await loginHelper.loginAsKeycloakUser();
      apiToken = await new AuthApiHelper(page).getToken();
    });

    test.beforeEach(async ({}, testInfo) => {
      console.log(
        `beforeEach: Attempting setup for ${testInfo.title}, retry: ${testInfo.retry}`,
      );
    });

    test("Create role with global orchestrator.workflow read and update permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);
      const members = [PRIMARY_USER];

      const orchestratorRole = {
        memberReferences: members,
        name: "role:default/workflowReadwrite",
      };

      const orchestratorPolicies = [
        {
          entityReference: "role:default/workflowReadwrite",
          permission: "orchestrator.workflow",
          policy: "read",
          effect: "allow",
        },
        {
          entityReference: "role:default/workflowReadwrite",
          permission: "orchestrator.workflow.use",
          policy: "update",
          effect: "allow",
        },
      ];

      const rolePostResponse =
        await rbacApi.createRoles(orchestratorRole);
      const policyPostResponse =
        await rbacApi.createPolicies(orchestratorPolicies);

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
          role.name === "role:default/workflowReadwrite",
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse =
        await rbacApi.getPoliciesByRole("workflowReadwrite");
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const readPolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow" &&
          policy.policy === "read",
      );
      const updatePolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.use" &&
          policy.policy === "update",
      );

      expect(readPolicy).toBeDefined();
      expect(updatePolicy).toBeDefined();
      expect(readPolicy.effect).toBe("allow");
      expect(updatePolicy.effect).toBe("allow");
    });

    test("Test global orchestrator workflow access is allowed", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      const orchestrator = new OrchestratorPage(page);
      await orchestrator.selectGreetingWorkflowItem();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      // Verify the Run button is visible and enabled (read+update permissions)
      const runButton = page.getByRole("button", { name: "Run" });
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeEnabled();

      // Click the Run button to verify permission works
      await runButton.click();
    });

    test.afterAll(async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      try {
        const remainingPoliciesResponse =
          await rbacApi.getPoliciesByRole("workflowReadwrite");

        const remainingPolicies = await Response.removeMetadataFromResponse(
          remainingPoliciesResponse,
        );

        const deleteRemainingPolicies = await rbacApi.deletePolicy(
          "workflowReadwrite",
          remainingPolicies as Policy[],
        );

        const deleteRole =
          await rbacApi.deleteRole("workflowReadwrite");

        expect(deleteRemainingPolicies.ok()).toBeTruthy();
        expect(deleteRole.ok()).toBeTruthy();
      } catch (error) {
        console.error("Error during cleanup in afterAll:", error);
      }
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Global Workflow Read-Only Access", () => {
    test.describe.configure({ retries: 0 });
    let loginHelper: LoginHelper;
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;

    test.beforeAll(async ({ browser }, testInfo) => {
      page = (await setupBrowser(browser, testInfo)).page;

      uiHelper = new UIhelper(page);
      loginHelper = new LoginHelper(page);

      await loginHelper.loginAsKeycloakUser();
      apiToken = await new AuthApiHelper(page).getToken();
    });

    test.beforeEach(async ({}, testInfo) => {
      console.log(
        `beforeEach: Attempting setup for ${testInfo.title}, retry: ${testInfo.retry}`,
      );
    });

    test("Create role with global orchestrator.workflow read-only permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);
      const members = [PRIMARY_USER];

      const orchestratorReadonlyRole = {
        memberReferences: members,
        name: "role:default/workflowReadonly",
      };

      const orchestratorReadonlyPolicies = [
        {
          entityReference: "role:default/workflowReadonly",
          permission: "orchestrator.workflow",
          policy: "read",
          effect: "allow",
        },
        {
          entityReference: "role:default/workflowReadonly",
          permission: "orchestrator.workflow.use",
          policy: "update",
          effect: "deny",
        },
      ];

      const rolePostResponse = await rbacApi.createRoles(
        orchestratorReadonlyRole,
      );
      const policyPostResponse = await rbacApi.createPolicies(
        orchestratorReadonlyPolicies,
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
          role.name === "role:default/workflowReadonly",
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse =
        await rbacApi.getPoliciesByRole("workflowReadonly");
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const readPolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow" &&
          policy.policy === "read",
      );
      const denyUpdatePolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.use" &&
          policy.policy === "update",
      );

      expect(readPolicy).toBeDefined();
      expect(denyUpdatePolicy).toBeDefined();
      expect(readPolicy.effect).toBe("allow");
      expect(denyUpdatePolicy.effect).toBe("deny");
    });

    test("Test global orchestrator workflow read-only access - Run button disabled", async () => {
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
        // Button doesn't exist - valid for read-only access
        // eslint-disable-next-line playwright/no-conditional-expect
        expect(buttonCount).toBe(0);
      } else {
        // Button exists - it should be disabled
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(runButton).toBeDisabled();
      }
    });

    test.afterAll(async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      try {
        const remainingPoliciesResponse =
          await rbacApi.getPoliciesByRole("workflowReadonly");

        const remainingPolicies = await Response.removeMetadataFromResponse(
          remainingPoliciesResponse,
        );

        const deleteRemainingPolicies = await rbacApi.deletePolicy(
          "workflowReadonly",
          remainingPolicies as Policy[],
        );

        const deleteRole = await rbacApi.deleteRole("workflowReadonly");

        expect(deleteRemainingPolicies.ok()).toBeTruthy();
        expect(deleteRole.ok()).toBeTruthy();
      } catch (error) {
        console.error("Error during cleanup in afterAll:", error);
      }
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Global Workflow Denied Access", () => {
    test.describe.configure({ retries: 0 });
    let loginHelper: LoginHelper;
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;

    test.beforeAll(async ({ browser }, testInfo) => {
      page = (await setupBrowser(browser, testInfo)).page;

      uiHelper = new UIhelper(page);
      loginHelper = new LoginHelper(page);

      await loginHelper.loginAsKeycloakUser();
      apiToken = await new AuthApiHelper(page).getToken();
    });

    test.beforeEach(async ({}, testInfo) => {
      console.log(
        `beforeEach: Attempting setup for ${testInfo.title}, retry: ${testInfo.retry}`,
      );
    });

    test("Create role with global orchestrator.workflow denied permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);
      const members = [PRIMARY_USER];

      const orchestratorDeniedRole = {
        memberReferences: members,
        name: "role:default/workflowDenied",
      };

      const orchestratorDeniedPolicies = [
        {
          entityReference: "role:default/workflowDenied",
          permission: "orchestrator.workflow",
          policy: "read",
          effect: "deny",
        },
        {
          entityReference: "role:default/workflowDenied",
          permission: "orchestrator.workflow.use",
          policy: "update",
          effect: "deny",
        },
      ];

      const rolePostResponse = await rbacApi.createRoles(
        orchestratorDeniedRole,
      );
      const policyPostResponse = await rbacApi.createPolicies(
        orchestratorDeniedPolicies,
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
          role.name === "role:default/workflowDenied",
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse =
        await rbacApi.getPoliciesByRole("workflowDenied");
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const denyReadPolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow" &&
          policy.policy === "read",
      );
      const denyUpdatePolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.use" &&
          policy.policy === "update",
      );

      expect(denyReadPolicy).toBeDefined();
      expect(denyUpdatePolicy).toBeDefined();
      expect(denyReadPolicy.effect).toBe("deny");
      expect(denyUpdatePolicy.effect).toBe("deny");
    });

    test("Test global orchestrator workflow denied access - no workflows visible", async () => {
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

    test.afterAll(async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      try {
        const remainingPoliciesResponse =
          await rbacApi.getPoliciesByRole("workflowDenied");

        const remainingPolicies = await Response.removeMetadataFromResponse(
          remainingPoliciesResponse,
        );

        const deleteRemainingPolicies = await rbacApi.deletePolicy(
          "workflowDenied",
          remainingPolicies as Policy[],
        );

        const deleteRole = await rbacApi.deleteRole("workflowDenied");

        expect(deleteRemainingPolicies.ok()).toBeTruthy();
        expect(deleteRole.ok()).toBeTruthy();
      } catch (error) {
        console.error("Error during cleanup in afterAll:", error);
      }
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Individual Workflow Denied Access", () => {
    test.describe.configure({ retries: 0 });
    let loginHelper: LoginHelper;
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;

    test.beforeAll(async ({ browser }, testInfo) => {
      page = (await setupBrowser(browser, testInfo)).page;

      uiHelper = new UIhelper(page);
      loginHelper = new LoginHelper(page);

      await loginHelper.loginAsKeycloakUser();
      apiToken = await new AuthApiHelper(page).getToken();
    });

    test.beforeEach(async ({}, testInfo) => {
      console.log(
        `beforeEach: Attempting setup for ${testInfo.title}, retry: ${testInfo.retry}`,
      );
    });

    test("Create role with greeting workflow denied permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);
      const members = [PRIMARY_USER];

      const greetingDeniedRole = {
        memberReferences: members,
        name: "role:default/workflowGreetingDenied",
      };

      const greetingDeniedPolicies = [
        {
          entityReference: "role:default/workflowGreetingDenied",
          permission: "orchestrator.workflow.greeting",
          policy: "read",
          effect: "deny",
        },
        {
          entityReference: "role:default/workflowGreetingDenied",
          permission: "orchestrator.workflow.use.greeting",
          policy: "update",
          effect: "deny",
        },
      ];

      const rolePostResponse =
        await rbacApi.createRoles(greetingDeniedRole);
      const policyPostResponse = await rbacApi.createPolicies(
        greetingDeniedPolicies,
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
          role.name === "role:default/workflowGreetingDenied",
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        "workflowGreetingDenied",
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const denyReadPolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.greeting" &&
          policy.policy === "read",
      );
      const denyUpdatePolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.use.greeting" &&
          policy.policy === "update",
      );

      expect(denyReadPolicy).toBeDefined();
      expect(denyUpdatePolicy).toBeDefined();
      expect(denyReadPolicy.effect).toBe("deny");
      expect(denyUpdatePolicy.effect).toBe("deny");
    });

    test("Test individual workflow denied access - no workflows visible", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      // Greeting workflow should not be visible (denied by individual permission)
      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toHaveCount(0);

      // Other workflows also not visible (no global allow)
      const userOnboardingLink = page.getByRole("link", {
        name: "User Onboarding",
      });
      await expect(userOnboardingLink).toHaveCount(0);

      await uiHelper.verifyTableIsEmpty();
    });

    test.afterAll(async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      try {
        const remainingPoliciesResponse = await rbacApi.getPoliciesByRole(
          "workflowGreetingDenied",
        );

        const remainingPolicies = await Response.removeMetadataFromResponse(
          remainingPoliciesResponse,
        );

        const deleteRemainingPolicies = await rbacApi.deletePolicy(
          "workflowGreetingDenied",
          remainingPolicies as Policy[],
        );

        const deleteRole = await rbacApi.deleteRole(
          "workflowGreetingDenied",
        );

        expect(deleteRemainingPolicies.ok()).toBeTruthy();
        expect(deleteRole.ok()).toBeTruthy();
      } catch (error) {
        console.error("Error during cleanup in afterAll:", error);
      }
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Individual Workflow Read-Write Access", () => {
    test.describe.configure({ retries: 0 });
    let loginHelper: LoginHelper;
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;

    test.beforeAll(async ({ browser }, testInfo) => {
      page = (await setupBrowser(browser, testInfo)).page;

      uiHelper = new UIhelper(page);
      loginHelper = new LoginHelper(page);

      await loginHelper.loginAsKeycloakUser();
      apiToken = await new AuthApiHelper(page).getToken();
    });

    test.beforeEach(async ({}, testInfo) => {
      console.log(
        `beforeEach: Attempting setup for ${testInfo.title}, retry: ${testInfo.retry}`,
      );
    });

    test("Create role with greeting workflow read-write permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);
      const members = [PRIMARY_USER];

      const greetingReadwriteRole = {
        memberReferences: members,
        name: "role:default/workflowGreetingReadwrite",
      };

      const greetingReadwritePolicies = [
        {
          entityReference: "role:default/workflowGreetingReadwrite",
          permission: "orchestrator.workflow.greeting",
          policy: "read",
          effect: "allow",
        },
        {
          entityReference: "role:default/workflowGreetingReadwrite",
          permission: "orchestrator.workflow.use.greeting",
          policy: "update",
          effect: "allow",
        },
      ];

      const rolePostResponse = await rbacApi.createRoles(
        greetingReadwriteRole,
      );
      const policyPostResponse = await rbacApi.createPolicies(
        greetingReadwritePolicies,
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
          role.name === "role:default/workflowGreetingReadwrite",
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        "workflowGreetingReadwrite",
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const allowReadPolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.greeting" &&
          policy.policy === "read",
      );
      const allowUpdatePolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.use.greeting" &&
          policy.policy === "update",
      );

      expect(allowReadPolicy).toBeDefined();
      expect(allowUpdatePolicy).toBeDefined();
      expect(allowReadPolicy.effect).toBe("allow");
      expect(allowUpdatePolicy.effect).toBe("allow");
    });

    test("Test individual workflow read-write access - only Greeting workflow visible and runnable", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      // Only Greeting workflow should be visible (allowed by individual permission)
      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toBeVisible();

      // Other workflows should not be visible (no global permissions)
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

    test.afterAll(async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      try {
        const remainingPoliciesResponse = await rbacApi.getPoliciesByRole(
          "workflowGreetingReadwrite",
        );

        const remainingPolicies = await Response.removeMetadataFromResponse(
          remainingPoliciesResponse,
        );

        const deleteRemainingPolicies = await rbacApi.deletePolicy(
          "workflowGreetingReadwrite",
          remainingPolicies as Policy[],
        );

        const deleteRole = await rbacApi.deleteRole(
          "workflowGreetingReadwrite",
        );

        expect(deleteRemainingPolicies.ok()).toBeTruthy();
        expect(deleteRole.ok()).toBeTruthy();
      } catch (error) {
        console.error("Error during cleanup in afterAll:", error);
      }
    });
  });

  test.describe
    .serial("Test Orchestrator RBAC: Individual Workflow Read-Only Access", () => {
    test.describe.configure({ retries: 0 });
    let loginHelper: LoginHelper;
    let uiHelper: UIhelper;
    let page: Page;
    let apiToken: string;

    test.beforeAll(async ({ browser }, testInfo) => {
      page = (await setupBrowser(browser, testInfo)).page;

      uiHelper = new UIhelper(page);
      loginHelper = new LoginHelper(page);

      await loginHelper.loginAsKeycloakUser();
      apiToken = await new AuthApiHelper(page).getToken();
    });

    test.beforeEach(async ({}, testInfo) => {
      console.log(
        `beforeEach: Attempting setup for ${testInfo.title}, retry: ${testInfo.retry}`,
      );
    });

    test("Create role with greeting workflow read-only permissions", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);
      const members = [PRIMARY_USER];

      const greetingReadonlyRole = {
        memberReferences: members,
        name: "role:default/workflowGreetingReadonly",
      };

      const greetingReadonlyPolicies = [
        {
          entityReference: "role:default/workflowGreetingReadonly",
          permission: "orchestrator.workflow.greeting",
          policy: "read",
          effect: "allow",
        },
        {
          entityReference: "role:default/workflowGreetingReadonly",
          permission: "orchestrator.workflow.use.greeting",
          policy: "update",
          effect: "deny",
        },
      ];

      const rolePostResponse = await rbacApi.createRoles(
        greetingReadonlyRole,
      );
      const policyPostResponse = await rbacApi.createPolicies(
        greetingReadonlyPolicies,
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
          role.name === "role:default/workflowGreetingReadonly",
      );
      expect(workflowRole).toBeDefined();
      expect(workflowRole?.memberReferences).toContain(PRIMARY_USER);

      const policiesResponse = await rbacApi.getPoliciesByRole(
        "workflowGreetingReadonly",
      );
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const allowReadPolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.greeting" &&
          policy.policy === "read",
      );
      const denyUpdatePolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.use.greeting" &&
          policy.policy === "update",
      );

      expect(allowReadPolicy).toBeDefined();
      expect(denyUpdatePolicy).toBeDefined();
      expect(allowReadPolicy.effect).toBe("allow");
      expect(denyUpdatePolicy.effect).toBe("deny");
    });

    test("Test individual workflow read-only access - only Greeting workflow visible, Run button disabled", async () => {
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      await uiHelper.verifyHeading("Workflows");

      // Only Greeting workflow should be visible (allowed by individual permission)
      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toBeVisible();

      // Other workflows should not be visible (no global permissions)
      const userOnboardingLink = page.getByRole("link", {
        name: "User Onboarding",
      });
      await expect(userOnboardingLink).toHaveCount(0);

      // Navigate to Greeting workflow and verify Run button is disabled/not visible
      await greetingWorkflowLink.click();
      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      // For read-only access, the button should either not exist or be disabled
      const runButton = page.getByRole("button", { name: "Run" });
      const buttonCount = await runButton.count();

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (buttonCount === 0) {
        // Button doesn't exist - valid for read-only access
        // eslint-disable-next-line playwright/no-conditional-expect
        expect(buttonCount).toBe(0);
      } else {
        // Button exists - it should be disabled
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(runButton).toBeDisabled();
      }
    });

    test.afterAll(async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);

      try {
        const remainingPoliciesResponse = await rbacApi.getPoliciesByRole(
          "workflowGreetingReadonly",
        );

        const remainingPolicies = await Response.removeMetadataFromResponse(
          remainingPoliciesResponse,
        );

        const deleteRemainingPolicies = await rbacApi.deletePolicy(
          "workflowGreetingReadonly",
          remainingPolicies as Policy[],
        );

        const deleteRole = await rbacApi.deleteRole(
          "workflowGreetingReadonly",
        );

        expect(deleteRemainingPolicies.ok()).toBeTruthy();
        expect(deleteRole.ok()).toBeTruthy();
      } catch (error) {
        console.error("Error during cleanup in afterAll:", error);
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
      page = (await setupBrowser(browser, testInfo)).page;

      uiHelper = new UIhelper(page);
      loginHelper = new LoginHelper(page);

      await loginHelper.loginAsKeycloakUser();
      apiToken = await new AuthApiHelper(page).getToken();

      // Clean up any lingering roles from previous test runs
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

          console.log(
            `Found ${lingeringRoles.length} lingering roles to clean up`,
          );

          for (const role of lingeringRoles) {
            try {
              console.log(`Cleaning up lingering role: ${role.name}`);
              const roleNameForApi = role.name
                .replace("role:", "")
                .replace("default/", "");
              const policiesResponse =
                await rbacApi.getPoliciesByRole(roleNameForApi);
              if (policiesResponse.ok()) {
                const policies =
                  await Response.removeMetadataFromResponse(policiesResponse);
                await rbacApi.deletePolicy(
                  roleNameForApi,
                  policies as Policy[],
                );
              }
              await rbacApi.deleteRole(roleNameForApi);
              console.log(`Successfully cleaned up role: ${role.name}`);
            } catch (error) {
              console.log(
                `Error cleaning up lingering role ${role.name}: ${error}`,
              );
            }
          }
        }
      } catch (error) {
        console.log("Error during pre-test cleanup:", error);
      }
    });

    test.beforeEach(async ({}, testInfo) => {
      console.log(
        `beforeEach: Attempting setup for ${testInfo.title}, retry: ${testInfo.retry}`,
      );
    });

    /** Deletes a role and its policies if it exists, swallowing errors. */
    async function deleteRoleIfExists(
      rbacApi: RbacApiHelper,
      roleName: string,
    ) {
      try {
        const roleNameForApi = roleName
          .replace("role:", "")
          .replace("default/", "");
        const rolesResponse = await rbacApi.getRoles();
        if (rolesResponse.ok()) {
          const roles = await rolesResponse.json();
          const existingRole = roles.find(
            (role: { name: string }) => role.name === roleName,
          );

          if (existingRole) {
            console.log(`Deleting existing role: ${roleName}`);
            const policiesResponse =
              await rbacApi.getPoliciesByRole(roleNameForApi);
            if (policiesResponse.ok()) {
              const policies =
                await Response.removeMetadataFromResponse(policiesResponse);
              await rbacApi.deletePolicy(
                roleNameForApi,
                policies as Policy[],
              );
            }
            await rbacApi.deleteRole(roleNameForApi);
            console.log(`Successfully deleted role: ${roleName}`);
          }
        }
      } catch (error) {
        console.log(`Error deleting role ${roleName}: ${error}`);
      }
    }

    test("Clean up any existing workflowUser role", async () => {
      workflowUserRoleName = `role:default/workflowUser`;
      const rbacApi = await RbacApiHelper.build(apiToken);
      await deleteRoleIfExists(rbacApi, workflowUserRoleName);
    });

    test("Create role with greeting workflow read-write permissions for both users", async () => {
      const rbacApi = await RbacApiHelper.build(apiToken);
      const members = [PRIMARY_USER, SECONDARY_USER];

      // Workflow-specific permissions for greeting workflow
      // Note: Users can always see their own workflow instances (initiator-based access)
      // without needing orchestrator.instanceAdminView permission
      workflowUserRoleName = `role:default/workflowUser`;

      const workflowUserRole = {
        memberReferences: members,
        name: workflowUserRoleName,
      };

      const workflowUserPolicies = [
        {
          entityReference: workflowUserRoleName,
          permission: "orchestrator.workflow.greeting",
          policy: "read",
          effect: "allow",
        },
        {
          entityReference: workflowUserRoleName,
          permission: "orchestrator.workflow.use.greeting",
          policy: "update",
          effect: "allow",
        },
      ];

      const rolePostResponse =
        await rbacApi.createRoles(workflowUserRole);
      const policyPostResponse =
        await rbacApi.createPolicies(workflowUserPolicies);

      const roleOk = rolePostResponse.ok();
      const policyOk = policyPostResponse.ok();

      const roleStatus = rolePostResponse.status();
      const policyStatus = policyPostResponse.status();

      console.log(`Role creation status: ${roleStatus}`);
      console.log(`Policy creation status: ${policyStatus}`);

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!roleOk) {
        const errorBody = await rolePostResponse.text();
        console.log(`Role creation error body: ${errorBody}`);
      }
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!policyOk) {
        const errorBody = await policyPostResponse.text();
        console.log(`Policy creation error body: ${errorBody}`);
      }

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
      expect(workflowRole?.memberReferences).toContain(
        SECONDARY_USER,
      );

      const roleNameForApi = workflowUserRoleName
        .replace("role:", "")
        .replace("default/", "");
      const policiesResponse =
        await rbacApi.getPoliciesByRole(roleNameForApi);
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(2);

      const allowReadPolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.greeting" &&
          policy.policy === "read",
      );
      const allowUpdatePolicy = policies.find(
        (policy: { permission: string; policy: string; effect: string }) =>
          policy.permission === "orchestrator.workflow.use.greeting" &&
          policy.policy === "update",
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
      console.log(`Captured workflow instance ID: ${workflowInstanceId}`);

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

      console.log(
        `Verified access to workflow instance: ${workflowInstanceId}`,
      );
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
        console.log("Successfully logged in as secondary user");
      } catch (error) {
        console.log("Login failed, user might already be logged in:", error);
      }

      // Try to directly access primary user's workflow instance
      // This should be denied due to instance isolation
      await uiHelper.goToPageUrl(
        `/orchestrator/instances/${workflowInstanceId}`,
      );
      await page.waitForLoadState("load");

      // Secondary user should NOT be able to see the instance details
      const pageContent = await page.textContent("body");
      console.log(
        `Page content when accessing instance: ${pageContent?.substring(0, 500)}`,
      );

      const hasAccessDenied =
        pageContent?.includes("not found") ||
        pageContent?.includes("Not Found") ||
        pageContent?.includes("denied") ||
        pageContent?.includes("unauthorized") ||
        pageContent?.includes("Unauthorized") ||
        !pageContent?.includes("Completed");

      expect(hasAccessDenied).toBe(true);
    });

    test("Clean up any existing workflowAdmin role", async () => {
      workflowAdminRoleName = `role:default/workflowAdmin`;
      const rbacApi = await RbacApiHelper.build(apiToken);
      await deleteRoleIfExists(rbacApi, workflowAdminRoleName);
    });

    test("Create workflow admin role and update secondary user membership", async () => {
      // Set role names in case running individual tests
      workflowUserRoleName = `role:default/workflowUser`;
      workflowAdminRoleName = `role:default/workflowAdmin`;

      await page.context().clearCookies();
      await page.goto("/");
      await page.waitForLoadState("load");

      try {
        await loginHelper.loginAsKeycloakUser();
        console.log("Successfully logged in as primary user");
      } catch (error) {
        console.log("Login failed:", error);
        throw error;
      }
      apiToken = await new AuthApiHelper(page).getToken();

      const rbacApi = await RbacApiHelper.build(apiToken);

      const members = [PRIMARY_USER, SECONDARY_USER];
      const workflowUserRole = {
        memberReferences: members,
        name: workflowUserRoleName,
      };

      const workflowUserPolicies = [
        {
          entityReference: workflowUserRoleName,
          permission: "orchestrator.workflow.greeting",
          policy: "read",
          effect: "allow",
        },
        {
          entityReference: workflowUserRoleName,
          permission: "orchestrator.workflow.use.greeting",
          policy: "update",
          effect: "allow",
        },
      ];

      try {
        await rbacApi.createRoles(workflowUserRole);
        await rbacApi.createPolicies(workflowUserPolicies);
        console.log(
          "Created workflowUser role and policies for individual test run",
        );
      } catch (error) {
        console.log(
          "workflowUser role already exists or creation failed (expected for serial runs):",
          error,
        );
      }

      // Create workflowAdmin role with secondary user as member
      const workflowAdminRole = {
        memberReferences: [SECONDARY_USER],
        name: workflowAdminRoleName,
      };

      // Admin policies: global workflow access + instanceAdminView to see ALL instances
      const workflowAdminPolicies = [
        {
          entityReference: workflowAdminRoleName,
          permission: "orchestrator.workflow",
          policy: "read",
          effect: "allow",
        },
        {
          entityReference: workflowAdminRoleName,
          permission: "orchestrator.workflow.use",
          policy: "update",
          effect: "allow",
        },
        {
          entityReference: workflowAdminRoleName,
          permission: "orchestrator.instanceAdminView",
          policy: "read",
          effect: "allow",
        },
      ];

      const rolePostResponse =
        await rbacApi.createRoles(workflowAdminRole);
      const policyPostResponse = await rbacApi.createPolicies(
        workflowAdminPolicies,
      );

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();

      // Wait a moment for the role changes to take effect
      await page.waitForTimeout(2000);

      // Update workflowUser role to remove secondary user
      const oldWorkflowUserRole = {
        memberReferences: [PRIMARY_USER, SECONDARY_USER],
        name: workflowUserRoleName,
      };
      const updatedWorkflowUserRole = {
        memberReferences: [PRIMARY_USER],
        name: workflowUserRoleName,
      };

      const roleNameForApi = workflowUserRoleName
        .replace("role:", "")
        .replace("default/", "");
      console.log(`Updating role: ${roleNameForApi}`);
      const roleUpdateResponse = await rbacApi.updateRole(
        roleNameForApi,
        oldWorkflowUserRole,
        updatedWorkflowUserRole,
      );

      const roleUpdateOk = roleUpdateResponse.ok();

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!roleUpdateOk) {
        console.log(
          `Role update failed with status: ${roleUpdateResponse.status()}`,
        );
        const errorBody = await roleUpdateResponse.text();
        console.log(`Role update error body: ${errorBody}`);
      }

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

      const adminRoleNameForApi = workflowAdminRoleName
        .replace("role:", "")
        .replace("default/", "");
      const policiesResponse =
        await rbacApi.getPoliciesByRole(adminRoleNameForApi);
      expect(policiesResponse.ok()).toBeTruthy();

      const policies = await policiesResponse.json();
      expect(policies).toHaveLength(3);

      const workflowUserRole = roles.find(
        (role: { name: string; memberReferences: string[] }) =>
          role.name === workflowUserRoleName,
      );
      expect(workflowUserRole).toBeDefined();
      expect(workflowUserRole?.memberReferences).toContain(
        PRIMARY_USER,
      );
      expect(workflowUserRole?.memberReferences).not.toContain(
        SECONDARY_USER,
      );
    });

    test("Secondary user with instanceAdminView CAN access primary user's workflow instance", async () => {
      await page.context().clearCookies();
      await page.goto("/");
      await page.waitForLoadState("load");

      // Login as secondary user who now has instanceAdminView permission
      try {
        await loginHelper.loginAsKeycloakUser(
          process.env.GH_USER2_ID || "test2",
          process.env.GH_USER2_PASS || "test2@123",
        );
        console.log(
          "Successfully logged in as secondary user with admin permissions",
        );
      } catch (error) {
        console.log("Login failed:", error);
        throw error;
      }

      // Navigate to primary user's workflow instance - should now be accessible
      // With instanceAdminView, secondary user can see ALL instances
      await uiHelper.goToPageUrl(
        `/orchestrator/instances/${workflowInstanceId}`,
      );
      await page.waitForLoadState("load");

      await expect(page.getByText("Completed", { exact: true })).toBeVisible({
        timeout: 30000,
      });

      console.log(
        `Admin (secondary) user successfully accessed workflow instance: ${workflowInstanceId}`,
      );
    });

    test.afterAll(async () => {
      try {
        await page.goto("/");
        await page.context().clearCookies();

        // Login as primary user to perform cleanup
        try {
          await loginHelper.loginAsKeycloakUser();
          apiToken = await new AuthApiHelper(page).getToken();
        } catch (error) {
          console.log("Login failed during cleanup, continuing:", error);
          return;
        }

        const rbacApi = await RbacApiHelper.build(apiToken);

        // Delete workflowUser role and policies
        if (workflowUserRoleName) {
          try {
            const workflowUserRoleNameForApi = workflowUserRoleName
              .replace("role:", "")
              .replace("default/", "");
            const workflowUserPoliciesResponse =
              await rbacApi.getPoliciesByRole(workflowUserRoleNameForApi);

            if (workflowUserPoliciesResponse.ok()) {
              const workflowUserPolicies =
                await Response.removeMetadataFromResponse(
                  workflowUserPoliciesResponse,
                );

              await rbacApi.deletePolicy(
                workflowUserRoleNameForApi,
                workflowUserPolicies as Policy[],
              );

              await rbacApi.deleteRole(workflowUserRoleNameForApi);

              console.log(
                `Cleaned up workflowUser role: ${workflowUserRoleNameForApi}`,
              );
            }
          } catch (error) {
            console.log(`Error cleaning up workflowUser role: ${error}`);
          }
        }

        // Delete workflowAdmin role and policies
        if (workflowAdminRoleName) {
          try {
            const workflowAdminRoleNameForApi = workflowAdminRoleName
              .replace("role:", "")
              .replace("default/", "");
            const workflowAdminPoliciesResponse =
              await rbacApi.getPoliciesByRole(workflowAdminRoleNameForApi);

            if (workflowAdminPoliciesResponse.ok()) {
              const workflowAdminPolicies =
                await Response.removeMetadataFromResponse(
                  workflowAdminPoliciesResponse,
                );

              await rbacApi.deletePolicy(
                workflowAdminRoleNameForApi,
                workflowAdminPolicies as Policy[],
              );

              await rbacApi.deleteRole(workflowAdminRoleNameForApi);

              console.log(
                `Cleaned up workflowAdmin role: ${workflowAdminRoleNameForApi}`,
              );
            }
          } catch (error) {
            console.log(`Error cleaning up workflowAdmin role: ${error}`);
          }
        }
      } catch (error) {
        console.error("Error during cleanup in afterAll:", error);
      }
    });
  });
});
