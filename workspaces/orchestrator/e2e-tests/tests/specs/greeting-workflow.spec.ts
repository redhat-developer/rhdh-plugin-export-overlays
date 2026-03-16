import { test } from "rhdh-e2e-test-utils/test";
import { OrchestratorPage } from "rhdh-e2e-test-utils/pages";
import { ensureBaselineRole } from "./rbac-baseline.js";
import { deploySonataflow } from "./deploy-sonataflow.js";

test.describe("Orchestrator greeting workflow tests", () => {
  let orchestrator: OrchestratorPage;

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
  });

  test.beforeEach(async ({ page, loginHelper }) => {
    orchestrator = new OrchestratorPage(page);
    await loginHelper.loginAsKeycloakUser();
  });

  test("Greeting workflow execution and workflow tab validation", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Orchestrator");
    await orchestrator.selectGreetingWorkflowItem();
    await orchestrator.runGreetingWorkflow();
    await uiHelper.openSidebar("Orchestrator");
    await orchestrator.validateGreetingWorkflow();
  });

  test("Greeting workflow run details validation", async ({ uiHelper }) => {
    await uiHelper.openSidebar("Orchestrator");
    await orchestrator.selectGreetingWorkflowItem();
    await orchestrator.runGreetingWorkflow();
    await orchestrator.reRunGreetingWorkflow();
    await orchestrator.validateWorkflowRunsDetails();
  });
});
