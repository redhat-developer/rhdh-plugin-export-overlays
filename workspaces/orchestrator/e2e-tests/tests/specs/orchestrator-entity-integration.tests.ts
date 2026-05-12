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
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await orchestratorPo.openGreetingTemplateFromSelfService();
      await orchestratorPo.fillGreetingTemplateFormAndSubmit({
        selectLanguage: true,
      });
      await orchestratorPo.waitForTemplateRunCompletionArtifacts(120_000);
      await expect(
        orchestratorPo.templateRunCompletionArtifacts(),
      ).toBeVisible();
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
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await orchestratorPo.openTemplateFromCatalogByName(
        /Greeting workflow/i,
        "My Org Catalog",
      );

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (await orchestratorPo.openWorkflowsTabIfVisible()) {
        // Tab exists but should not list greeting (no annotation)
        const greetingWorkflow = page.getByRole("link", {
          name: /Greeting workflow/i,
        });
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
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (await orchestratorPo.followEntityBreadcrumbIfVisible(entityName)) {
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(
          page.getByRole("heading", { name: /Greeting Test Picker/i }),
        ).toBeVisible();
      }
    });

    test("RHIDP-11837: Template run appears in Workflows list", async ({
      page,
      uiHelper,
    }) => {
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await orchestratorPo.openGreetingTemplateFromSelfService();
      await orchestratorPo.fillGreetingTemplateFormAndSubmit({
        submitCreate: false,
      });
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
