import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installOrchestrator } from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";

const WORKFLOW_REPO =
  "https://github.com/rhdhorchestrator/serverless-workflows.git";
const DEMO_WORKFLOW_REPO =
  "https://github.com/rhdhorchestrator/orchestrator-demo.git";
const WORKFLOW_REPO_REF =
  process.env.SERVERLESS_WORKFLOWS_REF ||
  "daeeee8dec16beab6d96a81774ef500081a2c2b0";

const MANIFEST_DIRS = [
  "workflows/greeting/manifests",
  "workflows/fail-switch/src/main/resources/manifests",
];

const WORKFLOWS = ["greeting", "failswitch"];

/** Default SonataFlow operator Postgres secret; e2e uses `backstage-psql-secret` instead. */
const UPSTREAM_WORKFLOW_PG_SECRET = "sonataflow-psql-postgresql";
const E2E_WORKFLOW_PG_SECRET = "backstage-psql-secret";

export async function deploySonataflow(namespace: string): Promise<void> {
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
      `[deploy-sonataflow] WARNING: OS (${osMajorMinor}) and OSL (${oslMajorMinor}) major.minor versions differ — this may cause Knative API incompatibilities`,
    );
  }

  hardenSonataFlowPlatform(namespace);

  const workflowDir = `/tmp/serverless-workflows-${process.pid}`;
  try {
    await $`git clone --depth=1 ${WORKFLOW_REPO} ${workflowDir}`;
    await $`git -C ${workflowDir} fetch --depth=1 origin ${WORKFLOW_REPO_REF}`;
    await $`git -C ${workflowDir} checkout --detach ${WORKFLOW_REPO_REF}`;

    for (const rel of MANIFEST_DIRS) {
      const fullPath = join(workflowDir, rel);
      await $`oc apply -n ${namespace} -f ${fullPath}`;
    }
  } finally {
    await $`rm -rf ${workflowDir}`.catch(() => {});
  }

  await waitForCRs(namespace);

  // Patch persistence before image alignment so the operator never materializes
  // ReplicaSets that still reference upstream `sonataflow-psql-postgresql` (missing).
  for (const workflow of WORKFLOWS) {
    patchWorkflowPostgres(namespace, workflow);
  }

  alignWorkflowImages(namespace, oslMajorMinor);

  // Image patch can trigger another reconcile; re-apply persistence for safety.
  for (const workflow of WORKFLOWS) {
    patchWorkflowPostgres(namespace, workflow);
  }

  const postgresAlignTimeoutMs = 120_000;
  for (const workflow of WORKFLOWS) {
    await waitForWorkflowPostgresDeploymentAligned(
      namespace,
      workflow,
      postgresAlignTimeoutMs,
    );
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

  await deployTokenPropagationWorkflow(namespace, postgresAlignTimeoutMs);
}

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

/** True if the live Deployment pod template still references the operator default secret. */
function deploymentPodTemplateReferencesUpstreamPgSecret(
  deployment: Record<string, unknown>,
): boolean {
  const spec = deployment.spec as Record<string, unknown> | undefined;
  const template = spec?.template as Record<string, unknown> | undefined;
  if (!template) return false;
  return JSON.stringify(template).includes(UPSTREAM_WORKFLOW_PG_SECRET);
}

/**
 * Wait until the SonataFlow CR and workflow Deployment both reflect the e2e Postgres
 * wiring, re-applying the merge patch when the operator lags. Does not restart the rollout.
 */
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
  console.warn(
    `[deploy-sonataflow] TIMEOUT (${timeoutMs}ms): workflow "${workflow}" not aligned on ${E2E_WORKFLOW_PG_SECRET} (SonataFlow CR + Deployment template; attempts=${attempt})`,
  );
}

async function waitForCRs(namespace: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const out = runOc(["get", "sonataflow", "-n", namespace, "--no-headers"]);
      const found = out.split("\n").filter(Boolean).length;
      if (found >= WORKFLOWS.length) {
        return;
      }
    } catch {
      // not available yet
    }
    await sleep(5_000);
  }
  console.warn(
    `[deploy-sonataflow] TIMEOUT: Only found fewer than ${WORKFLOWS.length} SonataFlow CRs after ${attempt} attempts`,
  );
}

function hardenSonataFlowPlatform(namespace: string): void {
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
        "deployment/sonataflow-platform-data-index-service",
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
    /* SFP patch non-fatal */
  }
}

function alignWorkflowImages(namespace: string, oslMajorMinor: string): void {
  if (!oslMajorMinor || oslMajorMinor === "1.37") return;

  const oslTag = `osl_${oslMajorMinor.replace(".", "_")}`;
  const imageMap: Record<string, string> = {
    greeting: `quay.io/orchestrator/serverless-workflow-greeting:${oslTag}`,
    failswitch: `quay.io/orchestrator/fail-switch:${oslTag}`,
  };
  for (const wf of WORKFLOWS) {
    const image = imageMap[wf];
    if (!image) continue;
    try {
      const imgPatch = JSON.stringify({
        spec: { podTemplate: { container: { image } } },
      });
      runOc([
        "-n",
        namespace,
        "patch",
        "sonataflow",
        wf,
        "--type",
        "merge",
        "-p",
        imgPatch,
      ]);
    } catch {
      /* ignore per-workflow patch failure */
    }
  }
}

async function deployTokenPropagationWorkflow(
  namespace: string,
  postgresAlignTimeoutMs: number,
): Promise<void> {
  const kcBaseUrl = process.env.KEYCLOAK_BASE_URL;
  const kcRealm = process.env.KEYCLOAK_REALM;
  const kcClientId = process.env.KEYCLOAK_CLIENT_ID;
  const kcClientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
  if (!kcBaseUrl || !kcRealm || !kcClientId || !kcClientSecret) {
    throw new Error(
      "KEYCLOAK_BASE_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET must be set",
    );
  }

  const authServerUrl = `${kcBaseUrl}/realms/${kcRealm}`;
  const tokenUrl = `${authServerUrl}/protocol/openid-connect/token`;
  const sampleServerUrl = `http://sample-server-service.${namespace}:8080`;
  const demoDir = `/tmp/orchestrator-demo-${process.pid}`;
  const manifestsDir = join(demoDir, "09_token_propagation/manifests");
  const propsCm = join(
    manifestsDir,
    "01-configmap_token-propagation-props.yaml",
  );
  const specsCm = join(
    manifestsDir,
    "03-configmap_02-token-propagation-resources-specs.yaml",
  );

  try {
    await $`git clone --depth=1 ${DEMO_WORKFLOW_REPO} ${demoDir}`;

    const propsData = readFileSync(propsCm, "utf-8")
      .replaceAll(
        "http://example-kc-service.keycloak:8080/realms/quarkus",
        authServerUrl,
      )
      .replaceAll("client-id=quarkus-app", `client-id=${kcClientId}`)
      .replaceAll(
        "client-secret=lVGSvdaoDUem7lqeAnqXn1F92dCPbQea",
        `client-secret=${kcClientSecret}`,
      )
      .replaceAll(
        "http://sample-server-service.rhdh-operator",
        sampleServerUrl,
      );
    writeFileSync(propsCm, propsData, "utf-8");

    const specsData = readFileSync(specsCm, "utf-8").replaceAll(
      "http://example-kc-service.keycloak:8080/realms/quarkus/protocol/openid-connect/token",
      tokenUrl,
    );
    writeFileSync(specsCm, specsData, "utf-8");

    await $`oc apply -n ${namespace} -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sample-server
  labels:
    app: sample-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sample-server
  template:
    metadata:
      labels:
        app: sample-server
    spec:
      containers:
        - name: sample-server
          image: quay.io/orchestrator/sample-server:latest
          ports:
            - containerPort: 8080
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: sample-server-service
  labels:
    app: sample-server
spec:
  selector:
    app: sample-server
  ports:
    - port: 8080
      targetPort: 8080
      protocol: TCP
EOF`;

    runOc(
      [
        "wait",
        "deployment/sample-server",
        "-n",
        namespace,
        "--for=condition=Available",
        "--timeout=120s",
      ],
      130_000,
    );

    await $`oc apply -n ${namespace} -f ${manifestsDir}`;

    patchWorkflowPostgres(namespace, "token-propagation");
    await waitForWorkflowPostgresDeploymentAligned(
      namespace,
      "token-propagation",
      postgresAlignTimeoutMs,
    );
    runOc(
      ["rollout", "restart", "deployment/token-propagation", "-n", namespace],
      60_000,
    );
    await sleep(2_000);
    runOc(
      [
        "rollout",
        "status",
        "deployment/token-propagation",
        "-n",
        namespace,
        "--timeout=600s",
      ],
      610_000,
    );
  } finally {
    await $`rm -rf ${demoDir}`.catch(() => {});
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
 * Best-effort snapshot when `rhdh.deploy()` fails (pods, hub describe/logs, recent events).
 */
export function logOrchestratorDeployFailureDiagnostics(
  namespace: string,
): void {
  const banner = (title: string) => {
    console.error(`\n===== [orchestrator-e2e deploy failure] ${title} =====\n`);
  };

  const safeOc = (args: string[], timeoutMs = 120_000): string | undefined => {
    try {
      return runOc(args, timeoutMs);
    } catch (err) {
      console.error(
        `[orchestrator-e2e deploy failure] oc ${args.join(" ")} failed: ${formatOcFailure(err)}`,
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

    banner(
      `redhat-developer-hub init logs (${hubPod}) container=install-dynamic-plugins --previous`,
    );
    dumpOc(
      safeOc(
        [
          "logs",
          "-n",
          namespace,
          hubPod,
          "-c",
          "install-dynamic-plugins",
          "--previous",
          "--tail=400",
        ],
        120_000,
      ),
      "(no previous init-container logs on stdout)",
    );

    banner(
      `redhat-developer-hub init logs (${hubPod}) container=install-dynamic-plugins`,
    );
    dumpOc(
      safeOc(
        [
          "logs",
          "-n",
          namespace,
          hubPod,
          "-c",
          "install-dynamic-plugins",
          "--tail=400",
        ],
        120_000,
      ),
      "(no current init-container logs on stdout)",
    );
  } else {
    banner("redhat-developer-hub pod not found via label selector");
  }

  banner("dynamic plugin config map");
  dumpOc(
    safeOc(
      [
        "get",
        "configmap",
        "redhat-developer-hub-dynamic-plugins",
        "-n",
        namespace,
        "-o",
        "yaml",
      ],
      60_000,
    ),
    "(dynamic plugin config map not available)",
  );

  banner("dynamic plugin registry auth secret");
  dumpOc(
    safeOc(
      [
        "get",
        "secret",
        "redhat-developer-hub-dynamic-plugins-registry-auth",
        "-n",
        namespace,
        "-o",
        "yaml",
      ],
      60_000,
    ),
    "(dynamic plugin registry auth secret not available)",
  );

  banner("recent namespace events (last 40 lines)");
  const events = safeOc(
    ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp"],
    60_000,
  );
  if (events?.trim()) {
    const lines = events.trim().split("\n");
    console.error(lines.slice(-40).join("\n"));
  } else {
    console.error("(no events or oc get events failed)");
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
      /* try next candidate */
    }
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
