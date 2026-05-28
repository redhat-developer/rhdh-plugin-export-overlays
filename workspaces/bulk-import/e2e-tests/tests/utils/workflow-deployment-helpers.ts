import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { installOrchestrator } from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";

const WORKFLOW_REPO =
  "https://github.com/rhdhorchestrator/serverless-workflows.git";
const BULK_IMPORT_MANIFESTS_PATH =
  "workflows/bulk-import-git-repos/manifests";
/** Merged in serverless-workflows #785 — RHDH persistence, org Quay image, no GHTOKEN secret. */
const WORKFLOW_REPO_REF =
  process.env.SERVERLESS_WORKFLOWS_REF ||
  "8126876dc118aa1ada813ef42d5e65dc11925a0a";

/** Bulk-import orchestrator e2e workflow (see app-config orchestratorWorkflow). */
export const BULK_IMPORT_ORCHESTRATOR_WORKFLOW = "universal-pr";

const DATA_INDEX_DEPLOY = "sonataflow-platform-data-index-service";
const WORKFLOW_ROLLOUT_TIMEOUT_MS = 600_000;

/**
 * Installs the SonataFlow platform (via e2e-test-utils) and deploys the
 * `universal-pr` workflow from rhdhorchestrator/serverless-workflows at
 * `SERVERLESS_WORKFLOWS_REF` (default: merge commit for #785).
 */
export async function deployBulkImportOrchestratorWorkflow(
  namespace: string,
): Promise<void> {
  await installOrchestrator(namespace);
  hardenSonataFlowPlatform(namespace);

  await applyUpstreamUniversalPrManifests(namespace);

  await waitForWorkflowDeploymentRollout(
    namespace,
    BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    WORKFLOW_ROLLOUT_TIMEOUT_MS,
  );

  await waitForDataIndexHealthy(namespace, 180_000);
  await waitForWorkflowInDataIndex(
    namespace,
    BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    180_000,
  );
}

async function applyUpstreamUniversalPrManifests(
  namespace: string,
): Promise<void> {
  const localManifestsDir = process.env.BULK_IMPORT_WORKFLOWS_MANIFESTS_DIR?.trim();
  if (localManifestsDir) {
    console.warn(
      `[bulk-import-orchestrator] Applying manifests from BULK_IMPORT_WORKFLOWS_MANIFESTS_DIR=${localManifestsDir}`,
    );
    await $`oc apply -n ${namespace} -f ${localManifestsDir}`;
    return;
  }

  const workflowDir = `/tmp/serverless-workflows-bulk-import-${process.pid}`;
  const manifestsDir = join(workflowDir, BULK_IMPORT_MANIFESTS_PATH);
  console.warn(
    `[bulk-import-orchestrator] Applying universal-pr manifests from ${WORKFLOW_REPO}@${WORKFLOW_REPO_REF}`,
  );
  try {
    await $`git clone --depth=1 ${WORKFLOW_REPO} ${workflowDir}`;
    await $`git -C ${workflowDir} fetch --depth=1 origin ${WORKFLOW_REPO_REF}`;
    await $`git -C ${workflowDir} checkout --detach ${WORKFLOW_REPO_REF}`;
    await $`oc apply -n ${namespace} -f ${manifestsDir}`;
  } finally {
    await $`rm -rf ${workflowDir}`.catch(() => {});
  }
}

async function waitForWorkflowDeploymentRollout(
  namespace: string,
  workflow: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (deploymentExists(namespace, workflow)) {
      runOc(
        [
          "rollout",
          "status",
          `deployment/${workflow}`,
          "-n",
          namespace,
          "--timeout=600s",
        ],
        610_000,
      );
      return;
    }
    try {
      await waitForPodMatchingWorkflow(namespace, workflow, 30_000);
      return;
    } catch {
      await sleep(5_000);
    }
  }
  throw new Error(
    `[bulk-import-orchestrator] Timed out waiting for workflow deployment '${workflow}' in ${namespace}`,
  );
}

function deploymentExists(namespace: string, workflow: string): boolean {
  try {
    runOc(["get", "deployment", workflow, "-n", namespace], 15_000);
    return true;
  } catch {
    return false;
  }
}

async function waitForPodMatchingWorkflow(
  namespace: string,
  namePattern: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pods = runOc(
        ["get", "pods", "-n", namespace, "--no-headers"],
        30_000,
      );
      const line = pods
        .split("\n")
        .find((row) => row.includes(namePattern) && row.includes("Running"));
      if (line) {
        return;
      }
    } catch {
      /* retry */
    }
    await sleep(10_000);
  }
  throw new Error(
    `[bulk-import-orchestrator] Timed out waiting for Running pod matching '${namePattern}'`,
  );
}

async function waitForDataIndexHealthy(
  namespace: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDataIndexHealthy(namespace)) {
      return;
    }
    await sleep(5_000);
  }
  throw new Error(
    `[bulk-import-orchestrator] Data-index not healthy within ${timeoutMs}ms`,
  );
}

function isDataIndexHealthy(namespace: string): boolean {
  try {
    const health = runOc(
      [
        "exec",
        "-n",
        namespace,
        `deploy/${DATA_INDEX_DEPLOY}`,
        "--",
        "curl",
        "-sf",
        "--max-time",
        "5",
        "http://localhost:8080/q/health/ready",
      ],
      15_000,
    );
    const parsed = JSON.parse(health) as { status?: string };
    return parsed.status === "UP";
  } catch {
    return false;
  }
}

async function waitForWorkflowInDataIndex(
  namespace: string,
  workflow: string,
  timeoutMs: number,
): Promise<void> {
  const graphqlQuery = JSON.stringify({
    query: "{ ProcessDefinitions { id } }",
  });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = runOc(
        [
          "exec",
          "-n",
          namespace,
          `deploy/${DATA_INDEX_DEPLOY}`,
          "--",
          "curl",
          "-sf",
          "--max-time",
          "10",
          "-X",
          "POST",
          "-H",
          "Content-Type: application/json",
          "-d",
          graphqlQuery,
          "http://localhost:8080/graphql",
        ],
        20_000,
      );
      if (
        response.includes(`"${workflow}"`) ||
        response.includes(`"id":"${workflow}"`)
      ) {
        return;
      }
    } catch {
      /* retry */
    }
    await sleep(5_000);
  }

  console.warn(
    `[bulk-import-orchestrator] '${workflow}' not listed in data-index GraphQL within ${timeoutMs}ms (deployment may still work)`,
  );
}

function hardenSonataFlowPlatform(namespace: string): void {
  try {
    runOc(
      ["get", "sonataflowplatform", "sonataflow-platform", "-n", namespace],
      15_000,
    );
  } catch {
    return;
  }

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
              livenessProbe: {
                failureThreshold: 200,
                httpGet: {
                  path: "/q/health/live",
                  port: 8080,
                  scheme: "HTTP",
                },
                periodSeconds: 10,
                timeoutSeconds: 10,
              },
              readinessProbe: {
                failureThreshold: 200,
                httpGet: {
                  path: "/q/health/ready",
                  port: 8080,
                  scheme: "HTTP",
                },
                periodSeconds: 10,
                timeoutSeconds: 10,
              },
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

  try {
    runOc([
      "-n",
      namespace,
      "patch",
      "sonataflowplatform",
      "sonataflow-platform",
      "--type",
      "merge",
      "-p",
      sfpPatch,
    ]);
    runOc(
      [
        "rollout",
        "status",
        `deployment/${DATA_INDEX_DEPLOY}`,
        "-n",
        namespace,
        "--timeout=300s",
      ],
      310_000,
    );
    runOc(
      [
        "rollout",
        "status",
        "deployment/sonataflow-platform-jobs-service",
        "-n",
        namespace,
        "--timeout=300s",
      ],
      310_000,
    );
  } catch {
    console.warn(
      "[bulk-import-orchestrator] SonataFlowPlatform hardening failed (continuing)",
    );
  }
}

export function runOc(args: string[], timeoutMs = 30_000): string {
  return execFileSync("oc", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function formatOcFailure(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.trim();
    return m.includes("\n") ? (m.split("\n")[0] ?? m) : m;
  }
  return String(err);
}

/**
 * Best-effort snapshot when RHDH or workflow deploy fails.
 */
export function logOrchestratorDeployFailureDiagnostics(
  namespace: string,
): void {
  const banner = (title: string) => {
    console.error(
      `\n===== [bulk-import-orchestrator deploy failure] ${title} =====\n`,
    );
  };

  const safeOc = (args: string[], timeoutMs = 120_000): string | undefined => {
    try {
      return runOc(args, timeoutMs);
    } catch (err) {
      console.error(
        `[bulk-import-orchestrator] oc ${args.join(" ")} failed: ${formatOcFailure(err)}`,
      );
      return undefined;
    }
  };

  const dumpOc = (out: string | undefined, emptyHint: string) => {
    if (out === undefined) return;
    if (out.trim().length > 0) {
      console.error(out);
    } else {
      console.error(emptyHint);
    }
  };

  banner(`namespace=${namespace}`);

  dumpOc(
    safeOc(["get", "pods", "-n", namespace, "-o", "wide"], 60_000),
    "(get pods — empty stdout)",
  );

  dumpOc(
    safeOc(["get", "sonataflow", "-n", namespace, "-o", "wide"], 60_000),
    "(get sonataflow — empty)",
  );

  const hubPod = safeOc([
    "get",
    "pods",
    "-n",
    namespace,
    "-l",
    "app.kubernetes.io/instance=redhat-developer-hub",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  ])?.trim();

  if (hubPod) {
    banner(`redhat-developer-hub pod describe (${hubPod})`);
    dumpOc(
      safeOc(["describe", "pod", "-n", namespace, hubPod], 120_000),
      "(describe produced no stdout)",
    );
    banner(`redhat-developer-hub pod logs (${hubPod}) --all-containers`);
    dumpOc(
      safeOc(
        ["logs", "-n", namespace, hubPod, "--all-containers", "--tail=300"],
        120_000,
      ),
      "(no container logs on stdout)",
    );
  }

  banner("recent namespace events (last 40 lines)");
  const events = safeOc(
    ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp"],
    60_000,
  );
  if (events?.trim()) {
    const lines = events.trim().split("\n");
    console.error(lines.slice(-40).join("\n"));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
