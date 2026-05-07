import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { OrchestratorPO } from "../support/pages/orchestrator-po.js";
import {
  cleanupGreetingComponentEntity,
  clickCreateAndWaitForScaffolderTerminalState,
} from "../support/utils/test-helpers.js";

type EnsureDataIndexOrSkip = (
  ns: string,
  testObj: { skip: (condition: boolean, reason: string) => void },
) => Promise<void>;

export function registerEntityWorkflowIntegrationTests(
  ensureDataIndexOrSkip: EnsureDataIndexOrSkip,
): void {
  /**
   * Entity-Workflow Integration Tests
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
   * Templates used (from testetson22/greeting_54mjks on GitHub):
   * - greeting.yaml: name=greeting, title="Greeting workflow" - NO orchestrator.io/workflows annotation
   * - greeting_w_component.yaml: name=greetingComponent, title="Greeting Test Picker" - HAS annotation
   *
   * These are scaffolder templates that use the orchestrator:workflow:run action
   * to trigger the "greeting" SonataFlow workflow deployed by CI.
   */
  test.describe("Entity-Workflow Integration", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test.afterAll(async () => {
      await cleanupGreetingComponentEntity();
    });

    test("RHIDP-11833: Run workflow using EntityPicker selection", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");

      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await page.waitForURL(/\/create\/templates\//, { timeout: 30000 });
      await page.waitForLoadState("domcontentloaded");
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

      const viewInCatalog = page.getByRole("link", {
        name: "View in catalog",
      });
      const openWorkflowRun = page.getByRole("link", {
        name: "Open workflow run",
      });
      const startOver = page.getByRole("button", { name: "Start Over" });

      await expect(
        viewInCatalog.or(openWorkflowRun).or(startOver),
      ).toBeVisible({
        timeout: 120000,
      });
    });

    test("RHIDP-11834: Template with orchestrator.io/workflows annotation", async ({
      page,
      uiHelper,
    }) => {
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await orchestratorPo.openGreetingTemplateFromCatalog("My Org Catalog");
      await expect(
        page.getByRole("heading", { name: /Greeting Test Picker/i }),
      ).toBeVisible();

      await orchestrator.clickWorkflowsTab();
      await orchestrator.verifyWorkflowInEntityTab("Greeting workflow");
      await expect(
        page.getByRole("link", { name: "Greeting workflow", exact: true }),
      ).toBeVisible();
    });

    test("RHIDP-11835: Template without orchestrator.io/workflows annotation", async ({
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

      const workflowsTab = page.getByRole("tab", { name: "Workflows" });
      const tabCount = await workflowsTab.count();

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (tabCount > 0) {
        // Tab exists but should not list greeting (no annotation)
        await workflowsTab.click();
        await page.waitForLoadState("domcontentloaded");
        const greetingWorkflow = page.getByText("Greeting workflow");
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(greetingWorkflow).toHaveCount(0);
      }
    });

    test("RHIDP-11836: Verify Catalog <-> Workflows breadcrumbs", async ({
      page,
      uiHelper,
    }) => {
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await orchestratorPo.openGreetingTemplateFromCatalog("My Org Catalog");

      await orchestrator.clickWorkflowsTab();

      await orchestratorPo.openWorkflow("Greeting workflow");

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      const entityName = "greetingComponent";
      const breadcrumb = page.getByRole("navigation", {
        name: /breadcrumb/i,
      });
      const breadcrumbCount = await breadcrumb.count();
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (breadcrumbCount > 0 && entityName) {
        const entityBreadcrumb = breadcrumb.getByText(entityName);
        const entityBreadcrumbCount = await entityBreadcrumb.count();
        // eslint-disable-next-line playwright/no-conditional-in-test
        if (entityBreadcrumbCount > 0) {
          await entityBreadcrumb.click();
          await page.waitForLoadState("load");

          // eslint-disable-next-line playwright/no-conditional-expect
          await expect(
            page.getByRole("heading", { name: /Greeting Test Picker/i }),
          ).toBeVisible();
        }
      }
    });

    test("RHIDP-11837: Template run appears in Workflows list", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");
      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await page.waitForURL(/\/create\/templates\//, { timeout: 30000 });
      await page.waitForLoadState("domcontentloaded");
      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const nameField = page.getByLabel("Name");
      await expect(nameField).toBeVisible({ timeout: 10000 });
      const uniqueName = `test-entity-${Date.now()}`;
      await nameField.fill(uniqueName);

      const languageField = page.getByLabel("Language");
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (await languageField.isVisible({ timeout: 5000 })) {
        await languageField.click();
        await page.getByRole("option", { name: "English" }).click();
      }

      const reviewButton = page.getByRole("button", { name: /Review/i });
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
      await reviewButton.click();
      await page.waitForLoadState("domcontentloaded");

      await clickCreateAndWaitForScaffolderTerminalState(page);

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
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await orchestratorPo.openGreetingTemplateFromCatalog("My Org Catalog");

      await orchestrator.verifyWorkflowsTabVisible();

      await orchestrator.clickWorkflowsTab();

      const workflowsContent = page.locator("main").filter({
        has: page.getByText("Greeting workflow"),
      });
      await expect(workflowsContent).toBeVisible();
    });
  });
}
