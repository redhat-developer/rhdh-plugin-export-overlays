import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  deploySonataflow,
  ensurePublishedOrchestratorPrImagesAvailable,
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
      await ensurePublishedOrchestratorPrImagesAvailable();
      process.env.SONATAFLOW_DATA_INDEX_URL =
        "http://sonataflow-platform-data-index-service.orchestrator.svc.cluster.local";
      try {
        await rhdh.deploy({ timeout: 900_000 });
      } catch (err) {
        logOrchestratorDeployFailureDiagnostics(project);
        throw err;
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
