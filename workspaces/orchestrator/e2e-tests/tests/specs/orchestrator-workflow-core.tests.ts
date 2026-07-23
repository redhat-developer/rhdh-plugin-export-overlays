import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { OrchestratorPO } from "../support/pages/orchestrator-po.js";
import {
  patchHttpbin,
  restartAndWait,
  cleanupAfterTest,
  runOc,
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
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      orchestratorPo = new OrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Run Greeting workflow and verify Workflows tab", async ({}) => {
      test.setTimeout(150_000);
      await orchestratorPo.openGreetingWorkflowFromSidebar();
      await orchestrator.runGreetingWorkflow();
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestrator.validateGreetingWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Greeting workflow run details", async ({}) => {
      test.setTimeout(150_000);
      await orchestratorPo.openGreetingWorkflowFromSidebar();
      await orchestrator.runGreetingWorkflow();
      await orchestrator.reRunGreetingWorkflow();
      await orchestrator.validateWorkflowRunsDetails();
    });
  });

  test.describe("Failswitch workflow", () => {
    let orchestrator: OrchestratorPage;
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      orchestratorPo = new OrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Run Failswitch workflow and verify statuses", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
      await orchestrator.reRunFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
      await orchestrator.reRunFailSwitchWorkflow("KO");
      await orchestrator.validateCurrentWorkflowStatus("Failed");
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateCurrentWorkflowStatus("Running");
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestrator.validateWorkflowAllRuns();
      await orchestrator.validateWorkflowAllRunsStatusIcons();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Abort workflow", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Running status details", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateWorkflowStatusDetails("Running");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Failed status details", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("KO");
      await orchestrator.validateWorkflowStatusDetails("Failed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Completed status details", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Rerun Failswitch from failure point", async ({}, testInfo) => {
      // 4 minutes: pod restarts + 60s sleep + failure/recovery time
      test.setTimeout(240_000);
      const ns = testInfo.project.name;

      test.skip(!ns, "NAME_SPACE not set");

      // Avoid flaky public httpbin.org (503s during retrigger). Use in-cluster mock + local fail URL.
      const originalHttpbin = `http://e2e-httpbin.${ns}.svc.cluster.local/`;
      try {
        ensureE2eHttpbin(ns!);
        patchHttpbin(ns!, "http://127.0.0.1:1/");
        restartAndWait(ns!);

        await orchestratorPo.openFailswitchWorkflowFromSidebar();
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

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Failswitch suggested workflow link", async ({}) => {
      test.setTimeout(180_000);
      await orchestratorPo.openFailswitchWorkflowFromSidebar();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestratorPo.followSuggestedGreetingWorkflow();
    });
  });

  test.describe("Workflow all runs", () => {
    let orchestrator: OrchestratorPage;
    let orchestratorPo: OrchestratorPO;

    test.beforeEach(async ({ page, loginHelper, uiHelper }) => {
      orchestrator = new OrchestratorPage(page);
      orchestratorPo = new OrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Verify Workflow All Runs", async ({}) => {
      await orchestratorPo.openOrchestratorFromSidebar();
      await orchestrator.validateWorkflowAllRuns();
    });
  });
}

/** Minimal in-cluster /get mock so recovery does not depend on public httpbin.org. */
function ensureE2eHttpbin(ns: string): void {
  const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: e2e-httpbin
  namespace: ${ns}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: e2e-httpbin
  template:
    metadata:
      labels:
        app: e2e-httpbin
    spec:
      containers:
        - name: httpbin
          image: registry.access.redhat.com/ubi9/python-311@sha256:a0bdb55576fc5b8d6704279307817828ef027e1065533ceba133fe9516003a6c
          command:
            - python3
            - -c
            - |
              from http.server import HTTPServer, BaseHTTPRequestHandler
              class H(BaseHTTPRequestHandler):
                def do_GET(self):
                  b=b'{"args":{},"headers":{},"origin":"e2e","url":"http://e2e-httpbin/get"}'
                  self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
                def log_message(self,*_): pass
              HTTPServer(("0.0.0.0",8080),H).serve_forever()
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /get
              port: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: e2e-httpbin
  namespace: ${ns}
spec:
  selector:
    app: e2e-httpbin
  ports:
    - port: 80
      targetPort: 8080
`;
  const file = join(tmpdir(), `e2e-httpbin-${ns}.yaml`);
  writeFileSync(file, manifest);
  runOc(["apply", "-f", file], 60_000);
  runOc(
    ["-n", ns, "rollout", "status", "deployment/e2e-httpbin", "--timeout=180s"],
    210_000,
  );
}
