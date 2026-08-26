import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  configureOrchestratorLoki,
  deploySonataflow,
  logOrchestratorDeployFailureDiagnostics,
  prepareRhdhHelmRedeploy,
} from "../support/utils/test-helpers.js";
import { registerOrchestratorWorkflowTests } from "./orchestrator.tests.js";
import { registerOrchestratorRbacTests } from "./orchestrator-rbac.tests.js";
import { registerRetryWorkflowTests } from "./retry-workflow.tests.js";
import { registerUiPropsTestWorkflowTests } from "./ui-props-test-workflow.tests.js";

test.describe("Orchestrator", () => {
  test.beforeAll(async ({ rhdh }, testInfo) => {
    // SonataFlow + OpenShift Logging install + RHDH deploy can exceed 40 minutes in CI.
    test.setTimeout(60 * 60 * 1000);
    await test.runOnce(
      `orchestrator-setup-${testInfo.project.name}`,
      async () => {
        const project = rhdh.deploymentConfig.namespace;
        await rhdh.configure({ auth: "keycloak" });
        try {
          await deploySonataflow(project);
        } catch (err) {
          logOrchestratorDeployFailureDiagnostics(project);
          throw err;
        }
        process.env.SONATAFLOW_DATA_INDEX_URL =
          "http://sonataflow-platform-data-index-service.orchestrator.svc.cluster.local";
        await configureOrchestratorLoki();
        try {
          await prepareRhdhHelmRedeploy(project);
          await rhdh.deploy({ timeout: 1_800_000 });
        } catch (err) {
          logOrchestratorDeployFailureDiagnostics(project);
          throw err;
        }
      },
    );
    testInfo.annotations.push({
      type: "component",
      description: "orchestrator",
    });
  });

  registerOrchestratorWorkflowTests();
  registerOrchestratorRbacTests();
  registerRetryWorkflowTests();
  registerUiPropsTestWorkflowTests();
});
