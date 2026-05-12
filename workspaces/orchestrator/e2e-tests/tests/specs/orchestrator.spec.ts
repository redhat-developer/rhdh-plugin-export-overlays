import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  deploySonataflow,
  logOrchestratorDeployFailureDiagnostics,
} from "../support/utils/test-helpers.js";
import { registerOrchestratorWorkflowTests } from "./orchestrator.tests.js";
import { registerOrchestratorRbacTests } from "./orchestrator-rbac.tests.js";

test.describe("Orchestrator", () => {
  test.beforeAll(async ({ rhdh }, testInfo) => {
    test.setTimeout(40 * 60 * 1000);
    await test.runOnce("orchestrator-setup", async () => {
      const project = rhdh.deploymentConfig.namespace;
      await rhdh.configure({ auth: "keycloak" });
      await deploySonataflow(project);
      process.env.SONATAFLOW_DATA_INDEX_URL =
        "http://sonataflow-platform-data-index-service.orchestrator.svc.cluster.local";
      const originalPrNumber = process.env.GIT_PR_NUMBER;
      delete process.env.GIT_PR_NUMBER;
      try {
        await rhdh.deploy({ timeout: 900_000 });
      } catch (err) {
        logOrchestratorDeployFailureDiagnostics(project);
        throw err;
      } finally {
        if (originalPrNumber !== undefined) {
          process.env.GIT_PR_NUMBER = originalPrNumber;
        }
      }
    });
    testInfo.annotations.push({
      type: "component",
      description: "orchestrator",
    });
  });

  registerOrchestratorWorkflowTests();
  registerOrchestratorRbacTests();
});
