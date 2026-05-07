import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { ensureBaselineRole, runOc } from "../support/utils/test-helpers.js";
import { registerOrchestratorCoreWorkflowTests } from "./orchestrator-workflow-core.tests.js";
import { registerTokenPropagationWorkflowTests } from "./orchestrator-token-propagation.tests.js";
import { registerEntityWorkflowIntegrationTests } from "./orchestrator-entity-integration.tests.js";

function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}

function isDataIndexHealthy(ns: string): boolean {
  try {
    const health = runOc(
      [
        "exec",
        "-n",
        ns,
        "deploy/sonataflow-platform-data-index-service",
        "--",
        "curl",
        "-s",
        "--max-time",
        "5",
        "http://localhost:8080/q/health/ready",
      ],
      15_000,
    );
    const parsed = JSON.parse(health);
    return parsed.status === "UP";
  } catch {
    return false;
  }
}

async function recoverDataIndex(ns: string): Promise<boolean> {
  try {
    runOc(
      [
        "rollout",
        "restart",
        "deploy/sonataflow-platform-data-index-service",
        "-n",
        ns,
      ],
      15_000,
    );
    runOc(
      [
        "rollout",
        "status",
        "deploy/sonataflow-platform-data-index-service",
        "-n",
        ns,
        "--timeout=120s",
      ],
      130_000,
    );
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      if (isDataIndexHealthy(ns)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

let dataIndexRecoveryFailed = false;

async function ensureDataIndexOrSkip(
  ns: string,
  test: { skip: (condition: boolean, reason: string) => void },
): Promise<void> {
  if (dataIndexRecoveryFailed) {
    test.skip(true, "Data-index recovery already failed earlier — skipping");
    return;
  }
  if (isDataIndexHealthy(ns)) return;
  const recovered = await recoverDataIndex(ns);
  if (!recovered) {
    dataIndexRecoveryFailed = true;
  }
  test.skip(
    !recovered,
    "Data-index is unhealthy and could not be recovered — skipping workflow execution test",
  );
}

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
