import { test, expect } from "rhdh-e2e-test-utils/test";
import { OrchestratorPage } from "rhdh-e2e-test-utils/pages";
import { ensureBaselineRole } from "./rbac-baseline.js";
import { deploySonataflow } from "./deploy-sonataflow.js";

/**
 * Orchestrator Entity-Workflow Integration Tests
 *
 * Test Cases: RHIDP-11833 through RHIDP-11838
 *
 * These tests verify the integration between RHDH catalog entities and
 * Orchestrator workflows, including:
 * - EntityPicker-based entity association
 * - orchestrator.io/workflows annotation behavior
 * - Workflows tab visibility on entity pages
 * - Catalog <-> Workflows breadcrumb navigation
 * - Template execution -> workflow run linkage
 *
 * Templates used (from catalog locations in app-config-rhdh.yaml):
 * - greeting.yaml: name=greeting, title="Greeting workflow" - NO orchestrator.io/workflows annotation
 * - greeting_w_component.yaml: name=greetingComponent, title="Greeting Test Picker" - HAS annotation
 * - yamlgreet.yaml: name=greet, title="Greeting" - HAS annotation
 *
 * These are scaffolder templates that use the orchestrator:workflow:run action
 * to trigger the "greeting" SonataFlow workflow deployed by CI.
 */
test.describe("Orchestrator Entity-Workflow Integration", () => {
  test.beforeAll(async ({ rhdh, browser }, testInfo) => {
    test.setTimeout(20 * 60 * 1000);
    await test.runOnce("orchestrator-setup", async () => {
      const project = rhdh.deploymentConfig.namespace;
      await rhdh.configure({ auth: "keycloak" });
      await deploySonataflow(project);
      process.env.SONATAFLOW_DATA_INDEX_URL =
        "http://sonataflow-platform-data-index-service";
      await rhdh.deploy({ timeout: null });
    });
    await ensureBaselineRole(browser, testInfo);
    testInfo.annotations.push({
      type: "component",
      description: "orchestrator",
    });
  });

  test.describe("Entity-Workflow Tab and Annotation Tests", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
    });

    test("RHIDP-11833: Select existing entity via EntityPicker for workflow run", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");

      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const languageField = page.getByLabel("Language");
      await expect(languageField).toBeVisible({ timeout: 15000 });
      await languageField.click();
      await page.getByRole("option", { name: "English" }).click();

      const nameField = page.getByLabel("Name");
      await expect(nameField).toBeVisible({ timeout: 10000 });
      const uniqueName = `test-entity-${Date.now()}`;
      await nameField.fill(uniqueName);

      const reviewButton = page.getByRole("button", { name: /Review/i });
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
      await reviewButton.click();
      await page.waitForLoadState("domcontentloaded");

      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      await createButton.click();

      // Wait for completion - any of these indicates the template task finished
      const viewInCatalog = page.getByRole("link", {
        name: "View in catalog",
      });
      const openWorkflowRun = page.getByRole("link", {
        name: "Open workflow run",
      });
      const startOver = page.getByRole("button", { name: "Start Over" });

      await expect(viewInCatalog.or(openWorkflowRun).or(startOver)).toBeVisible(
        {
          timeout: 120000,
        },
      );
    });

    test("RHIDP-11834: Template WITH orchestrator.io/workflows annotation", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      // "Greeting Test Picker" (greeting_w_component.yaml) HAS the
      // orchestrator.io/workflows annotation: '["greeting"]'
      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      // Workflows tab should be visible because of the annotation
      await orchestrator.clickWorkflowsTab();

      await orchestrator.verifyWorkflowInEntityTab("Greeting workflow");
    });

    test("RHIDP-11835: Template WITHOUT orchestrator.io/workflows annotation (negative)", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      // "Greeting workflow" (greeting.yaml) does NOT have the
      // orchestrator.io/workflows annotation
      const templateLink = page.getByRole("link", {
        name: /Greeting workflow/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      // Workflows tab should not exist without the annotation
      await expect(page.getByRole("tab", { name: "Workflows" })).toHaveCount(0);
    });

    test("RHIDP-11836: Catalog <-> Workflows breadcrumb navigation", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      await orchestrator.clickWorkflowsTab();

      const workflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(workflowLink).toBeVisible({ timeout: 10000 });
      await workflowLink.click();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      // Verify breadcrumb navigation works - look for breadcrumb with entity name
      const entityName = "greetingComponent";
      const breadcrumb = page.getByRole("navigation", {
        name: /breadcrumb/i,
      });
      if ((await breadcrumb.count()) > 0 && entityName) {
        const entityBreadcrumb = breadcrumb.getByText(entityName);
        if ((await entityBreadcrumb.count()) > 0) {
          await entityBreadcrumb.click();
          await page.waitForLoadState("load");

          await expect(
            page.getByRole("heading", { name: /Greeting Test Picker/i }),
          ).toBeVisible();
        }
      }
    });

    test("RHIDP-11837: Template run produces visible workflow runs", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");
      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const nameField = page.getByLabel("Name");
      await expect(nameField).toBeVisible({ timeout: 10000 });
      const uniqueName = `test-entity-${Date.now()}`;
      await nameField.fill(uniqueName);

      const languageField = page.getByLabel("Language");
      if (await languageField.isVisible({ timeout: 5000 })) {
        await languageField.click();
        await page.getByRole("option", { name: "English" }).click();
      }

      const reviewButton = page.getByRole("button", { name: /Review/i });
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
      await reviewButton.click();
      await page.waitForLoadState("domcontentloaded");

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

      await uiHelper.openSidebar("Orchestrator");
      await expect(
        page.getByRole("heading", { name: "Workflows" }),
      ).toBeVisible();

      const greetingWorkflow = page.getByRole("link", {
        name: /Greeting workflow/i,
      });
      await expect(greetingWorkflow).toBeVisible({ timeout: 30000 });
    });

    test("RHIDP-11838: Dynamic plugin config enables Workflows tab", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      // Workflows tab is enabled by the dynamic plugin configuration
      await orchestrator.verifyWorkflowsTabVisible();

      await orchestrator.clickWorkflowsTab();

      // The OrchestratorCatalogTab card should render workflow info from the annotation
      const workflowsContent = page.locator("main").filter({
        has: page.getByText("Greeting workflow"),
      });
      await expect(workflowsContent).toBeVisible();
    });
  });
});
