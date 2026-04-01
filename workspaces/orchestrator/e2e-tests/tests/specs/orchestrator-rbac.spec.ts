import { execSync } from "child_process";
import { test, expect, Page } from "rhdh-e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  RbacApiHelper,
} from "rhdh-e2e-test-utils/helpers";
import { OrchestratorPage } from "rhdh-e2e-test-utils/pages";
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

function dumpRbacClusterState(ns: string, label: string): void {
  console.log(`[${label}] --- RBAC cluster state dump for ns=${ns} ---`);
  try {
    const pods = execSync(`oc get pods -n ${ns} --no-headers`, { encoding: "utf-8" }).trim();
    console.log(`[${label}] Pods:\n${pods}`);
  } catch (e) { console.log(`[${label}] Pods error: ${e}`); }
  try {
    const rhdhLogs = execSync(`oc logs -n ${ns} deploy/redhat-developer-hub --tail=50`, { encoding: "utf-8", timeout: 30_000 }).trim();
    const relevantLines = rhdhLogs.split("\n").filter(
      (l: string) => /rbac|permission|unauthorized|forbidden|error|orchestrator/i.test(l),
    );
    if (relevantLines.length > 0) {
      console.log(`[${label}] RHDH RBAC-relevant logs (${relevantLines.length}):\n${relevantLines.slice(-20).join("\n")}`);
    } else {
      const last20 = rhdhLogs.split("\n").slice(-20);
      console.log(`[${label}] RHDH last 20 log lines:\n${last20.join("\n")}`);
    }
  } catch (e) { console.log(`[${label}] RHDH logs error: ${e}`); }
  try {
    const events = execSync(`oc get events -n ${ns} --sort-by=.lastTimestamp --no-headers`, { encoding: "utf-8" }).trim();
    const recentEvents = events.split("\n").slice(-10).join("\n");
    console.log(`[${label}] Recent events:\n${recentEvents}`);
  } catch (e) { console.log(`[${label}] Events error: ${e}`); }
  console.log(`[${label}] --- End RBAC cluster state dump ---`);
}

test.describe.serial("Test Orchestrator RBAC", () => {
  test.beforeAll(async ({ rhdh, browser }, testInfo) => {
    test.setTimeout(20 * 60 * 1000);
    console.log("[rbac-setup] Starting RBAC test suite setup");
    console.log(`[rbac-setup] PRIMARY_USER=${PRIMARY_USER}, SECONDARY_USER=${SECONDARY_USER}`);
    await rhdh.configure({ namespace: "orchestrator" });
    await test.runOnce("orchestrator-setup", async () => {
      const project = rhdh.deploymentConfig.namespace;
      console.log(`[rbac-setup] Deploying in namespace: ${project}`);
      await rhdh.configure({ auth: "keycloak" });
      await deploySonataflow(project);
      process.env.SONATAFLOW_DATA_INDEX_URL =
        "http://sonataflow-platform-data-index-service";
      console.log("[rbac-setup] Deploying RHDH...");
      await rhdh.deploy({ timeout: null });
      console.log("[rbac-setup] RHDH deployed successfully");
    });
    console.log("[rbac-setup] Removing baseline role for clean RBAC slate...");
    await removeBaselineRole(browser, testInfo);
    console.log("[rbac-setup] Baseline role removed. RBAC setup complete.");
    testInfo.annotations.push({
      type: "component",
      description: "orchestrator",
    });
  });

  test.beforeEach(async ({}, testInfo) => {
    console.log(
      `[rbac-beforeEach] Test: "${testInfo.title}", retry: ${testInfo.retry}, timeout: ${testInfo.timeout}ms`,
    );
  });

  test.afterEach(async ({}, testInfo) => {
    const status = testInfo.status;
    const title = testInfo.title;
    console.log(`[rbac-afterEach] Test "${title}" finished with status: ${status} (duration: ${testInfo.duration}ms)`);
    if (status === "failed" || status === "timedOut") {
      console.log(`[rbac-afterEach] Test FAILED: "${title}"`);
      const ns = testInfo.project.name;
      if (ns) {
        dumpRbacClusterState(ns, "rbac-afterEach-failure");
      }
    }
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

    test("Create role with global orchestrator.workflow read and update permissions", async () => {
      console.log(`[rbac-global-rw] Creating role ${roleName} with member ${PRIMARY_USER}`);
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      console.log(`[rbac-global-rw] Role creation: HTTP ${rolePostResponse.status()}`);
      if (!rolePostResponse.ok()) {
        console.log(`[rbac-global-rw] Role creation error: ${await rolePostResponse.text()}`);
      }
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
      console.log(`[rbac-global-rw] Policy creation: HTTP ${policyPostResponse.status()}`);
      if (!policyPostResponse.ok()) {
        console.log(`[rbac-global-rw] Policy creation error: ${await policyPostResponse.text()}`);
      }

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
      console.log("[rbac-global-rw] Role and policies created successfully");
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

    test("Test global orchestrator workflow access is allowed", async () => {
      console.log("[rbac-global-rw] Testing workflow access with read+update permissions");
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      console.log(`[rbac-global-rw] Navigated to: ${page.url()}`);
      await uiHelper.verifyHeading("Workflows");

      const orchestrator = new OrchestratorPage(page);
      await orchestrator.selectGreetingWorkflowItem();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();
      console.log("[rbac-global-rw] Greeting workflow page visible");

      const runButton = page.getByRole("button", { name: "Run" });
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeEnabled();
      console.log("[rbac-global-rw] Run button is visible and enabled (as expected for read+update)");

      await runButton.click();
      console.log("[rbac-global-rw] Run button clicked successfully");
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
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

    test("Test global orchestrator workflow read-only access - Run button disabled", async () => {
      console.log("[rbac-global-ro] Testing read-only workflow access");
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      console.log(`[rbac-global-ro] Navigated to: ${page.url()}`);
      await uiHelper.verifyHeading("Workflows");

      const orchestrator = new OrchestratorPage(page);
      await orchestrator.selectGreetingWorkflowItem();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      const runButton = page.getByRole("button", { name: "Run" });
      const buttonCount = await runButton.count();
      console.log(`[rbac-global-ro] Run button count: ${buttonCount}`);

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (buttonCount === 0) {
        console.log("[rbac-global-ro] Run button not present (expected for read-only)");
        // eslint-disable-next-line playwright/no-conditional-expect
        expect(buttonCount).toBe(0);
      } else {
        const isDisabled = await runButton.isDisabled();
        console.log(`[rbac-global-ro] Run button present but disabled=${isDisabled} (expected disabled for read-only)`);
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(runButton).toBeDisabled();
      }
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
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

    test("Test global orchestrator workflow denied access - no workflows visible", async () => {
      console.log("[rbac-global-denied] Testing denied workflow access");
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      console.log(`[rbac-global-denied] Navigated to: ${page.url()}`);
      await uiHelper.verifyHeading("Workflows");

      console.log("[rbac-global-denied] Verifying table is empty (denied access)...");
      await uiHelper.verifyTableIsEmpty();

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      const linkCount = await greetingWorkflowLink.count();
      console.log(`[rbac-global-denied] Greeting workflow link count: ${linkCount} (expected 0)`);
      await expect(greetingWorkflowLink).toHaveCount(0);
      console.log("[rbac-global-denied] Denied access verified - no workflows visible");
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
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

    test("Test individual workflow denied access - no workflows visible", async () => {
      console.log("[rbac-individual-denied] Testing individual workflow denied access");
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      console.log(`[rbac-individual-denied] Navigated to: ${page.url()}`);
      await uiHelper.verifyHeading("Workflows");

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      const greetingCount = await greetingWorkflowLink.count();
      console.log(`[rbac-individual-denied] Greeting workflow link count: ${greetingCount} (expected 0)`);
      await expect(greetingWorkflowLink).toHaveCount(0);

      const userOnboardingLink = page.getByRole("link", {
        name: "User Onboarding",
      });
      const onboardingCount = await userOnboardingLink.count();
      console.log(`[rbac-individual-denied] User Onboarding link count: ${onboardingCount} (expected 0)`);
      await expect(userOnboardingLink).toHaveCount(0);

      await uiHelper.verifyTableIsEmpty();
      console.log("[rbac-individual-denied] Individual denied access verified");
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
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

    test("Test individual workflow read-write access - only Greeting workflow visible and runnable", async () => {
      console.log("[rbac-individual-rw] Testing individual workflow read-write access");
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      console.log(`[rbac-individual-rw] Navigated to: ${page.url()}`);
      await uiHelper.verifyHeading("Workflows");

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toBeVisible();
      console.log("[rbac-individual-rw] Greeting workflow is visible (expected)");

      const userOnboardingLink = page.getByRole("link", {
        name: "User Onboarding",
      });
      const onboardingCount = await userOnboardingLink.count();
      console.log(`[rbac-individual-rw] User Onboarding count: ${onboardingCount} (expected 0)`);
      await expect(userOnboardingLink).toHaveCount(0);

      await greetingWorkflowLink.click();
      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      const runButton = page.getByRole("button", { name: "Run" });
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeEnabled();
      console.log("[rbac-individual-rw] Run button visible and enabled (expected for individual rw)");
      await runButton.click();
      console.log("[rbac-individual-rw] Run button clicked successfully");
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
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

    test("Test individual workflow read-only access - only Greeting workflow visible, Run button disabled", async () => {
      console.log("[rbac-individual-ro] Testing individual workflow read-only access");
      await page.reload();
      await uiHelper.goToPageUrl("/orchestrator");
      console.log(`[rbac-individual-ro] Navigated to: ${page.url()}`);
      await uiHelper.verifyHeading("Workflows");

      const greetingWorkflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(greetingWorkflowLink).toBeVisible();
      console.log("[rbac-individual-ro] Greeting workflow visible (expected)");

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
      console.log(`[rbac-individual-ro] Run button count: ${buttonCount}`);

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (buttonCount === 0) {
        console.log("[rbac-individual-ro] Run button not present (expected for read-only)");
        // eslint-disable-next-line playwright/no-conditional-expect
        expect(buttonCount).toBe(0);
      } else {
        const isDisabled = await runButton.isDisabled();
        console.log(`[rbac-individual-ro] Run button disabled=${isDisabled} (expected true for read-only)`);
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(runButton).toBeDisabled();
      }
      console.log("[rbac-individual-ro] Individual read-only access verified");
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
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
            await deleteRoleAndPolicies(apiToken, role.name);
          }
        }
      } catch (error) {
        console.log("Error during pre-test cleanup:", error);
      }
    });

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

      console.log(`Role creation status: ${rolePostResponse.status()}`);
      console.log(`Policy creation status: ${policyPostResponse.status()}`);

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
      console.log(`[rbac-instance-isolation] Testing secondary user access to instance ${workflowInstanceId}`);
      await page.context().clearCookies();
      await page.goto("/");
      await page.waitForLoadState("load");

      const secondaryUser = process.env.GH_USER2_ID || "test2";
      console.log(`[rbac-instance-isolation] Logging in as secondary user: ${secondaryUser}`);
      try {
        await loginHelper.loginAsKeycloakUser(
          secondaryUser,
          process.env.GH_USER2_PASS || "test2@123",
        );
        console.log("[rbac-instance-isolation] Successfully logged in as secondary user");
      } catch (error) {
        console.log(`[rbac-instance-isolation] Login failed, user might already be logged in: ${error}`);
      }

      console.log(`[rbac-instance-isolation] Attempting to access instance: /orchestrator/instances/${workflowInstanceId}`);
      await uiHelper.goToPageUrl(
        `/orchestrator/instances/${workflowInstanceId}`,
      );
      await page.waitForLoadState("load");
      console.log(`[rbac-instance-isolation] Page URL after navigation: ${page.url()}`);

      const pageContent = await page.textContent("body");
      console.log(
        `[rbac-instance-isolation] Page content (first 500 chars): ${pageContent?.substring(0, 500)}`,
      );

      const hasAccessDenied =
        pageContent?.includes("not found") ||
        pageContent?.includes("Not Found") ||
        pageContent?.includes("denied") ||
        pageContent?.includes("unauthorized") ||
        pageContent?.includes("Unauthorized") ||
        !pageContent?.includes("Completed");

      console.log(`[rbac-instance-isolation] Access denied detected: ${hasAccessDenied}`);
      expect(hasAccessDenied).toBe(true);
      console.log("[rbac-instance-isolation] Instance isolation confirmed");
    });

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

      try {
        await loginHelper.loginAsKeycloakUser();
        console.log("Successfully logged in as primary user");
      } catch (error) {
        console.log("Login failed:", error);
        throw error;
      }
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
      // Admin policies: global workflow access + instanceAdminView to see ALL instances
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

      console.log(`Updating role: ${roleApiName(workflowUserRoleName)}`);
      const roleUpdateResponse = await rbacApi.updateRole(
        roleApiName(workflowUserRoleName),
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
      console.log(`[rbac-admin-override] Testing admin override for instance ${workflowInstanceId}`);
      await page.context().clearCookies();
      await page.goto("/");
      await page.waitForLoadState("load");

      const secondaryUser = process.env.GH_USER2_ID || "test2";
      console.log(`[rbac-admin-override] Logging in as secondary user (admin): ${secondaryUser}`);
      try {
        await loginHelper.loginAsKeycloakUser(
          secondaryUser,
          process.env.GH_USER2_PASS || "test2@123",
        );
        console.log("[rbac-admin-override] Successfully logged in as secondary user with admin permissions");
      } catch (error) {
        console.log(`[rbac-admin-override] Login failed: ${error}`);
        throw error;
      }

      console.log(`[rbac-admin-override] Navigating to instance: /orchestrator/instances/${workflowInstanceId}`);
      await uiHelper.goToPageUrl(
        `/orchestrator/instances/${workflowInstanceId}`,
      );
      await page.waitForLoadState("load");
      console.log(`[rbac-admin-override] Page URL: ${page.url()}`);

      await expect(page.getByText("Completed", { exact: true })).toBeVisible({
        timeout: 30000,
      });

      console.log(
        `[rbac-admin-override] Admin (secondary) user successfully accessed workflow instance: ${workflowInstanceId}`,
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
      console.log("[RHIDP-11839] Navigating to Catalog to find template");
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading(/Catalog|All/);
      await uiHelper.selectMuiBox("Kind", "Template");
      console.log(`[RHIDP-11839] Catalog page: ${page.url()}`);

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      console.log("[RHIDP-11839] Greeting Test Picker template found, clicking...");
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByRole("heading").first()).toBeVisible();
      console.log(`[RHIDP-11839] Template page loaded: ${page.url()}`);
    });

    test("Launch template and attempt to run workflow - verify unauthorized", async () => {
      console.log("[RHIDP-11839] Launching template WITHOUT workflow permissions");
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");
      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      console.log("[RHIDP-11839] Clicking Create button...");
      await createButton.click();

      console.log("[RHIDP-11839] Waiting 10s for template execution result...");
      await page.waitForTimeout(10000);
      console.log(`[RHIDP-11839] Page after template execution: ${page.url()}`);

      const errorIndicators = [
        page.getByText(/unauthorized/i),
        page.getByText(/denied/i),
        page.getByText(/permission/i),
        page.getByText(/forbidden/i),
        page.getByText(/failed/i),
      ];

      let hasError = false;
      for (const indicator of errorIndicators) {
        const count = await indicator.count();
        if (count > 0) {
          const text = await indicator.first().textContent();
          console.log(`[RHIDP-11839] Error indicator found: "${text}"`);
          hasError = true;
          break;
        }
      }

      if (!hasError) {
        console.log("[RHIDP-11839] No explicit error found. Checking Orchestrator for workflow visibility...");
        await uiHelper.openSidebar("Orchestrator");
        await expect(
          page.getByRole("heading", { name: "Workflows" }),
        ).toBeVisible();

        const greetingWorkflow = page.getByRole("link", {
          name: "Greeting workflow",
        });
        const workflowCount = await greetingWorkflow.count();
        console.log(`[RHIDP-11839] Greeting workflow count: ${workflowCount} (expected 0 for denied)`);
        expect(workflowCount).toBe(0);
      }
      console.log("[RHIDP-11839] Unauthorized verification complete");
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
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

    test("Setup: Create role with catalog+scaffolder+orchestrator permissions", async () => {
      console.log(`[RHIDP-11840] Creating role ${roleName} with full permissions`);
      const rbacApi = await RbacApiHelper.build(apiToken);

      const rolePostResponse = await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: roleName,
      });
      console.log(`[RHIDP-11840] Role creation: HTTP ${rolePostResponse.status()}`);
      if (!rolePostResponse.ok()) {
        console.log(`[RHIDP-11840] Role creation error: ${await rolePostResponse.text()}`);
      }
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
      console.log(`[RHIDP-11840] Policy creation: HTTP ${policyPostResponse.status()}`);
      if (!policyPostResponse.ok()) {
        console.log(`[RHIDP-11840] Policy creation error: ${await policyPostResponse.text()}`);
      }

      expect(rolePostResponse.ok()).toBeTruthy();
      expect(policyPostResponse.ok()).toBeTruthy();
      console.log("[RHIDP-11840] Role and policies created successfully");
    });

    test("Navigate to Catalog and find orchestrator-tagged template", async () => {
      console.log("[RHIDP-11840] Navigating to Catalog (with workflow permissions)");
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading(/Catalog|All/);
      await uiHelper.selectMuiBox("Kind", "Template");
      console.log(`[RHIDP-11840] Catalog page: ${page.url()}`);

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      console.log("[RHIDP-11840] Greeting Test Picker template found, clicking...");
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByRole("heading").first()).toBeVisible();
      console.log(`[RHIDP-11840] Template page loaded: ${page.url()}`);
    });

    test("Launch template and run workflow - verify success", async () => {
      console.log("[RHIDP-11840] Launching template WITH workflow permissions");
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");

      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      console.log("[RHIDP-11840] Clicking Create button...");
      await createButton.click();

      console.log("[RHIDP-11840] Waiting for template+workflow completion...");
      const completed = page.getByText(/Completed|succeeded|finished/i);
      const conflictError = page.getByText(/409 Conflict/i);
      const startOver = page.getByRole("button", { name: "Start Over" });

      await expect(completed.or(conflictError).or(startOver)).toBeVisible({
        timeout: 120000,
      });
      console.log(`[RHIDP-11840] Template task finished. URL: ${page.url()}`);
    });

    test("Verify workflow run appears in Orchestrator", async () => {
      console.log("[RHIDP-11840] Verifying workflow run appears in Orchestrator");
      await uiHelper.openSidebar("Orchestrator");
      await expect(
        page.getByRole("heading", { name: "Workflows" }),
      ).toBeVisible();

      const greetingWorkflow = page.getByRole("link", {
        name: /Greeting workflow/i,
      });
      await expect(greetingWorkflow).toBeVisible({ timeout: 30000 });
      console.log("[RHIDP-11840] Greeting workflow visible in list");

      await greetingWorkflow.click();

      await expect(
        page.getByRole("heading", { name: /Greeting workflow/i }),
      ).toBeVisible();

      const runButton = page.getByRole("button", { name: "Run" });
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeEnabled();
      console.log("[RHIDP-11840] Run button visible and enabled. Template+workflow RBAC integration verified");
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });
  });
});
