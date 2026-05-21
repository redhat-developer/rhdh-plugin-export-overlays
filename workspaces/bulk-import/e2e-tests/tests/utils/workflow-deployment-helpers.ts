import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installOrchestrator } from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";

const UTILS_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_MANIFESTS_DIR = join(UTILS_DIR, "../scripts/yaml");

/** Bulk-import orchestrator e2e workflow (see app-config orchestratorWorkflow). */
export const BULK_IMPORT_ORCHESTRATOR_WORKFLOW = "universal-pr";

const BULK_IMPORT_WORKFLOW_REPO =
  process.env.BULK_IMPORT_WORKFLOWS_REPO ??
  "https://github.com/AndrienkoAleksandr/serverless-workflows.git";
const BULK_IMPORT_WORKFLOW_REPO_REF =
  process.env.BULK_IMPORT_WORKFLOWS_REF ?? "bulk-import-workflow-sample";
const BULK_IMPORT_MANIFESTS_REL = "workflows/bulk-import-git-repos/manifests";

const DATA_INDEX_DEPLOY = "sonataflow-platform-data-index-service";

/** Default SonataFlow operator Postgres secret; e2e uses `backstage-psql-secret` instead. */
const UPSTREAM_WORKFLOW_PG_SECRET = "sonataflow-psql-postgresql";
const E2E_WORKFLOW_PG_SECRET = "backstage-psql-secret";

const POSTGRES_ALIGN_TIMEOUT_MS = 120_000;

/**
 * Installs the SonataFlow platform (via e2e-test-utils) and deploys the
 * `universal-pr` workflow required for bulk-import orchestrator mode.
 */
export async function deployBulkImportOrchestratorWorkflow(
  namespace: string,
): Promise<void> {
  await installOrchestrator(namespace);

  const oslFullVersion = detectOperatorVersion(
    "operators.coreos.com/logic-operator.openshift-operators",
    "operators.coreos.com/logic-operator-rhel8.openshift-operators",
  );
  const oslMajorMinor = oslFullVersion.replace(/^(\d+\.\d+).*/, "$1") || "";
  const osFullVersion = detectOperatorVersion(
    "operators.coreos.com/serverless-operator.openshift-operators",
  );
  const osMajorMinor = osFullVersion.replace(/^(\d+\.\d+).*/, "$1") || "";

  if (oslMajorMinor && osMajorMinor && oslMajorMinor !== osMajorMinor) {
    console.warn(
      `[bulk-import-orchestrator] WARNING: OS (${osMajorMinor}) and OSL (${oslMajorMinor}) differ — possible Knative API issues`,
    );
  }

  hardenSonataFlowPlatform(namespace);
  await waitForDataIndexHealthy(namespace, 120_000).catch(() => {
    console.warn(
      "[bulk-import-orchestrator] data-index not healthy before workflow apply; retrying after deploy",
    );
  });

  await applyUniversalPrManifests(namespace);

  await waitForSonataflowCr(namespace, BULK_IMPORT_ORCHESTRATOR_WORKFLOW, 120_000);

  patchWorkflowPostgres(namespace, BULK_IMPORT_ORCHESTRATOR_WORKFLOW);
  await waitForWorkflowPostgresDeploymentAligned(
    namespace,
    BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    POSTGRES_ALIGN_TIMEOUT_MS,
  );

  await restartWorkflowDeployment(namespace, BULK_IMPORT_ORCHESTRATOR_WORKFLOW);

  await waitForDataIndexHealthy(namespace, 180_000);
  await waitForWorkflowInDataIndex(namespace, BULK_IMPORT_ORCHESTRATOR_WORKFLOW, 180_000);

}

async function applyUniversalPrManifests(namespace: string): Promise<void> {
  if (localManifestsAvailable()) {
    await $`oc apply -n ${namespace} -f ${LOCAL_MANIFESTS_DIR}`;
    return;
  }

  const workflowDir = `/tmp/serverless-workflows-bulk-import-${process.pid}`;
  try {
    await $`git clone --single-branch --branch ${BULK_IMPORT_WORKFLOW_REPO_REF} ${BULK_IMPORT_WORKFLOW_REPO} ${workflowDir}`;
    const manifestsPath = join(workflowDir, BULK_IMPORT_MANIFESTS_REL);
    await $`oc apply -n ${namespace} -f ${manifestsPath}`;
  } finally {
    await $`rm -rf ${workflowDir}`.catch(() => {});
  }
}

function localManifestsAvailable(): boolean {
  if (!existsSync(LOCAL_MANIFESTS_DIR)) {
    return false;
  }
  return readdirSync(LOCAL_MANIFESTS_DIR).some((name) =>
    /\.ya?ml$/i.test(name),
  );
}

function patchWorkflowPostgres(namespace: string, workflow: string): string {
  const patch = JSON.stringify({
    spec: {
      persistence: {
        postgresql: {
          secretRef: {
            name: E2E_WORKFLOW_PG_SECRET,
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
  return runOc([
    "-n",
    namespace,
    "patch",
    "sonataflow",
    workflow,
    "--type",
    "merge",
    "-p",
    patch,
  ]);
}

function parseOcJson<T = unknown>(
  args: string[],
  timeoutMs: number,
): T | undefined {
  try {
    return JSON.parse(runOc(args, timeoutMs)) as T;
  } catch {
    return undefined;
  }
}

function sonataFlowUsesE2ePostgresSecret(cr: Record<string, unknown>): boolean {
  const spec = cr.spec as Record<string, unknown> | undefined;
  const persistence = spec?.persistence as Record<string, unknown> | undefined;
  const pg = persistence?.postgresql as Record<string, unknown> | undefined;
  const secretRef = pg?.secretRef as Record<string, unknown> | undefined;
  return secretRef?.name === E2E_WORKFLOW_PG_SECRET;
}

function deploymentPodTemplateReferencesUpstreamPgSecret(
  deployment: Record<string, unknown>,
): boolean {
  const spec = deployment.spec as Record<string, unknown> | undefined;
  const template = spec?.template as Record<string, unknown> | undefined;
  if (!template) return false;
  return JSON.stringify(template).includes(UPSTREAM_WORKFLOW_PG_SECRET);
}

async function waitForWorkflowPostgresDeploymentAligned(
  namespace: string,
  workflow: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const cr = parseOcJson<Record<string, unknown>>(
      ["get", "sonataflow", workflow, "-n", namespace, "-o", "json"],
      15_000,
    );
    const deployment = parseOcJson<Record<string, unknown>>(
      ["get", "deployment", workflow, "-n", namespace, "-o", "json"],
      15_000,
    );
    const crOk = cr && sonataFlowUsesE2ePostgresSecret(cr);
    const depOk =
      deployment &&
      !deploymentPodTemplateReferencesUpstreamPgSecret(deployment);
    if (crOk && depOk) {
      return;
    }
    patchWorkflowPostgres(namespace, workflow);
    await sleep(2_000);
  }
  throw new Error(
    `[bulk-import-orchestrator] Workflow "${workflow}" Postgres not aligned on ${E2E_WORKFLOW_PG_SECRET} within ${timeoutMs}ms (attempts=${attempt})`,
  );
}

async function waitForSonataflowCr(
  namespace: string,
  workflow: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      runOc(["get", "sonataflow", workflow, "-n", namespace], 15_000);
      return;
    } catch {
      await sleep(5_000);
    }
  }
  throw new Error(
    `[bulk-import-orchestrator] Timed out waiting for SonataFlow CR '${workflow}' in ${namespace}`,
  );
}

async function restartWorkflowDeployment(
  namespace: string,
  workflow: string,
): Promise<void> {
  if (!deploymentExists(namespace, workflow)) {
    await waitForPodMatchingWorkflow(namespace, workflow, 600_000);
    return;
  }
  runOc(
    ["rollout", "restart", `deployment/${workflow}`, "-n", namespace],
    60_000,
  );
  await sleep(2_000);
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
  const graphqlQuery = JSON.stringify({ query: "{ ProcessDefinitions { id } }" });
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
    safeOc(
      ["get", "sonataflow", "-n", namespace, "-o", "wide"],
      60_000,
    ),
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

function detectOperatorVersion(...labels: string[]): string {
  for (const label of labels) {
    try {
      const version = runOc([
        "get",
        "csv",
        "-n",
        "openshift-operators",
        "-o",
        "jsonpath={.items[0].spec.version}",
        "-l",
        label,
      ]);
      if (version) return version;
    } catch {
      /* try next */
    }
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
