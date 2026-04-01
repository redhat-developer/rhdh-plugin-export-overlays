import { execSync } from "child_process";
import { join } from "path";
import { installOrchestrator } from "rhdh-e2e-test-utils/orchestrator";
import { $ } from "rhdh-e2e-test-utils/utils";

const WORKFLOW_REPO =
  "https://github.com/rhdhorchestrator/serverless-workflows.git";

const MANIFEST_DIRS = [
  "workflows/greeting/manifests",
  "workflows/fail-switch/src/main/resources/manifests",
];

const WORKFLOWS = ["greeting", "failswitch"];

export async function deploySonataflow(namespace: string): Promise<void> {
  const deployStart = Date.now();
  console.log(`[deploy-sonataflow] Starting deployment in namespace: ${namespace}`);
  console.log(`[deploy-sonataflow] Workflow repo: ${WORKFLOW_REPO}`);
  console.log(`[deploy-sonataflow] Manifest dirs: ${MANIFEST_DIRS.join(", ")}`);

  try {
    const ocUser = oc("whoami");
    const ocServer = oc("whoami --show-server");
    console.log(`[deploy-sonataflow] Cluster: user=${ocUser}, server=${ocServer}`);
  } catch (e) { console.log(`[deploy-sonataflow] Cluster info error: ${e}`); }

  console.log("[deploy-sonataflow] Installing orchestrator operator...");
  const installStart = Date.now();
  await installOrchestrator(namespace);
  console.log(`[deploy-sonataflow] Orchestrator operator installed (${((Date.now() - installStart) / 1000).toFixed(1)}s)`);

  try {
    const subscriptions = oc("get subscriptions.operators.coreos.com -n openshift-operators --no-headers");
    console.log(`[deploy-sonataflow] Operator subscriptions:\n${subscriptions}`);
  } catch (e) { console.log(`[deploy-sonataflow] Subscription list error: ${e}`); }

  try {
    const csvs = oc("get csv -n openshift-operators --no-headers");
    console.log(`[deploy-sonataflow] ClusterServiceVersions:\n${csvs}`);
  } catch (e) { console.log(`[deploy-sonataflow] CSV list error: ${e}`); }

  // #region agent log — H6: Patch SFP with resource limits + disable messaging health on data-index
  console.log("[deploy-sonataflow] Patching SonataFlowPlatform with resource limits and messaging health override...");
  try {
    const sfpPatch = JSON.stringify({
      spec: {
        services: {
          dataIndex: {
            podTemplate: {
              container: {
                resources: {
                  requests: { memory: "64Mi", cpu: "250m" },
                  limits: { memory: "1Gi", cpu: "500m" },
                },
                env: [
                  {
                    name: "QUARKUS_SMALLRYE_REACTIVE_MESSAGING_HEALTH_ENABLED",
                    value: "false",
                  },
                ],
              },
            },
          },
          jobService: {
            podTemplate: {
              container: {
                resources: {
                  requests: { memory: "64Mi", cpu: "250m" },
                  limits: { memory: "1Gi", cpu: "500m" },
                },
              },
            },
          },
        },
      },
    });
    const sfpResult = oc(`-n ${namespace} patch sonataflowplatform sonataflow-platform --type merge -p '${sfpPatch}'`);
    console.log(`[deploy-sonataflow] SFP resource patch result: ${sfpResult}`);

    console.log("[deploy-sonataflow] Waiting for data-index rollout after SFP patch...");
    const diRollout = oc(`rollout status deployment/sonataflow-platform-data-index-service -n ${namespace} --timeout=300s`);
    console.log(`[deploy-sonataflow] Data-index rollout: ${diRollout}`);

    console.log("[deploy-sonataflow] Waiting for jobs-service rollout after SFP patch...");
    const jsRollout = oc(`rollout status deployment/sonataflow-platform-jobs-service -n ${namespace} --timeout=300s`);
    console.log(`[deploy-sonataflow] Jobs-service rollout: ${jsRollout}`);
  } catch (e) {
    console.log(`[deploy-sonataflow] SFP resource patch error (non-fatal): ${e}`);
  }

  // Verify resources and env were applied
  try {
    const diResources = oc(`get deploy sonataflow-platform-data-index-service -n ${namespace} -o jsonpath='{.spec.template.spec.containers[0].resources}'`);
    console.log(`[deploy-sonataflow] Data-index resources after patch: ${diResources}`);
    const diEnv = oc(`get deploy sonataflow-platform-data-index-service -n ${namespace} -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="QUARKUS_SMALLRYE_REACTIVE_MESSAGING_HEALTH_ENABLED")].value}'`);
    console.log(`[deploy-sonataflow] Data-index QUARKUS_SMALLRYE_REACTIVE_MESSAGING_HEALTH_ENABLED: ${diEnv}`);
  } catch (e) { console.log(`[deploy-sonataflow] Data-index verification error: ${e}`); }
  // #endregion

  const workflowDir = `/tmp/serverless-workflows-${process.pid}`;
  try {
    console.log(`[deploy-sonataflow] Cloning workflow repo to ${workflowDir}...`);
    const cloneStart = Date.now();
    await $`git clone --depth=1 ${WORKFLOW_REPO} ${workflowDir}`;
    console.log(`[deploy-sonataflow] Clone completed (${((Date.now() - cloneStart) / 1000).toFixed(1)}s)`);

    try {
      const cloneHead = execSync("git rev-parse HEAD", { cwd: workflowDir, encoding: "utf-8" }).trim();
      console.log(`[deploy-sonataflow] Cloned repo HEAD: ${cloneHead}`);
    } catch (e) { console.log(`[deploy-sonataflow] Clone HEAD read error: ${e}`); }

    for (const rel of MANIFEST_DIRS) {
      const fullPath = join(workflowDir, rel);
      console.log(`[deploy-sonataflow] Applying manifests: oc apply -n ${namespace} -f ${fullPath}`);
      try {
        const files = execSync(`ls -la ${fullPath}`, { encoding: "utf-8" }).trim();
        console.log(`[deploy-sonataflow] Manifest directory contents:\n${files}`);
      } catch (e) { console.log(`[deploy-sonataflow] ls error: ${e}`); }
      const applyStart = Date.now();
      await $`oc apply -n ${namespace} -f ${fullPath}`;
      console.log(`[deploy-sonataflow] Apply completed for ${rel} (${((Date.now() - applyStart) / 1000).toFixed(1)}s)`);
    }
  } finally {
    await $`rm -rf ${workflowDir}`.catch(() => {});
  }

  // #region agent log
  console.log("[deploy-sonataflow] Manifests applied, waiting for CRs...");
  // #endregion

  await waitForCRs(namespace);

  // #region agent log
  console.log("[deploy-sonataflow] CRs found. Dumping pre-patch status:");
  for (const wf of WORKFLOWS) {
    try {
      const status = oc(`get sonataflow ${wf} -n ${namespace} -o jsonpath='{.status.conditions}'`);
      console.log(`[deploy-sonataflow]   ${wf} conditions: ${status}`);
    } catch (e) { console.log(`[deploy-sonataflow]   ${wf} status error: ${e}`); }
    try {
      const persistence = oc(`get sonataflow ${wf} -n ${namespace} -o jsonpath='{.spec.persistence}'`);
      console.log(`[deploy-sonataflow]   ${wf} persistence (pre-patch): ${persistence}`);
    } catch (e) { console.log(`[deploy-sonataflow]   ${wf} persistence read error: ${e}`); }
  }
  // #endregion

  for (const workflow of WORKFLOWS) {
    // #region agent log
    console.log(`[deploy-sonataflow] Patching ${workflow} persistence...`);
    // #endregion

    const patchResult = patchWorkflowPostgres(namespace, workflow);

    // #region agent log
    console.log(`[deploy-sonataflow] Patch result for ${workflow}: ${patchResult}`);
    // #endregion

    // #region agent log
    try {
      const persistence = oc(`get sonataflow ${workflow} -n ${namespace} -o jsonpath='{.spec.persistence}'`);
      console.log(`[deploy-sonataflow]   ${workflow} persistence (post-patch): ${persistence}`);
    } catch (e) { console.log(`[deploy-sonataflow]   ${workflow} post-patch read error: ${e}`); }
    // #endregion

    // #region agent log
    console.log(`[deploy-sonataflow] Waiting for ${workflow} reconciliation...`);
    // #endregion

    await waitForReconciliation(namespace, workflow, 60);

    // #region agent log
    console.log(`[deploy-sonataflow] Running rollout status for ${workflow}...`);
    // #endregion

    const rolloutResult = oc(`rollout status deployment/${workflow} -n ${namespace} --timeout=600s`);

    // #region agent log
    console.log(`[deploy-sonataflow] Rollout ${workflow}: ${rolloutResult}`);
    // #endregion
  }

  // #region agent log
  console.log("[deploy-sonataflow] All workflows patched. Final diagnostics:");
  for (const wf of WORKFLOWS) {
    try {
      const status = oc(`get sonataflow ${wf} -n ${namespace} -o jsonpath='{.status.conditions}'`);
      console.log(`[deploy-sonataflow]   ${wf} final conditions: ${status}`);
    } catch (e) { console.log(`[deploy-sonataflow]   ${wf} final status error: ${e}`); }
    try {
      const pods = oc(`get pods -n ${namespace} -l sonataflow.org/workflow-app=${wf} --no-headers`);
      console.log(`[deploy-sonataflow]   ${wf} pods: ${pods}`);
    } catch (e) { console.log(`[deploy-sonataflow]   ${wf} pods error: ${e}`); }
    try {
      const logs = oc(`logs -n ${namespace} -l sonataflow.org/workflow-app=${wf} --tail=20`);
      console.log(`[deploy-sonataflow]   ${wf} last 20 log lines:\n${logs}`);
    } catch (e) { console.log(`[deploy-sonataflow]   ${wf} logs error: ${e}`); }
  }
  // #region agent log — Data-index crash diagnostics (H1-H5)
  try {
    const diPods = oc(`get pods -n ${namespace} -l app=sonataflow-platform --no-headers`);
    console.log(`[deploy-sonataflow]   data-index/jobs-service pods:\n${diPods}`);
  } catch (e) { console.log(`[deploy-sonataflow]   platform pods error: ${e}`); }
  try {
    const diLogs = oc(`logs -n ${namespace} deploy/sonataflow-platform-data-index-service --tail=60`);
    const errLines = diLogs.split("\n").filter((l: string) => /ERROR|WARN|Exception|fail|refused|OOM|Liveness|health|503/i.test(l));
    console.log(`[deploy-sonataflow]   data-index error/warn lines (${errLines.length}):\n${errLines.join("\n")}`);
    if (errLines.length === 0) {
      console.log(`[deploy-sonataflow]   data-index last 20 lines:\n${diLogs.split("\n").slice(-20).join("\n")}`);
    }
  } catch (e) { console.log(`[deploy-sonataflow]   data-index logs error: ${e}`); }
  try {
    const diPrevLogs = oc(`logs -n ${namespace} deploy/sonataflow-platform-data-index-service --previous --tail=60`);
    console.log(`[deploy-sonataflow]   data-index PREVIOUS container logs (last 30):\n${diPrevLogs.split("\n").slice(-30).join("\n")}`);
  } catch (e) { console.log(`[deploy-sonataflow]   data-index previous logs: ${e}`); }
  try {
    const diHealth = oc(`exec -n ${namespace} deploy/sonataflow-platform-data-index-service -- curl -s --max-time 5 http://localhost:8080/q/health`);
    console.log(`[deploy-sonataflow]   data-index health: ${diHealth.substring(0, 2000)}`);
  } catch (e) { console.log(`[deploy-sonataflow]   data-index health check error: ${e}`); }
  try {
    const diResources = oc(`get deploy sonataflow-platform-data-index-service -n ${namespace} -o jsonpath='{.spec.template.spec.containers[0].resources}'`);
    console.log(`[deploy-sonataflow]   data-index resources: ${diResources}`);
  } catch (e) { console.log(`[deploy-sonataflow]   data-index resources error: ${e}`); }
  try {
    const diProbes = oc(`get deploy sonataflow-platform-data-index-service -n ${namespace} -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}'`);
    console.log(`[deploy-sonataflow]   data-index liveness probe config: ${diProbes}`);
  } catch (e) { console.log(`[deploy-sonataflow]   data-index probe config error: ${e}`); }
  try {
    const diProps = oc(`get configmap -n ${namespace} -l app=sonataflow-platform -o yaml`);
    const truncated = diProps.substring(0, 5000);
    console.log(`[deploy-sonataflow]   data-index ConfigMaps:\n${truncated}`);
  } catch (e) { console.log(`[deploy-sonataflow]   data-index ConfigMap error: ${e}`); }
  try {
    const diEvents = oc(`get events -n ${namespace} --field-selector reason=Unhealthy --sort-by=.lastTimestamp --no-headers`);
    console.log(`[deploy-sonataflow]   Unhealthy events:\n${diEvents.split("\n").slice(-10).join("\n")}`);
  } catch (e) { console.log(`[deploy-sonataflow]   Unhealthy events error: ${e}`); }
  // #endregion
  // Check PostgreSQL
  try {
    const pgPods = oc(`get pods -n ${namespace} -l app=backstage-psql --no-headers`);
    console.log(`[deploy-sonataflow]   postgresql pods: ${pgPods}`);
  } catch (e) { console.log(`[deploy-sonataflow]   postgresql pods error: ${e}`); }
  // Check if database exists
  try {
    const dbCheck = oc(`exec -n ${namespace} statefulset/backstage-psql -- psql -U postgres -lqt`);
    console.log(`[deploy-sonataflow]   databases:\n${dbCheck}`);
  } catch (e) { console.log(`[deploy-sonataflow]   database list error: ${e}`); }
  // Check SonataFlowPlatform CR status
  try {
    const sfp = oc(`get sonataflowplatform -n ${namespace} -o json`);
    const parsed = JSON.parse(sfp);
    const items = parsed.items || [parsed];
    for (const item of items) {
      const name = item.metadata?.name || "unknown";
      console.log(`[deploy-sonataflow]   SonataFlowPlatform '${name}' status: ${JSON.stringify(item.status?.conditions || [])}`);
      console.log(`[deploy-sonataflow]   SonataFlowPlatform '${name}' cluster: ${JSON.stringify(item.status?.cluster || {})}`);
    }
  } catch (e) { console.log(`[deploy-sonataflow]   SonataFlowPlatform status error: ${e}`); }
  // Dump recent namespace events for troubleshooting
  try {
    const events = oc(`get events -n ${namespace} --sort-by=.lastTimestamp --no-headers`);
    const recentEvents = events.split("\n").slice(-30).join("\n");
    console.log(`[deploy-sonataflow]   Last 30 namespace events:\n${recentEvents}`);
  } catch (e) { console.log(`[deploy-sonataflow]   events error: ${e}`); }
  // Check network policies that might block connectivity
  try {
    const netpol = oc(`get networkpolicy -n ${namespace} --no-headers`);
    console.log(`[deploy-sonataflow]   Network policies:\n${netpol}`);
  } catch (e) { console.log(`[deploy-sonataflow]   NetworkPolicy list error: ${e}`); }
  // Check Routes/Ingress
  try {
    const routes = oc(`get routes -n ${namespace} --no-headers`);
    console.log(`[deploy-sonataflow]   Routes:\n${routes}`);
  } catch (e) { console.log(`[deploy-sonataflow]   Routes error: ${e}`); }
  const totalDuration = ((Date.now() - deployStart) / 1000).toFixed(1);
  console.log(`[deploy-sonataflow] Deployment + diagnostics complete (total: ${totalDuration}s)`);
  // #endregion
}

/**
 * Patch a SonataFlow CR's persistence to point at the PostgreSQL instance
 * deployed by install-orchestrator.sh.  Uses `oc patch --type merge` so the
 * entire persistence block is replaced atomically.
 *
 * This mirrors the CI approach in
 * rhdh/.ci/pipelines/lib/orchestrator.sh (_orchestrator::patch_workflow_postgres).
 */
function patchWorkflowPostgres(namespace: string, workflow: string): string {
  const patch = JSON.stringify({
    spec: {
      persistence: {
        postgresql: {
          secretRef: {
            name: "backstage-psql-secret",
            userKey: "POSTGRES_USER",
            passwordKey: "POSTGRES_PASSWORD",
          },
          serviceRef: {
            name: "backstage-psql",
            namespace,
            databaseName: "backstage_plugin_orchestrator",
          },
        },
      },
    },
  });
  return oc(`-n ${namespace} patch sonataflow ${workflow} --type merge -p '${patch}'`);
}

/** Wait until at least two SonataFlow CRs exist in the namespace. */
async function waitForCRs(namespace: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  console.log(`[deploy-sonataflow] Waiting for ${WORKFLOWS.length} SonataFlow CRs in ${namespace} (60s deadline)...`);
  while (Date.now() < deadline) {
    attempt++;
    try {
      const out = oc(`get sonataflow -n ${namespace} --no-headers`);
      const found = out.split("\n").filter(Boolean).length;
      if (found >= WORKFLOWS.length) {
        console.log(`[deploy-sonataflow] Found ${found} SonataFlow CRs after ${attempt} attempts:\n${out}`);
        return;
      }
      console.log(`[deploy-sonataflow] waitForCRs attempt ${attempt}: found ${found}/${WORKFLOWS.length} CRs`);
    } catch (e) {
      console.log(`[deploy-sonataflow] waitForCRs attempt ${attempt}: CRD/resources not available yet (${e})`);
    }
    await sleep(5_000);
  }
  console.warn(`[deploy-sonataflow] TIMEOUT: Only found fewer than ${WORKFLOWS.length} SonataFlow CRs after ${attempt} attempts`);
  try {
    const allResources = oc(`get all -n ${namespace} --no-headers`);
    console.log(`[deploy-sonataflow] All resources in ${namespace} at timeout:\n${allResources}`);
  } catch (e) { console.log(`[deploy-sonataflow] resource list error at timeout: ${e}`); }
  try {
    const events = oc(`get events -n ${namespace} --sort-by=.lastTimestamp --no-headers`);
    const recentEvents = events.split("\n").slice(-20).join("\n");
    console.log(`[deploy-sonataflow] Recent events at CR timeout:\n${recentEvents}`);
  } catch (e) { console.log(`[deploy-sonataflow] events error: ${e}`); }
}

/**
 * Wait for the SonataFlow operator to reconcile after a CR patch by checking
 * whether the corresponding deployment's Progressing condition is True.
 */
async function waitForReconciliation(
  namespace: string,
  workflow: string,
  timeoutSecs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSecs * 1_000;
  let attempt = 0;
  console.log(`[deploy-sonataflow] Waiting for ${workflow} reconciliation (${timeoutSecs}s deadline)...`);
  while (Date.now() < deadline) {
    attempt++;
    try {
      const status = oc(
        `get deployment ${workflow} -n ${namespace} -o jsonpath='{.status.conditions[?(@.type=="Progressing")].status}'`,
      );
      const cleaned = status.replace(/'/g, "");
      if (cleaned === "True") {
        console.log(`[deploy-sonataflow] ${workflow} reconciliation detected (Progressing=True) after ${attempt} attempts`);
        return;
      }
      if (attempt % 5 === 0) {
        console.log(`[deploy-sonataflow] ${workflow} reconciliation attempt ${attempt}: Progressing=${cleaned}`);
        try {
          const allConditions = oc(`get deployment ${workflow} -n ${namespace} -o jsonpath='{.status.conditions}'`);
          console.log(`[deploy-sonataflow] ${workflow} deployment conditions: ${allConditions}`);
        } catch { /* ignore */ }
      }
    } catch (e) {
      if (attempt % 5 === 0) {
        console.log(`[deploy-sonataflow] ${workflow} reconciliation attempt ${attempt}: deployment not found yet (${e})`);
      }
    }
    await sleep(2_000);
  }
  console.warn(
    `[deploy-sonataflow] TIMEOUT waiting for reconciliation of ${workflow} after ${timeoutSecs}s (${attempt} attempts)`,
  );
  try {
    const sfStatus = oc(`get sonataflow ${workflow} -n ${namespace} -o json`);
    console.log(`[deploy-sonataflow] ${workflow} SonataFlow CR at timeout:\n${sfStatus}`);
  } catch (e) { console.log(`[deploy-sonataflow] ${workflow} CR dump error: ${e}`); }
  try {
    const events = oc(`get events -n ${namespace} --field-selector involvedObject.name=${workflow} --sort-by=.lastTimestamp --no-headers`);
    console.log(`[deploy-sonataflow] ${workflow} events at timeout:\n${events}`);
  } catch (e) { console.log(`[deploy-sonataflow] ${workflow} events error: ${e}`); }
}

/** Run an oc command and return captured stdout (bypasses zx inherited stdio). */
function oc(args: string): string {
  return execSync(`oc ${args}`, { encoding: "utf-8" }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
