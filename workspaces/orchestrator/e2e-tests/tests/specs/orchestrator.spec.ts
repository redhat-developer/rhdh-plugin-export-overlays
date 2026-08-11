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
import { registerOrchestratorKafkaTests } from "./orchestrator-kafka.tests.js";

function skipOrchestratorDeploy(): boolean {
  return process.env.SKIP_ORCHESTRATOR_DEPLOY === "true";
}

test.describe("Orchestrator", () => {
  test.beforeAll(async ({ rhdh }, testInfo) => {
    // SonataFlow + OpenShift Logging install + RHDH deploy can exceed 40 minutes in CI.
    test.setTimeout(60 * 60 * 1000);
    await test.runOnce(
      `orchestrator-setup-${testInfo.project.name}`,
      async () => {
        const project = rhdh.deploymentConfig.namespace;
        process.env.SONATAFLOW_DATA_INDEX_URL =
          "http://sonataflow-platform-data-index-service.orchestrator.svc.cluster.local";

        // Local/dev: skip Loki + full redeploy when substrate is already live.
        // Use after a prior successful (or manually healed) deploy: SKIP_ORCHESTRATOR_DEPLOY=true
        if (skipOrchestratorDeploy()) {
          console.warn(
            "[orchestrator-setup] SKIP_ORCHESTRATOR_DEPLOY=true — skipping deploySonataflow/Loki/RHDH redeploy",
          );
          if (!process.env.RHDH_BASE_URL?.trim()) {
            throw new Error(
              "SKIP_ORCHESTRATOR_DEPLOY=true requires RHDH_BASE_URL to be set",
            );
          }
          process.env.LOKI_BASE_URL =
            process.env.LOKI_BASE_URL?.trim() ||
            "http://logging-loki-gateway-http.openshift-logging.svc.cluster.local:8080";
          return;
        }

        await rhdh.configure({ auth: "keycloak" });
        try {
          await deploySonataflow(project);
        } catch (err) {
          logOrchestratorDeployFailureDiagnostics(project);
          throw err;
        }
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
  registerOrchestratorKafkaTests();
});
