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
const PSQL_SVC_NAME = "backstage-psql";
const PSQL_USER_KEY = "POSTGRES_USER";
const PSQL_PASSWORD_KEY = "POSTGRES_PASSWORD";
const SONATAFLOW_DB = "backstage_plugin_orchestrator";
/** Required by universal-pr SonataFlow CR (see upstream 05-sonataflow_universal-pr.yaml). */
const SONATAFLOW_DB_SCHEMA = "bulk-import-git-repos";
const PSQL_PORT = 5432;

const WORKFLOW_WORKLOAD_TIMEOUT_MS = Number(
  process.env.BULK_IMPORT_WORKFLOW_WORKLOAD_TIMEOUT_MS ??
    (process.env.CI === "true" ? 600_000 : 300_000),
);

const POSTGRES_ALIGN_TIMEOUT_MS = Number(
  process.env.BULK_IMPORT_WORKFLOW_PG_ALIGN_TIMEOUT_MS ??
    (process.env.CI === "true" ? 300_000 : 120_000),
);

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

  const workflowPgSecret = resolveWorkflowPostgresSecretName(namespace);

  await applyUniversalPrManifests(namespace, workflowPgSecret);

  await waitForSonataflowCr(namespace, BULK_IMPORT_ORCHESTRATOR_WORKFLOW, 120_000);

  // Single patch with full serviceRef (port + databaseSchema). Repeated merge-patches that
  // omit those fields prevent the operator from creating deployment/universal-pr.
  patchWorkflowPostgres(
    namespace,
    BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    workflowPgSecret,
  );

  await waitForWorkflowWorkloadFromOperator(
    namespace,
    BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    WORKFLOW_WORKLOAD_TIMEOUT_MS,
  );

  await ensureWorkflowDeploymentPostgresAligned(
    namespace,
    BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    workflowPgSecret,
    POSTGRES_ALIGN_TIMEOUT_MS,
  );

  await restartWorkflowDeployment(namespace, BULK_IMPORT_ORCHESTRATOR_WORKFLOW);

  await waitForDataIndexHealthy(namespace, 180_000);
  await waitForWorkflowInDataIndex(namespace, BULK_IMPORT_ORCHESTRATOR_WORKFLOW, 180_000);

}

function resolveWorkflowPostgresSecretName(namespace: string): string {
  try {
    runOc(["get", "secret", E2E_WORKFLOW_PG_SECRET, "-n", namespace], 10_000);
    return E2E_WORKFLOW_PG_SECRET;
  } catch {
    /* discover from installOrchestrator naming */
  }
  const secrets = runOc(["get", "secrets", "-n", namespace, "-o", "name"], 15_000);
  const discovered = secrets
    .split("\n")
    .map((line) => line.replace(/^secret\//, "").trim())
    .find((name) => name.includes("backstage-psql"));
  if (discovered) {
    console.log(
      `[bulk-import-orchestrator] Using discovered Postgres secret: ${discovered}`,
    );
    return discovered;
  }
  throw new Error(
    `[bulk-import-orchestrator] No Postgres secret in namespace '${namespace}' (expected ${E2E_WORKFLOW_PG_SECRET})`,
  );
}

async function patchSonataflowManifestPostgres(
  manifestFile: string,
  namespace: string,
  secretName: string,
): Promise<void> {
  const yqExprs = [
    `.spec.persistence.postgresql.secretRef.name = "${secretName}"`,
    `.spec.persistence.postgresql.secretRef.userKey = "${PSQL_USER_KEY}"`,
    `.spec.persistence.postgresql.secretRef.passwordKey = "${PSQL_PASSWORD_KEY}"`,
    `.spec.persistence.postgresql.serviceRef.name = "${PSQL_SVC_NAME}"`,
    `.spec.persistence.postgresql.serviceRef.namespace = "${namespace}"`,
    `.spec.persistence.postgresql.serviceRef.port = ${PSQL_PORT}`,
    `.spec.persistence.postgresql.serviceRef.databaseName = "${SONATAFLOW_DB}"`,
    `.spec.persistence.postgresql.serviceRef.databaseSchema = "${SONATAFLOW_DB_SCHEMA}"`,
  ];
  for (const expr of yqExprs) {
    await $`yq eval -i ${expr} ${manifestFile}`;
  }
}

function findSonataflowManifest(manifestsDir: string, workflow: string): string {
  const expected = join(
    manifestsDir,
    `05-sonataflow_${workflow}.yaml`,
  );
  if (existsSync(expected)) {
    return expected;
  }
  const match = readdirSync(manifestsDir).find(
    (name) =>
      /sonataflow/i.test(name) &&
      name.includes(workflow) &&
      /\.ya?ml$/i.test(name),
  );
  if (match) {
    return join(manifestsDir, match);
  }
  throw new Error(
    `[bulk-import-orchestrator] SonataFlow manifest not found under ${manifestsDir}`,
  );
}

async function applyUniversalPrManifests(
  namespace: string,
  workflowPgSecret: string,
): Promise<void> {
  if (localManifestsAvailable()) {
    const sonataflowManifest = findSonataflowManifest(
      LOCAL_MANIFESTS_DIR,
      BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    );
    await patchSonataflowManifestPostgres(
      sonataflowManifest,
      namespace,
      workflowPgSecret,
    );
    await $`oc apply -n ${namespace} -f ${LOCAL_MANIFESTS_DIR}`;
    return;
  }

  const workflowDir = `/tmp/serverless-workflows-bulk-import-${process.pid}`;
  try {
    await $`git clone --single-branch --branch ${BULK_IMPORT_WORKFLOW_REPO_REF} ${BULK_IMPORT_WORKFLOW_REPO} ${workflowDir}`;
    const manifestsPath = join(workflowDir, BULK_IMPORT_MANIFESTS_REL);
    const sonataflowManifest = findSonataflowManifest(
      manifestsPath,
      BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    );
    await patchSonataflowManifestPostgres(
      sonataflowManifest,
      namespace,
      workflowPgSecret,
    );
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

function buildWorkflowPostgresqlPersistence(
  namespace: string,
  workflowPgSecret: string,
): Record<string, unknown> {
  return {
    secretRef: {
      name: workflowPgSecret,
      userKey: PSQL_USER_KEY,
      passwordKey: PSQL_PASSWORD_KEY,
    },
    serviceRef: {
      name: PSQL_SVC_NAME,
      namespace,
      port: PSQL_PORT,
      databaseName: SONATAFLOW_DB,
      databaseSchema: SONATAFLOW_DB_SCHEMA,
    },
  };
}

function patchWorkflowPostgres(
  namespace: string,
  workflow: string,
  workflowPgSecret: string,
): string {
  const patch = JSON.stringify({
    spec: {
      persistence: {
        postgresql: buildWorkflowPostgresqlPersistence(namespace, workflowPgSecret),
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

function sonataFlowUsesE2ePostgresSecret(
  cr: Record<string, unknown>,
  workflowPgSecret: string,
): boolean {
  const spec = cr.spec as Record<string, unknown> | undefined;
  const persistence = spec?.persistence as Record<string, unknown> | undefined;
  const pg = persistence?.postgresql as Record<string, unknown> | undefined;
  const secretRef = pg?.secretRef as Record<string, unknown> | undefined;
  return secretRef?.name === workflowPgSecret;
}

function deploymentPodTemplateReferencesUpstreamPgSecret(
  deployment: Record<string, unknown>,
): boolean {
  const spec = deployment.spec as Record<string, unknown> | undefined;
  const template = spec?.template as Record<string, unknown> | undefined;
  if (!template) return false;
  return JSON.stringify(template).includes(UPSTREAM_WORKFLOW_PG_SECRET);
}

type WorkflowPostgresAlignState = {
  crOk: boolean;
  deploymentExists: boolean;
  deploymentReferencesUpstream: boolean;
  depOk: boolean;
  blocker: string;
};

function evaluateWorkflowPostgresAlign(
  cr: Record<string, unknown> | undefined,
  deployment: Record<string, unknown> | undefined,
  workflowPgSecret: string,
  workflow: string,
): WorkflowPostgresAlignState {
  const crOk = Boolean(cr && sonataFlowUsesE2ePostgresSecret(cr, workflowPgSecret));
  const deploymentExists = Boolean(deployment);
  const deploymentReferencesUpstream = deploymentExists
    ? deploymentPodTemplateReferencesUpstreamPgSecret(deployment!)
    : false;

  if (!crOk) {
    return {
      crOk,
      deploymentExists,
      deploymentReferencesUpstream,
      depOk: false,
      blocker: `SonataFlow CR spec.persistence.postgresql.secretRef is not "${workflowPgSecret}"`,
    };
  }
  if (!deploymentExists) {
    return {
      crOk,
      deploymentExists,
      deploymentReferencesUpstream,
      depOk: false,
      blocker: `Deployment "${workflow}" not found — operator has not created workload yet`,
    };
  }
  if (deploymentReferencesUpstream) {
    return {
      crOk,
      deploymentExists,
      deploymentReferencesUpstream,
      depOk: false,
      blocker: `Deployment "${workflow}" pod template still references ${UPSTREAM_WORKFLOW_PG_SECRET}`,
    };
  }
  return {
    crOk,
    deploymentExists,
    deploymentReferencesUpstream,
    depOk: true,
    blocker: "ok",
  };
}

function summarizeSonataflowCrStatus(cr: Record<string, unknown>): string {
  const status = cr.status as Record<string, unknown> | undefined;
  const lines: string[] = [];
  const phase = status?.phase;
  if (phase !== undefined) {
    lines.push(`status.phase=${String(phase)}`);
  }
  const observedGen = status?.observedGeneration;
  if (observedGen !== undefined) {
    lines.push(`status.observedGeneration=${String(observedGen)}`);
  }
  const conditions = status?.conditions as
    | Array<Record<string, unknown>>
    | undefined;
  if (conditions?.length) {
    for (const c of conditions) {
      lines.push(
        `condition ${String(c.type)}=${String(c.status)} reason=${String(c.reason ?? "")} message=${String(c.message ?? "").slice(0, 200)}`,
      );
    }
  } else {
    lines.push("(no status.conditions on SonataFlow CR)");
  }
  const spec = cr.spec as Record<string, unknown> | undefined;
  const pg = spec?.persistence as Record<string, unknown> | undefined;
  const postgresql = pg?.postgresql as Record<string, unknown> | undefined;
  const secretRef = postgresql?.secretRef as Record<string, unknown> | undefined;
  lines.push(
    `spec.persistence.postgresql.secretRef.name=${String(secretRef?.name ?? "<unset>")}`,
  );
  return lines.join("\n");
}

/**
 * Logs SonataFlow CR status, related workloads, and events (e.g. when Deployment is missing).
 */
export function logSonataflowWorkflowDiagnostics(
  namespace: string,
  workflow: string,
  context = "diagnostics",
): void {
  const banner = (title: string) => {
    console.error(
      `\n===== [bulk-import-orchestrator] ${context}: ${title} =====\n`,
    );
  };

  const safeOc = (args: string[], timeoutMs = 60_000): string | undefined => {
    try {
      return runOc(args, timeoutMs);
    } catch (err) {
      console.error(
        `[bulk-import-orchestrator] oc ${args.join(" ")} failed: ${formatOcFailure(err)}`,
      );
      return undefined;
    }
  };

  const dump = (out: string | undefined, emptyHint: string) => {
    if (out === undefined) return;
    console.error(out.trim().length > 0 ? out : emptyHint);
  };

  banner(`sonataflow.sonataflow.org/${workflow} in ${namespace}`);

  const crJson = safeOc(
    ["get", "sonataflow", workflow, "-n", namespace, "-o", "json"],
    30_000,
  );
  if (crJson) {
    try {
      const cr = JSON.parse(crJson) as Record<string, unknown>;
      console.error("[SonataFlow CR status summary]\n", summarizeSonataflowCrStatus(cr));
    } catch {
      console.error("(could not parse SonataFlow CR JSON)");
    }
  }

  dump(
    safeOc(["describe", "sonataflow", workflow, "-n", namespace], 90_000),
    "(describe sonataflow — empty)",
  );

  banner(`workloads matching "${workflow}"`);
  const allWorkloads = safeOc(
    ["get", "deploy,statefulset,pod,job", "-n", namespace, "-o", "wide"],
    60_000,
  );
  if (allWorkloads) {
    const matching = allWorkloads
      .split("\n")
      .filter((line) => line.includes(workflow));
    console.error(
      matching.length > 0
        ? matching.join("\n")
        : `(no deploy/sts/pod/job name contains "${workflow}")\n${allWorkloads}`,
    );
  }

  try {
    runOc(["get", "crd", "services.serving.knative.dev"], 10_000);
    dump(
      safeOc(["get", "ksvc", "-n", namespace, "-o", "wide"], 30_000)
        ?.split("\n")
        .filter((line) => line.includes(workflow))
        .join("\n"),
      "(no Knative Service matching workflow name)",
    );
  } catch {
    console.error("(Knative Service CRD not available — skipping ksvc)");
  }

  dump(
    safeOc(["get", "deployment", workflow, "-n", namespace, "-o", "wide"], 15_000),
    `(deployment/${workflow} — NotFound)`,
  );

  banner(`events involving "${workflow}" (last 30)`);
  const events = safeOc(
    ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp"],
    60_000,
  );
  if (events?.trim()) {
    const filtered = events
      .trim()
      .split("\n")
      .filter((line) => line.toLowerCase().includes(workflow.toLowerCase()));
    const tail = (filtered.length > 0 ? filtered : events.trim().split("\n")).slice(
      -30,
    );
    console.error(tail.join("\n"));
  }
}

function sonataflowCrHasFailedCondition(cr: Record<string, unknown>): string | undefined {
  const status = cr.status as Record<string, unknown> | undefined;
  const conditions = status?.conditions as Array<Record<string, unknown>> | undefined;
  const failed = conditions?.find(
    (c) =>
      String(c.type).toLowerCase() === "failed" &&
      String(c.status).toLowerCase() === "true",
  );
  if (failed) {
    return `${String(failed.reason ?? "Failed")}: ${String(failed.message ?? "")}`;
  }
  return undefined;
}

function workflowPodIsRunning(namespace: string, workflow: string): boolean {
  try {
    const pods = runOc(
      [
        "get",
        "pods",
        "-n",
        namespace,
        "-l",
        `app=${workflow}`,
        "--no-headers",
      ],
      30_000,
    );
    return pods
      .split("\n")
      .some((row) => row.trim().length > 0 && row.includes("Running"));
  } catch {
    return false;
  }
}

/** Waits until the SonataFlow operator creates deployment/universal-pr or a Running workflow pod. */
async function waitForWorkflowWorkloadFromOperator(
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
    const failed = cr ? sonataflowCrHasFailedCondition(cr) : undefined;
    if (failed) {
      logSonataflowWorkflowDiagnostics(namespace, workflow, "SonataFlow CR Failed");
      throw new Error(
        `[bulk-import-orchestrator] SonataFlow ${workflow} reports Failed: ${failed}`,
      );
    }

    if (deploymentExists(namespace, workflow) || workflowPodIsRunning(namespace, workflow)) {
      console.log(
        `[bulk-import-orchestrator] Workflow workload ready (attempt ${attempt})`,
      );
      return;
    }

    if (attempt === 1 || attempt % 6 === 0) {
      console.warn(
        `[bulk-import-orchestrator] Waiting for operator to create deployment/${workflow} or pod (attempt ${attempt})`,
      );
      if (cr) {
        console.warn(summarizeSonataflowCrStatus(cr));
      }
    }

    await sleep(5_000);
  }

  logSonataflowWorkflowDiagnostics(namespace, workflow, "Workload timeout");
  throw new Error(
    `[bulk-import-orchestrator] Operator did not create deployment/${workflow} or Running pod within ${timeoutMs}ms (attempts=${attempt})`,
  );
}

/** After workload exists, ensure Deployment pod template no longer references operator postgres. */
async function ensureWorkflowDeploymentPostgresAligned(
  namespace: string,
  workflow: string,
  workflowPgSecret: string,
  timeoutMs: number,
): Promise<void> {
  if (!deploymentExists(namespace, workflow)) {
    console.warn(
      `[bulk-import-orchestrator] No deployment/${workflow}; skipping deployment postgres template check (pod-only workload)`,
    );
    return;
  }

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastState: WorkflowPostgresAlignState = {
    crOk: false,
    deploymentExists: true,
    deploymentReferencesUpstream: true,
    depOk: false,
    blocker: "initial",
  };

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
    lastState = evaluateWorkflowPostgresAlign(
      cr,
      deployment,
      workflowPgSecret,
      workflow,
    );

    if (lastState.depOk) {
      return;
    }

    if (lastState.deploymentReferencesUpstream) {
      patchWorkflowPostgres(namespace, workflow, workflowPgSecret);
      try {
        runOc(
          ["rollout", "restart", `deployment/${workflow}`, "-n", namespace],
          60_000,
        );
      } catch (err) {
        console.warn(
          `[bulk-import-orchestrator] rollout restart failed: ${formatOcFailure(err)}`,
        );
      }
    }

    await sleep(3_000);
  }

  logSonataflowWorkflowDiagnostics(namespace, workflow, "Deployment postgres align timeout");

  throw new Error(
    `[bulk-import-orchestrator] Deployment/${workflow} still not aligned on ${workflowPgSecret} within ${timeoutMs}ms ` +
      `(attempts=${attempt}, blocker=${lastState.blocker})`,
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
    console.warn(
      `[bulk-import-orchestrator] deployment/${workflow} not found before restart; waiting for Running pod`,
    );
    logSonataflowWorkflowDiagnostics(
      namespace,
      workflow,
      "deployment missing before restart",
    );
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

  logSonataflowWorkflowDiagnostics(
    namespace,
    BULK_IMPORT_ORCHESTRATOR_WORKFLOW,
    "deploy failure snapshot",
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
