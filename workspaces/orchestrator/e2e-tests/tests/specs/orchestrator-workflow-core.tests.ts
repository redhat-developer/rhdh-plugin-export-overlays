import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { OrchestratorPO } from "../support/pages/orchestrator-po.js";
import {
  patchHttpbin,
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
    test("Run Greeting workflow and verify Workflows tab", async ({ page }) => {
      test.setTimeout(150_000);
      await orchestratorPo.openGreetingWorkflowFromSidebar();
      const runByName = page.getByRole("button", { name: "Run", exact: true });
      const runUnauthorized = page.getByRole("button", {
        name: "User not authorized to execute workflow.",
      });
      const runVisible = runByName.or(runUnauthorized).first();
      await expect(runVisible).toBeVisible({ timeout: 15_000 });
      const authorizedCount = await runByName.count();
      const unauthorizedCount = await runUnauthorized.count();
      const enabled =
        authorizedCount > 0 ? await runByName.first().isEnabled() : false;
      console.log(
        `[repro] Run name=Run count=${authorizedCount} enabled=${enabled}; unauthorized count=${unauthorizedCount}`,
      );
      // Hold the details page so the headed window can be inspected.
      // eslint-disable-next-line playwright/no-wait-for-timeout
      await page.waitForTimeout(20_000);
      await orchestratorPo.runGreetingWorkflow();
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestratorPo.validateGreetingWorkflow();
    });

    // test("Verify Greeting workflow run details", async ({}) => {
    //   test.setTimeout(150_000);
    //   await orchestratorPo.openGreetingWorkflowFromSidebar();
    //   await orchestratorPo.runGreetingWorkflow();
    //   await orchestratorPo.reRunGreetingWorkflow();
    //   await orchestrator.validateWorkflowRunsDetails();
    // });
  });

  test.describe.skip("Failswitch workflow", () => {
    let orchestrator: OrchestratorPage;
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      orchestratorPo = new OrchestratorPO(page, uiHelper);
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

  test.describe.skip("Workflow all runs", () => {
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }) => {
      orchestratorPo = new OrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Workflow All Runs", async ({}) => {
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestratorPo.validateWorkflowAllRuns();
    });
  });
}
