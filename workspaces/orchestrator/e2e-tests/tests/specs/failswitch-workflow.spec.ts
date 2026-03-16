import { test, expect } from "rhdh-e2e-test-utils/test";
import { $ } from "rhdh-e2e-test-utils/utils";
import { OrchestratorPage } from "rhdh-e2e-test-utils/pages";
import { ensureBaselineRole } from "./rbac-baseline.js";
import { deploySonataflow } from "./deploy-sonataflow.js";

test.describe("Orchestrator failswitch workflow tests", () => {
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

  test("Failswitch workflow execution and workflow tab validation", async ({
    uiHelper,
  }) => {
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

  test("Test abort workflow", async ({ uiHelper }) => {
    await uiHelper.openSidebar("Orchestrator");
    await orchestrator.selectFailSwitchWorkflowItem();
    await orchestrator.runFailSwitchWorkflow("Wait");
    await orchestrator.abortWorkflow();
  });

  test("Test Running status validations", async ({ uiHelper }) => {
    await uiHelper.openSidebar("Orchestrator");
    await orchestrator.selectFailSwitchWorkflowItem();
    await orchestrator.runFailSwitchWorkflow("Wait");
    await orchestrator.validateWorkflowStatusDetails("Running");
  });

  test("Test Failed status validations", async ({ uiHelper }) => {
    await uiHelper.openSidebar("Orchestrator");
    await orchestrator.selectFailSwitchWorkflowItem();
    await orchestrator.runFailSwitchWorkflow("KO");
    await orchestrator.validateWorkflowStatusDetails("Failed");
  });

  test("Test Completed status validations", async ({ uiHelper }) => {
    await uiHelper.openSidebar("Orchestrator");
    await orchestrator.selectFailSwitchWorkflowItem();
    await orchestrator.runFailSwitchWorkflow("OK");
    await orchestrator.validateWorkflowStatusDetails("Completed");
  });

  test("Test rerunning from failure point using failswitch workflow", async ({
    uiHelper,
  }, testInfo) => {
    // 4 minutes: pod restarts + 60s sleep + failure/recovery time
    test.setTimeout(240000);
    const ns = testInfo.project.name;

    test.skip(!ns, "NAME_SPACE not set");

    const originalHttpbin = "https://httpbin.org/";
    try {
      await patchHttpbin(ns!, "https://foobar.org/");
      await restartAndWait(ns!);

      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateCurrentWorkflowStatus("Failed");

      await patchHttpbin(ns!, originalHttpbin);
      await restartAndWait(ns!);

      await orchestrator.reRunOnFailure("From failure point");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
    } catch (e) {
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

  test("Failswitch links to another workflow and link works", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Orchestrator");
    await orchestrator.selectFailSwitchWorkflowItem();
    await orchestrator.runFailSwitchWorkflow("OK");

    // Verify suggested next workflow section and navigate via the greeting link
    await expect(
      page.getByRole("heading", { name: /suggested next workflow/i }),
    ).toBeVisible();
    const greetingLink = page.getByRole("link", { name: /greeting/i });
    await expect(greetingLink).toBeVisible();
    await greetingLink.click();

    // Popup should appear for Greeting workflow
    await expect(
      page.getByRole("dialog", { name: /greeting workflow/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /run workflow/i }),
    ).toBeVisible();
    await page.getByRole("button", { name: /run workflow/i }).click();

    // Verify Greeting workflow execute view shows correct header and "Next" button
    await expect(
      page.getByRole("heading", { name: "Greeting workflow" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  });
});

async function getHttpbinValue(ns: string): Promise<string | undefined> {
  const result =
    await $`oc -n ${ns} get sonataflow failswitch -o jsonpath={.spec.podTemplate.container.env[?(@.name=='HTTPBIN')].value}`;
  return result.stdout.trim() || undefined;
}

async function patchHttpbin(ns: string, value: string): Promise<void> {
  const patch = `{"spec":{"podTemplate":{"container":{"env":[{"name":"HTTPBIN","value":"${value}"}]}}}}`;
  console.log("patching HTTPBIN in sonataflow resource to", value);
  await $`oc -n ${ns} patch sonataflow failswitch --type merge -p ${patch}`;
}

async function restartAndWait(ns: string): Promise<void> {
  console.log("restarting deployment failswitch");
  await $`oc -n ${ns} rollout restart deployment failswitch`;

  console.log("waiting for pods to be ready");
  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await $`oc -n ${ns} wait --for=condition=ready pod -l app.kubernetes.io/name=failswitch --timeout=5s`;
      return;
    } catch {
      if (i === maxRetries - 1) throw new Error("Pods failed to become ready");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function cleanupAfterTest(
  ns: string,
  originalHttpbin: string,
): Promise<void> {
  const currentHttpbin = await getHttpbinValue(ns);
  if (currentHttpbin !== originalHttpbin) {
    await patchHttpbin(ns, originalHttpbin);
    await restartAndWait(ns);
  }
}
