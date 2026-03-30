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
  await installOrchestrator(namespace);

  const workflowDir = `/tmp/serverless-workflows-${process.pid}`;
  try {
    await $`git clone --depth=1 ${WORKFLOW_REPO} ${workflowDir}`;
    for (const rel of MANIFEST_DIRS) {
      await $`oc apply -n ${namespace} -f ${join(workflowDir, rel)}`;
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
  // Check data-index connectivity
  try {
    const diPods = oc(`get pods -n ${namespace} -l app=sonataflow-platform -l sonataflow.org/service-type=data-index --no-headers`);
    console.log(`[deploy-sonataflow]   data-index pods: ${diPods}`);
  } catch {
    try {
      const diPods = oc(`get pods -n ${namespace} | grep data-index`);
      console.log(`[deploy-sonataflow]   data-index pods (grep): ${diPods}`);
    } catch (e2) { console.log(`[deploy-sonataflow]   data-index pods error: ${e2}`); }
  }
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
  console.log("[deploy-sonataflow] Diagnostics complete.");
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
  while (Date.now() < deadline) {
    try {
      const out = oc(`get sonataflow -n ${namespace} --no-headers`);
      if (out.split("\n").filter(Boolean).length >= WORKFLOWS.length) return;
    } catch {
      /* CRD / resources not available yet */
    }
    await sleep(5_000);
  }
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
  while (Date.now() < deadline) {
    try {
      const status = oc(
        `get deployment ${workflow} -n ${namespace} -o jsonpath='{.status.conditions[?(@.type=="Progressing")].status}'`,
      );
      if (status.replace(/'/g, "") === "True") return;
    } catch {
      /* deployment may not exist yet */
    }
    await sleep(2_000);
  }
  console.warn(
    `[deploy-sonataflow] Timeout waiting for reconciliation of ${workflow} after ${timeoutSecs}s`,
  );
}

/** Run an oc command and return captured stdout (bypasses zx inherited stdio). */
function oc(args: string): string {
  return execSync(`oc ${args}`, { encoding: "utf-8" }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
