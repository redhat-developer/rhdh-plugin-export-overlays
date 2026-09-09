import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { OrchestratorPO } from "../support/pages/orchestrator-po.js";
import {
  patchHttpbin,
  cleanupAfterTest,
  createOrchestratorPO,
} from "../support/utils/test-helpers.js";

type EnsureDataIndexOrSkip = (
  ns: string,
  testObj: { skip: (condition: boolean, reason: string) => void },
) => Promise<void>;

export function registerOrchestratorCoreWorkflowTests(
  ensureDataIndexOrSkip: EnsureDataIndexOrSkip,
): void {
  test.describe("Greeting workflow", () => {
    let orchestrator: OrchestratorPage;
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      orchestratorPo = createOrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Run Greeting workflow and verify Workflows tab", async ({}) => {
      test.setTimeout(150_000);
      await orchestratorPo.openGreetingWorkflowFromSidebar();
      await orchestratorPo.runGreetingWorkflow();
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestratorPo.validateGreetingWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Greeting workflow run details", async ({}) => {
      test.setTimeout(150_000);
      await orchestratorPo.openGreetingWorkflowFromSidebar();
      await orchestratorPo.runGreetingWorkflow();
      await orchestratorPo.reRunGreetingWorkflow();
      await orchestrator.validateWorkflowRunsDetails();
    });
  });

  test.describe("Failswitch workflow", () => {
    let orchestrator: OrchestratorPage;
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      orchestratorPo = createOrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Run Failswitch workflow and verify statuses", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestratorPo.runFailSwitchWorkflow("OK");
      await orchestratorPo.validateCurrentWorkflowStatus("Completed");
      await orchestrator.reRunFailSwitchWorkflow("Wait");
      await orchestratorPo.abortWorkflow();
      await orchestrator.reRunFailSwitchWorkflow("KO");
      await orchestratorPo.validateCurrentWorkflowStatus("Failed");
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestratorPo.runFailSwitchWorkflow("Wait");
      await orchestratorPo.validateCurrentWorkflowStatus("Running");
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestratorPo.validateWorkflowAllRuns();
      await orchestrator.validateWorkflowAllRunsStatusIcons();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Abort workflow", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestratorPo.runFailSwitchWorkflow("Wait");
      await orchestratorPo.abortWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Running status details", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestratorPo.runFailSwitchWorkflow("Wait");
      await orchestratorPo.validateWorkflowStatusDetails("Running");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Failed status details", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestratorPo.runFailSwitchWorkflow("KO");
      await orchestratorPo.validateWorkflowStatusDetails("Failed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Completed status details", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestratorPo.runFailSwitchWorkflow("OK");
      await orchestratorPo.validateCurrentWorkflowStatus("Completed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Rerun Failswitch from failure point", async ({}, testInfo) => {
      // HTTPBIN patch + 60s Wait timer + failure/recovery rerun
      test.setTimeout(360_000);
      const ns = testInfo.project.name;

      test.skip(!ns, "NAME_SPACE not set");

      const originalHttpbin = "https://httpbin.org/";
      try {
        await patchHttpbin(ns!, "https://foobar.org/");

        await orchestratorPo.openFailswitchWorkflowFromSidebar();
        await orchestratorPo.runFailSwitchWorkflow("Wait");
        await orchestratorPo.validateCurrentWorkflowStatus("Failed");

        await patchHttpbin(ns!, originalHttpbin);

        await orchestrator.reRunOnFailure("From failure point");
        await orchestratorPo.validateCurrentWorkflowStatus("Completed");
      } catch (e) {
        console.error(`[rerun-failure] Test failed: ${e}`);
        testInfo.annotations.push({
          type: "test-error",
          description: String(e),
        });
        throw e;
      } finally {
        try {
          await cleanupAfterTest(ns!, originalHttpbin);
        } catch (cleanupErr) {
          testInfo.annotations.push({
            type: "cleanup-error",
            description: String(cleanupErr),
          });
        }
      }
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Failswitch suggested workflow link", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestratorPo.runFailSwitchWorkflow("OK");
      await orchestratorPo.followSuggestedGreetingWorkflow();
    });
  });

  test.describe("Multi-step form navigation", () => {
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
      orchestratorPo = createOrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test("Backward navigation in multi-step stepper", async ({ page }) => {
      test.setTimeout(180_000);

      const step1Fields: [string, string][] = [
        ["Name", "test-name"],
        ["Email", "test@example.com"],
      ];
      const step2Fields: [string, string][] = [
        ["Simple Text Field", "sample-text-value"],
        ["Object Type Example", '{"key":"value"}'],
      ];

      await orchestratorPo.openOrchestratorFromSidebar();

      await expect(
        page.getByRole("cell", { name: "Test Object Type Support" }),
      ).toBeVisible({ timeout: 30_000 });
      await page
        .getByRole("link", {
          name: /Test Object Type Support in ui:props/i,
        })
        .click();

      const runButton = page
        .getByRole("button", { name: "Run", exact: true })
        .first();
      await expect(runButton).toBeEnabled({ timeout: 30_000 });
      await runButton.click();

      // Step 1: Fill Basic Information
      for (const [label, value] of step1Fields) {
        await page.getByRole("textbox", { name: label }).fill(value);
      }

      // Navigate to Step 2
      await page.getByRole("button", { name: "Next" }).click();
      await expect(
        page.getByRole("textbox", { name: "Simple Text Field" }),
      ).toBeVisible({ timeout: 10_000 });

      // Step 2: Fill Demonstration Fields
      for (const [label, value] of step2Fields) {
        await page.getByRole("textbox", { name: label }).fill(value);
      }

      // Navigate back to Step 1 and verify fields are preserved
      await page.getByRole("button", { name: "Back" }).click();
      for (const [label, value] of step1Fields) {
        await expect(page.getByRole("textbox", { name: label })).toHaveValue(
          value,
        );
      }

      // Navigate forward to Step 2 and verify fields are preserved
      await page.getByRole("button", { name: "Next" }).click();
      for (const [label, value] of step2Fields) {
        await expect(page.getByRole("textbox", { name: label })).toHaveValue(
          value,
        );
      }

      // Verify the Review step is not selectable for forward jumps
      const reviewStepButton = page.getByRole("button", {
        name: /review/i,
      });
      await expect(reviewStepButton).toBeHidden();

      // Navigate to Review step and verify all inputs are visible
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByText("Run workflow")).toBeVisible({
        timeout: 10_000,
      });
      const allValues = [...step1Fields, ...step2Fields].map(
        ([, value]) => value,
      );
      for (const value of allValues) {
        await expect(page.getByText(value)).toBeVisible();
      }
    });
  });

  test.describe("Workflow all runs", () => {
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }) => {
      orchestratorPo = createOrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Workflow All Runs", async ({}) => {
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestratorPo.validateWorkflowAllRuns();
    });
  });
}
