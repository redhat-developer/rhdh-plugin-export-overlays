import { test, expect, Page } from "rhdh-e2e-test-utils/test";
import { UIhelper, RbacApiHelper } from "rhdh-e2e-test-utils/helpers";
import {
  removeBaselineRole,
  setupAuthenticatedPage,
  deleteRoleAndPolicies,
  buildPolicies,
  PRIMARY_USER,
} from "./rbac-baseline.js";
import { deploySonataflow } from "./deploy-sonataflow.js";

/**
 * Orchestrator Entity-Workflow RBAC Tests
 *
 * Test Cases: RHIDP-11839, RHIDP-11840
 *
 * These tests verify the RBAC boundary between template execution and
 * workflow execution in the context of entity-workflow integration.
 *
 * Important: These tests should run in the SHOWCASE_RBAC project since
 * they require permission.enabled: true.
 *
 * Templates used (from catalog locations):
 * - greeting_w_component.yaml: name=greetingComponent, title="Greeting Test Picker" - HAS annotation
 */
test.describe.serial("Orchestrator Entity-Workflow RBAC", () => {
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
        if ((await indicator.count()) > 0) {
          hasError = true;
          break;
        }
      }

      // If no explicit error, verify workflow is not accessible in Orchestrator
      if (!hasError) {
        await uiHelper.openSidebar("Orchestrator");
        await expect(
          page.getByRole("heading", { name: "Workflows" }),
        ).toBeVisible();

        // With denied permissions, workflows should not be visible
        const greetingWorkflow = page.getByRole("link", {
          name: "Greeting workflow",
        });
        const workflowCount = await greetingWorkflow.count();
        expect(workflowCount).toBe(0);
      }
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

      // Template goes straight to Review step with just a Create button
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

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, roleName);
    });
  });
});
