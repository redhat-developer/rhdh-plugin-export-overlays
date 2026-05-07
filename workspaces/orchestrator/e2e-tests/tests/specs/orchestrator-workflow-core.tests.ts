import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { OrchestratorPO } from "../support/pages/orchestrator-po.js";
import {
  patchHttpbin,
  restartAndWait,
  cleanupAfterTest,
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
      orchestratorPo = new OrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Run Greeting workflow and verify Workflows tab", async (_fixtures) => {
      test.setTimeout(150_000);
      await orchestratorPo.openGreetingWorkflowFromSidebar();
      await orchestrator.runGreetingWorkflow();
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestrator.validateGreetingWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Greeting workflow run details", async (_fixtures) => {
      test.setTimeout(150_000);
      await orchestratorPo.openGreetingWorkflowFromSidebar();
      await orchestrator.runGreetingWorkflow();
      await orchestrator.reRunGreetingWorkflow();
      await orchestrator.validateWorkflowRunsDetails();
    });
  });

  test.describe("Failswitch workflow", () => {
    let orchestrator: OrchestratorPage;
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      orchestratorPo = new OrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Run Failswitch workflow and verify statuses", async (_fixtures) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
      await orchestrator.reRunFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
      await orchestrator.reRunFailSwitchWorkflow("KO");
      await orchestrator.validateCurrentWorkflowStatus("Failed");
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateCurrentWorkflowStatus("Running");
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestrator.validateWorkflowAllRuns();
      await orchestrator.validateWorkflowAllRunsStatusIcons();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Abort workflow", async (_fixtures) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Running status details", async (_fixtures) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateWorkflowStatusDetails("Running");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Failed status details", async (_fixtures) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("KO");
      await orchestrator.validateWorkflowStatusDetails("Failed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Completed status details", async (_fixtures) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Rerun Failswitch from failure point", async (_fixtures, testInfo) => {
      // 4 minutes: pod restarts + 60s sleep + failure/recovery time
      test.setTimeout(240_000);
      const ns = testInfo.project.name;

      test.skip(!ns, "NAME_SPACE not set");

      const originalHttpbin = "https://httpbin.org/";
      try {
        patchHttpbin(ns!, "https://foobar.org/");
        restartAndWait(ns!);

        await orchestratorPo.openFailswitchWorkflowFromSidebar();
        await orchestrator.runFailSwitchWorkflow("Wait");
        await orchestrator.validateCurrentWorkflowStatus("Failed");

        patchHttpbin(ns!, originalHttpbin);
        restartAndWait(ns!);

        await orchestrator.reRunOnFailure("From failure point");
        await orchestrator.validateCurrentWorkflowStatus("Completed");
      } catch (e) {
        console.error(`[rerun-failure] Test failed: ${e}`);
        testInfo.annotations.push({
          type: "test-error",
          description: String(e),
        });
        throw e;
      } finally {
        try {
          cleanupAfterTest(ns!, originalHttpbin);
        } catch (cleanupErr) {
          testInfo.annotations.push({
            type: "cleanup-error",
            description: String(cleanupErr),
          });
        }
      }
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Failswitch suggested workflow link", async (_fixtures) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestratorPo.followSuggestedGreetingWorkflow();
    });
  });

  test.describe("Workflow all runs", () => {
    let orchestrator: OrchestratorPage;
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }) => {
      orchestrator = new OrchestratorPage(page);
      orchestratorPo = new OrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Workflow All Runs", async (_fixtures) => {
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestrator.validateWorkflowAllRuns();
    });
  });
}
