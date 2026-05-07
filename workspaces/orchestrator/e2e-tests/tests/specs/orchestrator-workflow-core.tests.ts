import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
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

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Run Greeting workflow and verify Workflows tab", async ({
      uiHelper,
    }) => {
      test.setTimeout(150_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectGreetingWorkflowItem();
      await orchestrator.runGreetingWorkflow();
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateGreetingWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Greeting workflow run details", async ({ uiHelper }) => {
      test.setTimeout(150_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectGreetingWorkflowItem();
      await orchestrator.runGreetingWorkflow();
      await orchestrator.reRunGreetingWorkflow();
      await orchestrator.validateWorkflowRunsDetails();
    });
  });

  test.describe("Failswitch workflow", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Run Failswitch workflow and verify statuses", async ({
      uiHelper,
    }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
      await orchestrator.reRunFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
      await orchestrator.reRunFailSwitchWorkflow("KO");
      await orchestrator.validateCurrentWorkflowStatus("Failed");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateCurrentWorkflowStatus("Running");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateWorkflowAllRuns();
      await orchestrator.validateWorkflowAllRunsStatusIcons();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Abort workflow", async ({ uiHelper }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Running status details", async ({ uiHelper }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateWorkflowStatusDetails("Running");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Failed status details", async ({ uiHelper }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("KO");
      await orchestrator.validateWorkflowStatusDetails("Failed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Completed status details", async ({ uiHelper }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Rerun Failswitch from failure point", async ({
      uiHelper,
    }, testInfo) => {
      // 4 minutes: pod restarts + 60s sleep + failure/recovery time
      test.setTimeout(240000);
      const ns = testInfo.project.name;

      test.skip(!ns, "NAME_SPACE not set");

      const originalHttpbin = "https://httpbin.org/";
      try {
        patchHttpbin(ns!, "https://foobar.org/");
        restartAndWait(ns!);

        await uiHelper.openSidebar("Orchestrator");
        await orchestrator.selectFailSwitchWorkflowItem();
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

    test("Verify Failswitch suggested workflow link", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("OK");

      await expect(
        page.getByRole("heading", { name: /suggested next workflow/i }),
      ).toBeVisible();
      const greetingLink = page.getByRole("link", { name: /greeting/i });
      await expect(greetingLink).toBeVisible();
      await greetingLink.click();

      await expect(
        page.getByRole("dialog", { name: /greeting workflow/i }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /run workflow/i }),
      ).toBeVisible();
      await page.getByRole("button", { name: /run workflow/i }).click();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
    });
  });

  test.describe("Workflow all runs", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Workflow All Runs", async ({ uiHelper }) => {
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateWorkflowAllRuns();
    });
  });
}
