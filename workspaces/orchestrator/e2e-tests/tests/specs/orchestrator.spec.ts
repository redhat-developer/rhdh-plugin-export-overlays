import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  // configureOrchestratorLoki,
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
        // TODO: re-enable when CI Loki works — MinIO rollout fails (ImagePullBackOff), so install-orchestrator-loki.sh never becomes Ready.
        // await configureOrchestratorLoki();
        // Non-empty placeholders so rhdh-secrets envsubst never injects empty strings
        // if Loki config is reintroduced before configureOrchestratorLoki is restored.
        process.env.LOKI_BASE_URL ??= "http://localhost:3100";
        process.env.AUTH_TOKEN ??= "e2e-ci-placeholder";
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
