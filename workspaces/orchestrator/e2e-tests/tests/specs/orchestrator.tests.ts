import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { ensureBaselineRole } from "../support/utils/test-helpers.js";
import {
  createDataIndexGuard,
  requireEnvVar,
} from "../support/utils/orchestrator-workflow-helpers.js";
import { registerOrchestratorCoreWorkflowTests } from "./orchestrator-workflow-core.tests.js";
import { registerTokenPropagationWorkflowTests } from "./orchestrator-token-propagation.tests.js";
import { registerEntityWorkflowIntegrationTests } from "./orchestrator-entity-integration.tests.js";

const ensureDataIndexOrSkip = createDataIndexGuard();

export function registerOrchestratorWorkflowTests(): void {
  test.describe("Workflow Execution", () => {
    test.beforeAll(async ({ browser }, testInfo) => {
      await ensureBaselineRole(browser, testInfo);
    });

    registerOrchestratorCoreWorkflowTests(ensureDataIndexOrSkip);
    registerTokenPropagationWorkflowTests(requireEnvVar);
    registerEntityWorkflowIntegrationTests(ensureDataIndexOrSkip);
  });
}
