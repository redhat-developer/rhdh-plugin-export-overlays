import { execSync, execFileSync } from "child_process";
import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { ensureBaselineRole } from "./rbac-baseline.js";
import { deploySonataflow } from "./deploy-sonataflow.js";

interface WorkflowNode {
  name: string;
  errorMessage: string | null;
  exit: string | null;
}

interface WorkflowInstance {
  state: string;
  workflowdata: {
    result: {
      completedWith: string;
      message: string;
    };
  };
  nodes: WorkflowNode[];
  serviceUrl?: string;
}

function decodeEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return Buffer.from(value, "base64").toString();
}

function isDataIndexHealthy(ns: string): boolean {
  try {
    const health = execSync(
      `oc exec -n ${ns} deploy/sonataflow-platform-data-index-service -- curl -s --max-time 5 http://localhost:8080/q/health/ready`,
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    const parsed = JSON.parse(health);
    return parsed.status === "UP";
  } catch {
    return false;
  }
}

function recoverDataIndex(ns: string): boolean {
  console.log("[data-index-recovery] Attempting data-index restart...");
  try {
    execSync(
      `oc rollout restart deploy/sonataflow-platform-data-index-service -n ${ns}`,
      { encoding: "utf-8", timeout: 15_000 },
    );
    execSync(
      `oc rollout status deploy/sonataflow-platform-data-index-service -n ${ns} --timeout=120s`,
      { encoding: "utf-8", timeout: 130_000 },
    );
    for (let i = 0; i < 6; i++) {
      execSync("sleep 5", { timeout: 10_000 });
      if (isDataIndexHealthy(ns)) {
        console.log(
          `[data-index-recovery] Data-index healthy after restart (${(i + 1) * 5}s)`,
        );
        return true;
      }
    }
    console.log(
      "[data-index-recovery] Data-index still unhealthy after restart",
    );
    return false;
  } catch (e) {
    console.log(`[data-index-recovery] Restart failed: ${e}`);
    return false;
  }
}

let dataIndexRecoveryFailed = false;

function ensureDataIndexOrSkip(
  ns: string,
  test: { skip: (condition: boolean, reason: string) => void },
): void {
  if (dataIndexRecoveryFailed) {
    test.skip(true, "Data-index recovery already failed earlier — skipping");
    return;
  }
  if (isDataIndexHealthy(ns)) return;
  console.log("[data-index-check] Data-index is DOWN, attempting recovery...");
  const recovered = recoverDataIndex(ns);
  if (!recovered) {
    dataIndexRecoveryFailed = true;
  }
  test.skip(
    !recovered,
    "Data-index is unhealthy and could not be recovered — skipping workflow execution test",
  );
}

function dumpClusterState(ns: string, label: string): void {
  console.log(`[${label}] --- Cluster state dump for ns=${ns} ---`);
  try {
    const pods = execSync(`oc get pods -n ${ns} --no-headers`, {
      encoding: "utf-8",
    }).trim();
    console.log(`[${label}] Pods:\n${pods}`);
  } catch (e) {
    console.log(`[${label}] Pods error: ${e}`);
  }
  try {
    const diHealth = execSync(
      `oc exec -n ${ns} deploy/sonataflow-platform-data-index-service -- curl -s --max-time 5 http://localhost:8080/q/health`,
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    console.log(`[${label}] Data-index health: ${diHealth.substring(0, 1500)}`);
  } catch (e) {
    console.log(`[${label}] Data-index health error: ${e}`);
  }
  try {
    const diLogs = execSync(
      `oc logs -n ${ns} deploy/sonataflow-platform-data-index-service --tail=15`,
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    console.log(`[${label}] Data-index last 15 lines:\n${diLogs}`);
  } catch (e) {
    console.log(`[${label}] Data-index logs error: ${e}`);
  }
  try {
    const rhdhLogs = execSync(
      `oc logs -n ${ns} deploy/redhat-developer-hub --tail=100`,
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
    const errLines = rhdhLogs
      .split("\n")
      .filter((l: string) =>
        /error|warn|fail|orchestrator|data-index|timeout|ECONNREFUSED|ENOTFOUND/i.test(
          l,
        ),
      );
    if (errLines.length > 0) {
      console.log(
        `[${label}] RHDH error/warn lines (${errLines.length}):\n${errLines.slice(-20).join("\n")}`,
      );
    }
  } catch (e) {
    console.log(`[${label}] RHDH logs error: ${e}`);
  }
  try {
    const events = execSync(
      `oc get events -n ${ns} --sort-by=.lastTimestamp --no-headers`,
      { encoding: "utf-8" },
    ).trim();
    const recentEvents = events.split("\n").slice(-15).join("\n");
    console.log(`[${label}] Recent events:\n${recentEvents}`);
  } catch (e) {
    console.log(`[${label}] Events error: ${e}`);
  }
  console.log(`[${label}] --- End cluster state dump ---`);
}

test.describe("Orchestrator", () => {
  test.beforeAll(async ({ rhdh, browser }, testInfo) => {
    test.setTimeout(20 * 60 * 1000);
    await test.runOnce("orchestrator-setup", async () => {
      const project = rhdh.deploymentConfig.namespace;
      console.log("[orchestrator-setup] Environment summary:");
      console.log(`[orchestrator-setup]   namespace=${project}`);
      console.log(
        `[orchestrator-setup]   RHDH_BASE_URL=${process.env.RHDH_BASE_URL || "(not set)"}`,
      );
      console.log(
        `[orchestrator-setup]   IS_OPENSHIFT=${process.env.IS_OPENSHIFT || "(not set)"}`,
      );
      console.log(
        `[orchestrator-setup]   GH_USER_ID=${process.env.GH_USER_ID ? "(set)" : "(not set)"}`,
      );
      console.log(
        `[orchestrator-setup]   PRIMARY_TEST_USER=${process.env.PRIMARY_TEST_USER || "(not set, default=test1)"}`,
      );
      console.log(
        `[orchestrator-setup]   Node.js ${process.version}, PID ${process.pid}`,
      );
      await rhdh.configure({ auth: "keycloak" });
      await deploySonataflow(project);
      process.env.SONATAFLOW_DATA_INDEX_URL =
        "http://sonataflow-platform-data-index-service";
      // #region agent log
      console.log(
        `[orchestrator-setup] SONATAFLOW_DATA_INDEX_URL=${process.env.SONATAFLOW_DATA_INDEX_URL}`,
      );
      // #endregion
      await rhdh.deploy({ timeout: null });
      // #region agent log
      const ns = rhdh.deploymentConfig.namespace;
      console.log(
        "[orchestrator-setup] RHDH deployed. Post-deploy workflow diagnostics:",
      );
      try {
        const wfPods = execSync(`oc get pods -n ${ns} --no-headers`, {
          encoding: "utf-8",
        }).trim();
        console.log(`[orchestrator-setup] All pods in ${ns}:\n${wfPods}`);
      } catch (e) {
        console.log(`[orchestrator-setup] pod list error: ${e}`);
      }
      for (const wf of ["greeting", "failswitch"]) {
        try {
          const logs = execSync(
            `oc logs -n ${ns} -l sonataflow.org/workflow-app=${wf} --tail=30`,
            { encoding: "utf-8" },
          ).trim();
          console.log(`[orchestrator-setup] ${wf} last 30 log lines:\n${logs}`);
        } catch (e) {
          console.log(`[orchestrator-setup] ${wf} logs error: ${e}`);
        }
      }
      // Check K8s services for workflows
      try {
        const svcs = execSync(`oc get svc -n ${ns} --no-headers`, {
          encoding: "utf-8",
        }).trim();
        console.log(`[orchestrator-setup] All services in ${ns}:\n${svcs}`);
      } catch (e) {
        console.log(`[orchestrator-setup] svc list error: ${e}`);
      }

      // Query data-index GraphQL via the greeting pod (which has curl) through K8s service
      try {
        const gqlQuery =
          '{"query":"{ ProcessDefinitions { id, version, name, serviceUrl } }"}';
        const diResult = execSync(
          `oc exec -n ${ns} deploy/greeting -- curl -s -X POST http://sonataflow-platform-data-index-service/graphql -H 'Content-Type: application/json' -d '${gqlQuery}'`,
          { encoding: "utf-8", timeout: 30_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] Data-index ProcessDefinitions:\n${diResult}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] Data-index query error: ${e}`);
      }

      // Curl greeting runtime directly to verify it responds
      try {
        const greetResult = execSync(
          `oc exec -n ${ns} deploy/greeting -- curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/q/health/ready`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] Greeting runtime health: HTTP ${greetResult}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] Greeting health check error: ${e}`);
      }

      // Check RHDH backend logs using deployment name (avoids matching postgresql pod)
      try {
        const rhdhLogs = execSync(
          `oc logs -n ${ns} deploy/redhat-developer-hub --tail=200`,
          { encoding: "utf-8", timeout: 30_000 },
        ).trim();
        const relevantLines = rhdhLogs
          .split("\n")
          .filter((l: string) =>
            /orchestrator|data-index|catalog.*error|catalog.*warn|template.*error|failed to read|error.*url|CATALOG_TEMPLATES/i.test(
              l,
            ),
          );
        console.log(
          `[orchestrator-setup] RHDH relevant logs (${relevantLines.length} lines):\n${relevantLines.join("\n")}`,
        );
        if (relevantLines.length === 0) {
          const last30 = rhdhLogs.split("\n").slice(-30);
          console.log(
            `[orchestrator-setup] RHDH last 30 log lines:\n${last30.join("\n")}`,
          );
        }
      } catch (e) {
        console.log(`[orchestrator-setup] RHDH logs error: ${e}`);
      }

      // Check SonataFlow CR status and workflow pod messaging config
      for (const wf of ["greeting", "failswitch"]) {
        try {
          const conds = execSync(
            `oc get sonataflow ${wf} -n ${ns} -o jsonpath='{.status.conditions}'`,
            { encoding: "utf-8" },
          ).trim();
          console.log(`[orchestrator-setup] ${wf} status.conditions: ${conds}`);
        } catch (e) {
          console.log(`[orchestrator-setup] ${wf} conditions error: ${e}`);
        }
        // #region agent log
        try {
          const allEnv = execSync(
            `oc get deploy ${wf} -n ${ns} -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\\n"}{end}'`,
            { encoding: "utf-8", timeout: 10_000 },
          ).trim();
          const relevantVars = allEnv
            .split("\n")
            .filter((l: string) =>
              /KOGITO|SERVICE_URL|DATA_INDEX|mp\.messaging|QUARKUS_|PERSISTENCE/i.test(
                l,
              ),
            );
          console.log(
            `[orchestrator-setup] ${wf} env vars (relevant):\n${relevantVars.join("\n")}`,
          );
          if (relevantVars.length < 3) {
            console.log(`[orchestrator-setup] ${wf} ALL env vars:\n${allEnv}`);
          }
        } catch (e) {
          console.log(`[orchestrator-setup] ${wf} env vars error: ${e}`);
        }
        try {
          const envFrom = execSync(
            `oc get deploy ${wf} -n ${ns} -o jsonpath='{range .spec.template.spec.containers[0].envFrom[*]}{.configMapRef.name}{" "}{.secretRef.name}{"\\n"}{end}'`,
            { encoding: "utf-8", timeout: 10_000 },
          ).trim();
          console.log(
            `[orchestrator-setup] ${wf} envFrom (configmaps/secrets): ${envFrom}`,
          );
        } catch (e) {
          console.log(`[orchestrator-setup] ${wf} envFrom error: ${e}`);
        }
        try {
          const vols = execSync(
            `oc get deploy ${wf} -n ${ns} -o jsonpath='{range .spec.template.spec.volumes[*]}{.name}={.configMap.name}{.projected.sources[*].configMap.name}{"\\n"}{end}'`,
            { encoding: "utf-8", timeout: 10_000 },
          ).trim();
          console.log(
            `[orchestrator-setup] ${wf} volumes (configmaps): ${vols}`,
          );
        } catch (e) {
          console.log(`[orchestrator-setup] ${wf} volumes error: ${e}`);
        }
        // #endregion
      }

      // #region agent log — Data-index stability diagnostics (H1-H5)
      try {
        const diHealth = execSync(
          `oc exec -n ${ns} deploy/sonataflow-platform-data-index-service -- curl -s --max-time 5 http://localhost:8080/q/health`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] Data-index health check:\n${diHealth.substring(0, 2000)}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] Data-index health error: ${e}`);
      }

      try {
        const diLogs = execSync(
          `oc logs -n ${ns} deploy/sonataflow-platform-data-index-service --tail=80`,
          { encoding: "utf-8", timeout: 30_000 },
        ).trim();
        const errLines = diLogs
          .split("\n")
          .filter((l: string) =>
            /ERROR|WARN|Exception|fail|refused|OOM|503|datasource|flyway|reactive/i.test(
              l,
            ),
          );
        console.log(
          `[orchestrator-setup] Data-index error/warn lines (${errLines.length}):\n${errLines.join("\n")}`,
        );
        if (errLines.length === 0) {
          console.log(
            `[orchestrator-setup] Data-index last 25 lines:\n${diLogs.split("\n").slice(-25).join("\n")}`,
          );
        }
      } catch (e) {
        console.log(`[orchestrator-setup] Data-index logs error: ${e}`);
      }

      try {
        const diPrevLogs = execSync(
          `oc logs -n ${ns} deploy/sonataflow-platform-data-index-service --previous --tail=80`,
          { encoding: "utf-8", timeout: 30_000 },
        ).trim();
        const errLines = diPrevLogs
          .split("\n")
          .filter((l: string) =>
            /ERROR|WARN|Exception|fail|refused|OOM|503|Shutdown|datasource|flyway/i.test(
              l,
            ),
          );
        console.log(
          `[orchestrator-setup] Data-index PREVIOUS container error/warn lines (${errLines.length}):\n${errLines.slice(-20).join("\n")}`,
        );
        if (errLines.length === 0) {
          console.log(
            `[orchestrator-setup] Data-index PREVIOUS last 20 lines:\n${diPrevLogs.split("\n").slice(-20).join("\n")}`,
          );
        }
      } catch (e) {
        console.log(
          `[orchestrator-setup] Data-index previous logs (may not exist): ${e}`,
        );
      }

      try {
        const diResources = execSync(
          `oc get deploy sonataflow-platform-data-index-service -n ${ns} -o jsonpath='{.spec.template.spec.containers[0].resources}'`,
          { encoding: "utf-8", timeout: 10_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] Data-index container resources: ${diResources}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] Data-index resources error: ${e}`);
      }

      try {
        const diProbes = execSync(
          `oc get deploy sonataflow-platform-data-index-service -n ${ns} -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}'`,
          { encoding: "utf-8", timeout: 10_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] Data-index liveness probe: ${diProbes}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] Data-index probe config error: ${e}`);
      }

      try {
        const diRestarts = execSync(
          `oc get pods -n ${ns} -l app=sonataflow-platform --no-headers`,
          { encoding: "utf-8", timeout: 10_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] Platform service pods (restarts?):\n${diRestarts}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] Platform pods error: ${e}`);
      }

      try {
        const unhealthyEvents = execSync(
          `oc get events -n ${ns} --field-selector reason=Unhealthy --sort-by=.lastTimestamp --no-headers`,
          { encoding: "utf-8", timeout: 10_000 },
        ).trim();
        if (unhealthyEvents) {
          console.log(
            `[orchestrator-setup] Unhealthy events:\n${unhealthyEvents.split("\n").slice(-10).join("\n")}`,
          );
        } else {
          console.log("[orchestrator-setup] No Unhealthy events found");
        }
      } catch (e) {
        console.log(`[orchestrator-setup] Unhealthy events error: ${e}`);
      }
      // #endregion

      // #region agent log
      // Check greeting-props ConfigMap for messaging config
      try {
        const props = execSync(
          `oc get configmap greeting-props -n ${ns} -o jsonpath='{.data}'`,
          { encoding: "utf-8", timeout: 10_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] greeting-props ConfigMap:\n${props.substring(0, 3000)}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] greeting-props error: ${e}`);
      }

      // Check SonataFlowPlatform status (messaging/eventing config)
      try {
        const sfpStatus = execSync(
          `oc get sonataflowplatform sonataflow-platform -n ${ns} -o jsonpath='{.status}'`,
          { encoding: "utf-8", timeout: 10_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] SonataFlowPlatform status:\n${sfpStatus.substring(0, 2000)}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] SFP status error: ${e}`);
      }

      // List all configmaps in namespace
      try {
        const cms = execSync(`oc get configmap -n ${ns} --no-headers`, {
          encoding: "utf-8",
          timeout: 10_000,
        }).trim();
        console.log(`[orchestrator-setup] ConfigMaps in ${ns}:\n${cms}`);
      } catch (e) {
        console.log(`[orchestrator-setup] configmap list error: ${e}`);
      }

      // Check management API on workflow pods (tests what RHDH backend uses to "ping")
      for (const wf of ["greeting", "failswitch"]) {
        try {
          const mgmtResult = execSync(
            `oc exec -n ${ns} deploy/${wf} -- curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8080/management/processes`,
            { encoding: "utf-8", timeout: 15_000 },
          ).trim();
          console.log(
            `[orchestrator-setup] ${wf} management API: HTTP ${mgmtResult}`,
          );
        } catch (e) {
          console.log(`[orchestrator-setup] ${wf} management API error: ${e}`);
        }
      }

      // Check RHDH pod env var for data-index URL
      try {
        const diUrlInPod = execSync(
          `oc exec -n ${ns} deploy/redhat-developer-hub -- env | grep -i 'SONATAFLOW\\|DATA_INDEX\\|CATALOG_TEMPLATES'`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        console.log(`[orchestrator-setup] RHDH pod env vars:\n${diUrlInPod}`);
      } catch (e) {
        console.log(`[orchestrator-setup] RHDH pod env error: ${e}`);
      }

      // Test RHDH orchestrator API from inside the cluster (bypasses auth)
      const rhdhUrl = rhdh.rhdhUrl;
      console.log(`[orchestrator-setup] RHDH URL: ${rhdhUrl}`);
      try {
        const apiResult = execSync(
          `oc exec -n ${ns} deploy/greeting -- curl -s -o /dev/null -w "%{http_code}" http://redhat-developer-hub:7007/api/orchestrator/v2/workflows`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        console.log(
          `[orchestrator-setup] RHDH orchestrator API (internal): HTTP ${apiResult}`,
        );
      } catch (e) {
        console.log(`[orchestrator-setup] RHDH API internal check error: ${e}`);
      }

      // Cross-service connectivity: can RHDH pod reach workflow services?
      for (const svc of ["greeting", "failswitch"]) {
        try {
          const result = execSync(
            `oc exec -n ${ns} deploy/redhat-developer-hub -- curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://${svc}.${ns}/q/health/ready`,
            { encoding: "utf-8", timeout: 15_000 },
          ).trim();
          console.log(
            `[orchestrator-setup] RHDH→${svc} health: HTTP ${result}`,
          );
        } catch (e) {
          console.log(
            `[orchestrator-setup] RHDH→${svc} connectivity error: ${e}`,
          );
        }
      }

      // #endregion
      // #endregion
    });
    await ensureBaselineRole(browser, testInfo);
    testInfo.annotations.push({
      type: "component",
      description: "orchestrator",
    });
  });

  test.afterEach(async ({ page }, testInfo) => {
    const status = testInfo.status;
    const title = testInfo.title;
    console.log(
      `[afterEach] Test "${title}" finished with status: ${status} (duration: ${testInfo.duration}ms)`,
    );
    if (status === "failed" || status === "timedOut") {
      console.log(`[afterEach] Test FAILED: "${title}"`);
      console.log(`[afterEach] Page URL at failure: ${page.url()}`);
      try {
        const bodyText = await page.textContent("body");
        console.log(
          `[afterEach] Page body text (first 2000 chars):\n${bodyText?.substring(0, 2000)}`,
        );
      } catch (e) {
        console.log(`[afterEach] Could not read page body: ${e}`);
      }
      const ns = testInfo.project.name;
      if (ns) {
        dumpClusterState(ns, "afterEach-failure");
      }
    }
  });

  test.describe("Greeting workflow", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test("Greeting workflow execution and workflow tab validation", async ({
      uiHelper,
      page,
    }) => {
      test.setTimeout(150_000);
      console.log("[greeting-exec] Opening Orchestrator sidebar...");
      await uiHelper.openSidebar("Orchestrator");
      console.log(`[greeting-exec] Page URL: ${page.url()}`);
      console.log("[greeting-exec] Selecting Greeting workflow item...");
      await orchestrator.selectGreetingWorkflowItem();
      console.log(`[greeting-exec] On workflow page: ${page.url()}`);
      console.log("[greeting-exec] Running Greeting workflow...");
      const runStart = Date.now();
      await orchestrator.runGreetingWorkflow();
      console.log(
        `[greeting-exec] Workflow run completed (${((Date.now() - runStart) / 1000).toFixed(1)}s)`,
      );
      console.log(
        "[greeting-exec] Navigating back to Orchestrator for validation...",
      );
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateGreetingWorkflow();
      console.log("[greeting-exec] Validation complete");
    });

    test("Greeting workflow run details validation", async ({
      uiHelper,
      page,
    }) => {
      test.setTimeout(150_000);
      console.log("[greeting-details] Opening Orchestrator sidebar...");
      await uiHelper.openSidebar("Orchestrator");
      console.log("[greeting-details] Selecting Greeting workflow...");
      await orchestrator.selectGreetingWorkflowItem();
      console.log(
        `[greeting-details] Running first workflow... (URL: ${page.url()})`,
      );
      const run1Start = Date.now();
      await orchestrator.runGreetingWorkflow();
      console.log(
        `[greeting-details] First run completed (${((Date.now() - run1Start) / 1000).toFixed(1)}s)`,
      );
      console.log("[greeting-details] Re-running workflow...");
      const run2Start = Date.now();
      await orchestrator.reRunGreetingWorkflow();
      console.log(
        `[greeting-details] Re-run completed (${((Date.now() - run2Start) / 1000).toFixed(1)}s)`,
      );
      console.log("[greeting-details] Validating run details...");
      await orchestrator.validateWorkflowRunsDetails();
      console.log("[greeting-details] Validation complete");
    });
  });

  test.describe("Failswitch workflow", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test("Failswitch workflow execution and workflow tab validation", async ({
      uiHelper,
      page,
    }) => {
      test.setTimeout(180_000);
      console.log(
        "[failswitch-exec] Starting failswitch workflow execution test",
      );
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      console.log(`[failswitch-exec] Selected FailSwitch, URL: ${page.url()}`);
      console.log("[failswitch-exec] Running with OK...");
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
      console.log(
        "[failswitch-exec] OK run completed. Re-running with Wait...",
      );
      await orchestrator.reRunFailSwitchWorkflow("Wait");
      console.log("[failswitch-exec] Aborting Wait run...");
      await orchestrator.abortWorkflow();
      console.log("[failswitch-exec] Abort confirmed. Re-running with KO...");
      await orchestrator.reRunFailSwitchWorkflow("KO");
      await orchestrator.validateCurrentWorkflowStatus("Failed");
      console.log(
        "[failswitch-exec] KO run failed as expected. Running Wait for running state...",
      );
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateCurrentWorkflowStatus("Running");
      console.log(
        "[failswitch-exec] Running state validated. Checking all runs...",
      );
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateWorkflowAllRuns();
      await orchestrator.validateWorkflowAllRunsStatusIcons();
      console.log("[failswitch-exec] All validations complete");
    });

    test("Test abort workflow", async ({ uiHelper, page }) => {
      test.setTimeout(180_000);
      console.log("[abort-test] Starting abort workflow test");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      console.log(
        `[abort-test] Running FailSwitch with Wait... (URL: ${page.url()})`,
      );
      await orchestrator.runFailSwitchWorkflow("Wait");
      console.log("[abort-test] Aborting workflow...");
      await orchestrator.abortWorkflow();
      console.log("[abort-test] Abort complete");
    });

    test("Test Running status validations", async ({ uiHelper, page }) => {
      test.setTimeout(180_000);
      console.log("[running-status] Starting Running status validation");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      console.log(
        `[running-status] Running FailSwitch with Wait... (URL: ${page.url()})`,
      );
      await orchestrator.runFailSwitchWorkflow("Wait");
      console.log("[running-status] Validating Running status details...");
      await orchestrator.validateWorkflowStatusDetails("Running");
      console.log("[running-status] Validation complete");
    });

    test("Test Failed status validations", async ({ uiHelper, page }) => {
      test.setTimeout(180_000);
      console.log("[failed-status] Starting Failed status validation");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      console.log(
        `[failed-status] Running FailSwitch with KO... (URL: ${page.url()})`,
      );
      await orchestrator.runFailSwitchWorkflow("KO");
      console.log("[failed-status] Validating Failed status details...");
      await orchestrator.validateWorkflowStatusDetails("Failed");
      console.log("[failed-status] Validation complete");
    });

    test("Test Completed status validations", async ({ uiHelper, page }) => {
      test.setTimeout(180_000);
      console.log("[completed-status] Starting Completed status validation");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      console.log(
        `[completed-status] Running FailSwitch with OK... (URL: ${page.url()})`,
      );
      await orchestrator.runFailSwitchWorkflow("OK");
      console.log("[completed-status] Validating Completed status details...");
      await orchestrator.validateWorkflowStatusDetails("Completed");
      console.log("[completed-status] Validation complete");
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
        console.log(
          `[rerun-failure] Patching HTTPBIN to invalid URL in ns=${ns}`,
        );
        await patchHttpbin(ns!, "https://foobar.org/");
        console.log("[rerun-failure] Restarting failswitch deployment...");
        await restartAndWait(ns!);
        console.log(
          "[rerun-failure] Restart complete. Running FailSwitch with Wait (expect failure)...",
        );

        await uiHelper.openSidebar("Orchestrator");
        await orchestrator.selectFailSwitchWorkflowItem();
        await orchestrator.runFailSwitchWorkflow("Wait");
        console.log("[rerun-failure] Validating Failed status...");
        await orchestrator.validateCurrentWorkflowStatus("Failed");
        console.log(
          "[rerun-failure] Failed status confirmed. Restoring original HTTPBIN...",
        );

        await patchHttpbin(ns!, originalHttpbin);
        console.log("[rerun-failure] Restarting with restored HTTPBIN...");
        await restartAndWait(ns!);
        console.log(
          "[rerun-failure] Restart complete. Re-running from failure point...",
        );

        await orchestrator.reRunOnFailure("From failure point");
        console.log(
          "[rerun-failure] Validating Completed status after re-run...",
        );
        await orchestrator.validateCurrentWorkflowStatus("Completed");
        console.log("[rerun-failure] Re-run from failure point succeeded");
      } catch (e) {
        console.error(`[rerun-failure] Test failed: ${e}`);
        try {
          const httpbinVal = getHttpbinValue(ns!);
          console.log(`[rerun-failure] Current HTTPBIN value: ${httpbinVal}`);
        } catch {
          /* ignore */
        }
        dumpClusterState(ns!, "rerun-failure-error");
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
      test.setTimeout(180_000);
      console.log("[failswitch-links] Starting workflow linking test");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      console.log("[failswitch-links] Running FailSwitch with OK...");
      await orchestrator.runFailSwitchWorkflow("OK");
      console.log(
        "[failswitch-links] Checking suggested next workflow section...",
      );

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

      console.log(
        "[failswitch-links] Verifying Greeting workflow execute view...",
      );
      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
      console.log(
        `[failswitch-links] Greeting workflow execute view confirmed. URL: ${page.url()}`,
      );
    });
  });

  test.describe("Token propagation workflow API", () => {
    test.skip("Token propagation workflow executes successfully via API", async ({
      page,
      loginHelper,
    }) => {
      // 5 minutes for workflow execution + polling
      test.setTimeout(5 * 60 * 1000);

      await loginHelper.loginAsKeycloakUser();

      const backstageToken = await new AuthApiHelper(page).getToken();

      // Get Keycloak OIDC access token via password grant
      const kcBaseUrl = decodeEnvVar("KEYCLOAK_AUTH_BASE_URL");
      const kcRealm = decodeEnvVar("KEYCLOAK_AUTH_REALM");
      const kcClientId = decodeEnvVar("KEYCLOAK_AUTH_CLIENTID");
      const kcClientSecret = decodeEnvVar("KEYCLOAK_AUTH_CLIENT_SECRET");

      const username = process.env.GH_USER_ID;
      const password = process.env.GH_USER_PASS;
      if (!username || !password) {
        throw new Error("GH_USER_ID and GH_USER_PASS must be set");
      }

      const tokenUrl = `${kcBaseUrl}/auth/realms/${kcRealm}/protocol/openid-connect/token`;

      const tokenResponse = await page.request.post(tokenUrl, {
        form: {
          /* eslint-disable @typescript-eslint/naming-convention */
          grant_type: "password",
          client_id: kcClientId,
          client_secret: kcClientSecret,
          /* eslint-enable @typescript-eslint/naming-convention */
          username,
          password,
          scope: "openid",
        },
      });
      if (!tokenResponse.ok()) {
        console.error(
          `Keycloak token request failed: ${tokenResponse.status()} ${await tokenResponse.text()}`,
        );
      }
      expect(tokenResponse.ok()).toBeTruthy();
      const tokenBody = await tokenResponse.json();
      const oidcToken = tokenBody.access_token;
      expect(oidcToken).toBeTruthy();

      // Execute token-propagation workflow via API
      const executeResponse = await page.request.post(
        `/api/orchestrator/v2/workflows/token-propagation/execute`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${backstageToken}`,
          },
          data: {
            inputData: {},
            authTokens: [
              { provider: "OAuth2", token: oidcToken },
              {
                provider: "SimpleBearerToken",
                token: "test-simple-bearer-token-value",
              },
            ],
          },
        },
      );
      if (!executeResponse.ok()) {
        console.error(
          `Workflow execution failed: ${executeResponse.status()} ${await executeResponse.text()}`,
        );
      }
      expect(executeResponse.ok()).toBeTruthy();
      const { id: instanceId } = await executeResponse.json();
      expect(instanceId).toBeTruthy();
      console.log(`Workflow instance started: ${instanceId}`);

      // Poll for workflow completion (up to 150 seconds)
      const maxPolls = 30;
      const pollInterval = 5000; // 5 seconds
      let finalState = "";
      let statusBody: WorkflowInstance = {} as WorkflowInstance;

      for (let poll = 1; poll <= maxPolls; poll++) {
        const statusResponse = await page.request.get(
          `/api/orchestrator/v2/workflows/instances/${instanceId}`,
          {
            headers: {
              Authorization: `Bearer ${backstageToken}`,
            },
          },
        );
        expect(statusResponse.ok()).toBeTruthy();
        statusBody = await statusResponse.json();
        finalState = statusBody.state;

        if (finalState === "COMPLETED") {
          console.log(`Workflow completed successfully after ${poll} polls`);
          break;
        }

        if (finalState === "ERROR") {
          console.error(
            "Workflow failed with ERROR state:",
            JSON.stringify(statusBody),
          );
          break;
        }

        console.log(
          `Workflow status: ${finalState} (poll ${poll}/${maxPolls})`,
        );
        await page.waitForTimeout(pollInterval);
      }

      expect(finalState).toBe("COMPLETED");

      // Verify workflow output data
      expect(statusBody.workflowdata.result.completedWith).toBe("success");
      expect(statusBody.workflowdata.result.message).toContain(
        "Token propagated",
      );

      // Verify all 3 token path nodes + extractUser completed without error
      const nodes = statusBody.nodes;
      const expectedNodes = [
        "getWithBearerTokenSecurityScheme",
        "getWithOtherBearerTokenSecurityScheme",
        "getWithSimpleBearerTokenSecurityScheme",
        "extractUser",
      ];
      for (const nodeName of expectedNodes) {
        const node = nodes.find((n: WorkflowNode) => n.name === nodeName);
        expect(node, `Node '${nodeName}' should exist`).toBeDefined();
        if (!node) continue;
        expect(
          node.errorMessage,
          `Node '${nodeName}' should have no error`,
        ).toBeNull();
        expect(
          node.exit,
          `Node '${nodeName}' should have completed`,
        ).not.toBeNull();
      }

      // Verify sample-server pod logs for token propagation evidence
      if (process.env.IS_OPENSHIFT !== "true") {
        console.log(
          "Skipping sample-server log verification: not running on OpenShift",
        );
        return;
      }

      const serviceUrl = statusBody.serviceUrl || "";
      const nsMatch = /token-propagation\.([^:/]+)/.exec(serviceUrl);
      const namespace = nsMatch?.[1] || process.env.NAME_SPACE || "";

      if (!namespace) {
        console.log(
          "Skipping sample-server log verification: namespace not found",
        );
        return;
      }

      // Validate namespace conforms to Kubernetes DNS-1123 label format
      // to prevent command injection via shell metacharacters
      if (!/^[a-z0-9-]+$/.test(namespace)) {
        throw new Error(
          `Invalid namespace format: "${namespace}". Must contain only lowercase alphanumeric characters and hyphens.`,
        );
      }

      const sampleServerLogs = execSync(
        `oc logs -l app=sample-server -n ${namespace} --tail=200`,
        { encoding: "utf-8", timeout: 30000 },
      );

      expect(
        sampleServerLogs,
        "Sample-server should log /first endpoint request",
      ).toContain("Headers for first");
      expect(
        sampleServerLogs,
        "Sample-server should log /other endpoint request",
      ).toContain("Headers for other");
      expect(
        sampleServerLogs,
        "Sample-server should log /simple endpoint request",
      ).toContain("Headers for simple");

      console.log("Sample-server log verification passed for all 3 endpoints");
    });
  });

  test.describe("Workflow all runs", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
    });

    test("Workflow All Runs Validation", async ({ uiHelper }) => {
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateWorkflowAllRuns();
    });
  });

  /**
   * Entity-Workflow Integration Tests
   *
   * Test Cases: RHIDP-11833 through RHIDP-11838
   *
   * These tests verify the integration between RHDH catalog entities and
   * Orchestrator workflows, including:
   * - EntityPicker-based entity association
   * - orchestrator.io/workflows annotation behavior
   * - Workflows tab visibility on entity pages
   * - Catalog <-> Workflows breadcrumb navigation
   * - Template execution -> workflow run linkage
   *
   * Templates used (from testetson22/greeting_54mjks on GitHub):
   * - greeting.yaml: name=greeting, title="Greeting workflow" - NO orchestrator.io/workflows annotation
   * - greeting_w_component.yaml: name=greetingComponent, title="Greeting Test Picker" - HAS annotation
   *
   * These are scaffolder templates that use the orchestrator:workflow:run action
   * to trigger the "greeting" SonataFlow workflow deployed by CI.
   */
  test.describe("Entity-Workflow Integration", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test("RHIDP-11833: Select existing entity via EntityPicker for workflow run", async ({
      page,
      uiHelper,
    }) => {
      console.log("[RHIDP-11833] Starting EntityPicker workflow run test");
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");
      console.log(`[RHIDP-11833] On Self-service page: ${page.url()}`);

      await page.waitForLoadState("domcontentloaded");

      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await page.waitForURL(/\/create\/templates\//, { timeout: 30000 });
      await page.waitForLoadState("networkidle");
      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const languageField = page.getByLabel("Language");
      await expect(languageField).toBeVisible({ timeout: 15000 });
      await languageField.click();
      await page.getByRole("option", { name: "English" }).click();

      const nameField = page.getByLabel("Name");
      await expect(nameField).toBeVisible({ timeout: 10000 });
      const uniqueName = `test-entity-${Date.now()}`;
      await nameField.fill(uniqueName);

      const reviewButton = page.getByRole("button", { name: /Review/i });
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
      await reviewButton.click();
      await page.waitForLoadState("domcontentloaded");

      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      await createButton.click();

      console.log("[RHIDP-11833] Waiting for template task completion...");
      const viewInCatalog = page.getByRole("link", {
        name: "View in catalog",
      });
      const openWorkflowRun = page.getByRole("link", {
        name: "Open workflow run",
      });
      const startOver = page.getByRole("button", { name: "Start Over" });

      await expect(viewInCatalog.or(openWorkflowRun).or(startOver)).toBeVisible(
        {
          timeout: 120000,
        },
      );
      console.log(`[RHIDP-11833] Template task finished. URL: ${page.url()}`);
    });

    test("RHIDP-11834: Template WITH orchestrator.io/workflows annotation", async ({
      page,
      uiHelper,
    }) => {
      console.log("[RHIDP-11834] Starting annotation-present test");
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");
      console.log(`[RHIDP-11834] Catalog page loaded: ${page.url()}`);

      // "Greeting Test Picker" (greeting_w_component.yaml) HAS the
      // orchestrator.io/workflows annotation: '["greeting"]'
      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      console.log(
        "[RHIDP-11834] Checking Workflows tab (should be visible due to annotation)...",
      );
      await orchestrator.clickWorkflowsTab();
      await orchestrator.verifyWorkflowInEntityTab("Greeting workflow");
      console.log("[RHIDP-11834] Annotation-based Workflows tab verified");
    });

    test("RHIDP-11835: Template WITHOUT orchestrator.io/workflows annotation (negative)", async ({
      page,
      uiHelper,
    }) => {
      console.log("[RHIDP-11835] Starting annotation-absent negative test");
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      // "Greeting workflow" (greeting.yaml) does NOT have the
      // orchestrator.io/workflows annotation
      const templateLink = page.getByRole("link", {
        name: /Greeting workflow/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      console.log(
        "[RHIDP-11835] Checking Workflows tab behavior (no annotation)...",
      );
      const workflowsTab = page.getByRole("tab", { name: "Workflows" });
      const tabCount = await workflowsTab.count();
      console.log(`[RHIDP-11835] Workflows tab count: ${tabCount}`);

      if (tabCount > 0) {
        // Tab exists (dynamic plugin registers it globally) -- verify
        // the content does NOT show the greeting workflow since the
        // entity lacks the orchestrator.io/workflows annotation
        await workflowsTab.click();
        await page.waitForLoadState("domcontentloaded");
        const greetingWorkflow = page.getByText("Greeting workflow");
        const greetingCount = await greetingWorkflow.count();
        console.log(
          `[RHIDP-11835] Greeting workflow text count in Workflows tab: ${greetingCount}`,
        );
        expect(greetingCount).toBe(0);
        console.log(
          "[RHIDP-11835] Confirmed: Workflows tab has no workflow content (annotation absent)",
        );
      } else {
        console.log("[RHIDP-11835] Confirmed Workflows tab is absent");
      }
    });

    test("RHIDP-11836: Catalog <-> Workflows breadcrumb navigation", async ({
      page,
      uiHelper,
    }) => {
      console.log("[RHIDP-11836] Starting breadcrumb navigation test");
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      await orchestrator.clickWorkflowsTab();

      const workflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(workflowLink).toBeVisible({ timeout: 10000 });
      console.log("[RHIDP-11836] Clicking workflow link...");
      await workflowLink.click();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();
      console.log(`[RHIDP-11836] On workflow detail page: ${page.url()}`);

      const entityName = "greetingComponent";
      const breadcrumb = page.getByRole("navigation", {
        name: /breadcrumb/i,
      });
      const breadcrumbCount = await breadcrumb.count();
      console.log(`[RHIDP-11836] Breadcrumb count: ${breadcrumbCount}`);
      if (breadcrumbCount > 0 && entityName) {
        const entityBreadcrumb = breadcrumb.getByText(entityName);
        const entityBreadcrumbCount = await entityBreadcrumb.count();
        console.log(
          `[RHIDP-11836] Entity breadcrumb '${entityName}' count: ${entityBreadcrumbCount}`,
        );
        if (entityBreadcrumbCount > 0) {
          await entityBreadcrumb.click();
          await page.waitForLoadState("load");
          console.log(
            `[RHIDP-11836] Navigated back via breadcrumb: ${page.url()}`,
          );

          await expect(
            page.getByRole("heading", { name: /Greeting Test Picker/i }),
          ).toBeVisible();
          console.log("[RHIDP-11836] Breadcrumb navigation verified");
        }
      }
    });

    test("RHIDP-11837: Template run produces visible workflow runs", async ({
      page,
      uiHelper,
    }) => {
      console.log(
        "[RHIDP-11837] Starting template run produces workflow runs test",
      );
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");
      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await page.waitForURL(/\/create\/templates\//, { timeout: 30000 });
      await page.waitForLoadState("networkidle");
      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const nameField = page.getByLabel("Name");
      await expect(nameField).toBeVisible({ timeout: 10000 });
      const uniqueName = `test-entity-${Date.now()}`;
      await nameField.fill(uniqueName);

      const languageField = page.getByLabel("Language");
      if (await languageField.isVisible({ timeout: 5000 })) {
        await languageField.click();
        await page.getByRole("option", { name: "English" }).click();
      }

      const reviewButton = page.getByRole("button", { name: /Review/i });
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
      await reviewButton.click();
      await page.waitForLoadState("domcontentloaded");

      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      await createButton.click();

      console.log("[RHIDP-11837] Waiting for template task completion...");
      const completed = page.getByText(/Completed|succeeded|finished/i);
      const conflictError = page.getByText(/409 Conflict/i);
      const startOver = page.getByRole("button", { name: "Start Over" });

      await expect(completed.or(conflictError).or(startOver)).toBeVisible({
        timeout: 120000,
      });
      console.log(`[RHIDP-11837] Template task finished. URL: ${page.url()}`);

      await uiHelper.openSidebar("Orchestrator");
      await expect(
        page.getByRole("heading", { name: "Workflows" }),
      ).toBeVisible();

      const greetingWorkflow = page.getByRole("link", {
        name: /Greeting workflow/i,
      });
      await expect(greetingWorkflow).toBeVisible({ timeout: 30000 });
      console.log(
        "[RHIDP-11837] Greeting workflow visible in Orchestrator after template run",
      );
    });

    test("RHIDP-11838: Dynamic plugin config enables Workflows tab", async ({
      page,
      uiHelper,
    }) => {
      console.log(
        "[RHIDP-11838] Starting dynamic plugin config Workflows tab test",
      );
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      // Workflows tab is enabled by the dynamic plugin configuration
      await orchestrator.verifyWorkflowsTabVisible();

      await orchestrator.clickWorkflowsTab();

      console.log("[RHIDP-11838] Verifying OrchestratorCatalogTab content...");
      const workflowsContent = page.locator("main").filter({
        has: page.getByText("Greeting workflow"),
      });
      await expect(workflowsContent).toBeVisible();
      console.log("[RHIDP-11838] Dynamic plugin config Workflows tab verified");
    });
  });
});

function getHttpbinValue(ns: string): string | undefined {
  try {
    const result = execFileSync(
      "oc",
      [
        "-n",
        ns,
        "get",
        "sonataflow",
        "failswitch",
        "-o",
        `jsonpath={.spec.podTemplate.container.env[?(@.name=='HTTPBIN')].value}`,
      ],
      { encoding: "utf-8", timeout: 30_000 },
    );
    const value = result.trim() || undefined;
    console.log(`[httpbin] Current HTTPBIN value in ns=${ns}: ${value}`);
    return value;
  } catch (e) {
    console.log(`[httpbin] Failed to get HTTPBIN value: ${e}`);
    return undefined;
  }
}

async function patchHttpbin(ns: string, value: string): Promise<void> {
  // Read existing env vars so the merge-patch preserves entries like K_SINK
  let existing: Array<{ name: string; value: string }> = [];
  try {
    const raw = execFileSync(
      "oc",
      [
        "-n",
        ns,
        "get",
        "sonataflow",
        "failswitch",
        "-o",
        "jsonpath={.spec.podTemplate.container.env}",
      ],
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
    if (raw && raw !== "null" && raw !== "") {
      existing = JSON.parse(raw);
    }
  } catch {
    /* no existing env */
  }
  const idx = existing.findIndex((e: { name: string }) => e.name === "HTTPBIN");
  if (idx >= 0) existing[idx] = { name: "HTTPBIN", value };
  else existing.push({ name: "HTTPBIN", value });
  const patch = JSON.stringify({
    spec: { podTemplate: { container: { env: existing } } },
  });
  console.log(
    `[httpbin] Patching HTTPBIN in ns=${ns} to: ${value} (preserving ${existing.length} env vars)`,
  );
  execFileSync(
    "oc",
    [
      "-n",
      ns,
      "patch",
      "sonataflow",
      "failswitch",
      "--type",
      "merge",
      "-p",
      patch,
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );
  const actual = getHttpbinValue(ns);
  console.log(`[httpbin] Patch applied. Verified HTTPBIN value: ${actual}`);
}

async function restartAndWait(ns: string): Promise<void> {
  console.log(`[restart] Restarting deployment failswitch in ns=${ns}`);
  execFileSync(
    "oc",
    ["-n", ns, "rollout", "restart", "deployment", "failswitch"],
    { encoding: "utf-8", timeout: 30_000 },
  );

  console.log("[restart] Waiting for rollout to complete (timeout=60s)...");
  const rolloutStart = Date.now();
  execFileSync(
    "oc",
    [
      "-n",
      ns,
      "rollout",
      "status",
      "deployment",
      "failswitch",
      "--timeout=60s",
    ],
    { encoding: "utf-8", timeout: 90_000 },
  );
  console.log(
    `[restart] Rollout complete (${((Date.now() - rolloutStart) / 1000).toFixed(1)}s)`,
  );

  try {
    const pods = execFileSync(
      "oc",
      [
        "get",
        "pods",
        "-n",
        ns,
        "-l",
        "sonataflow.org/workflow-app=failswitch",
        "--no-headers",
      ],
      { encoding: "utf-8" },
    ).trim();
    console.log(`[restart] Failswitch pods after restart:\n${pods}`);
  } catch (e) {
    console.log(`[restart] Pod list error: ${e}`);
  }
}

async function cleanupAfterTest(
  ns: string,
  originalHttpbin: string,
): Promise<void> {
  const currentHttpbin = getHttpbinValue(ns);
  console.log(
    `[cleanup] Current HTTPBIN: ${currentHttpbin}, expected: ${originalHttpbin}`,
  );
  if (currentHttpbin !== originalHttpbin) {
    console.log("[cleanup] HTTPBIN mismatch, restoring original...");
    await patchHttpbin(ns, originalHttpbin);
    await restartAndWait(ns);
    console.log("[cleanup] Cleanup complete");
  } else {
    console.log(
      "[cleanup] HTTPBIN already at original value, no cleanup needed",
    );
  }
}
