import { execSync } from "child_process";
import { join } from "path";
import { installOrchestrator } from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";

const WORKFLOW_REPO =
  "https://github.com/rhdhorchestrator/serverless-workflows.git";

const MANIFEST_DIRS = [
  "workflows/greeting/manifests",
  "workflows/fail-switch/src/main/resources/manifests",
];

const WORKFLOWS = ["greeting", "failswitch"];

export async function deploySonataflow(namespace: string): Promise<void> {
  await installOrchestrator(namespace);

  const oslFullVersion = detectOperatorVersion(
    "operators.coreos.com/logic-operator.openshift-operators",
  );
  const oslMajorMinor = oslFullVersion.replace(/^(\d+\.\d+).*/, "$1") || "";

  const osFullVersion = detectOperatorVersion(
    "operators.coreos.com/serverless-operator.openshift-operators",
  );
  const osMajorMinor = osFullVersion.replace(/^(\d+\.\d+).*/, "$1") || "";

  // eslint-disable-next-line no-console
  console.log(
    `[deploy-sonataflow] Operator versions: OS=${osFullVersion || "unknown"} (${osMajorMinor || "?"}), OSL=${oslFullVersion || "unknown"} (${oslMajorMinor || "?"})`,
  );

  if (osMajorMinor && oslMajorMinor && osMajorMinor !== oslMajorMinor) {
    console.warn(
      `[deploy-sonataflow] WARNING: OS (${osMajorMinor}) and OSL (${oslMajorMinor}) major.minor versions differ — Knative API incompatibilities may cause failures. Pin matching versions via OS_STARTING_CSV / OSL_STARTING_CSV.`,
    );
  }

  // Widen data-index probe failureThresholds — SmallRye health checks degrade after
  // ~7 min without a broker, returning 503 and removing the pod from Service endpoints.
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
    oc(
      `-n ${namespace} patch sonataflowplatform sonataflow-platform --type merge -p '${sfpPatch}'`,
    );

    oc(
      `rollout status deployment/sonataflow-platform-data-index-service -n ${namespace} --timeout=300s`,
    );

    oc(
      `rollout status deployment/sonataflow-platform-jobs-service -n ${namespace} --timeout=300s`,
    );

    await waitForPodReady(
      namespace,
      "sonataflow-platform-data-index-service",
      5,
    );
    await waitForPodReady(namespace, "sonataflow-platform-jobs-service", 5);
  } catch {
    /* SFP patch non-fatal */
  }

  const workflowDir = `/tmp/serverless-workflows-${process.pid}`;
  try {
    await $`git clone --depth=1 ${WORKFLOW_REPO} ${workflowDir}`;

    for (const rel of MANIFEST_DIRS) {
      const fullPath = join(workflowDir, rel);
      await $`oc apply -n ${namespace} -f ${fullPath}`;
    }
  } finally {
    await $`rm -rf ${workflowDir}`.catch(() => {});
  }

  await waitForCRs(namespace);

  // Manifests ship with osl_1_37 image tags; align to the installed OSL version
  // to avoid the data-index "Unrecognized event type" error.
  if (oslMajorMinor && oslMajorMinor !== "1.37") {
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
        oc(
          `-n ${namespace} patch sonataflow ${wf} --type merge -p '${imgPatch}'`,
        );
      } catch {
        /* ignore per-workflow patch failure */
      }
    }
  }

  for (const workflow of WORKFLOWS) {
    patchWorkflowPostgres(namespace, workflow);

    await waitForReconciliation(namespace, workflow, 60);

    oc(`rollout status deployment/${workflow} -n ${namespace} --timeout=600s`);
  }

  for (const workflow of WORKFLOWS) {
    await waitForPodReady(namespace, workflow, 5);
  }
}

/** Patch a SonataFlow CR's persistence to point at the backstage-psql instance. */
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
  return oc(
    `-n ${namespace} patch sonataflow ${workflow} --type merge -p '${patch}'`,
  );
}

/** Wait until at least two SonataFlow CRs exist in the namespace. */
async function waitForCRs(namespace: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const out = oc(`get sonataflow -n ${namespace} --no-headers`);
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
  while (Date.now() < deadline) {
    attempt++;
    try {
      const status = oc(
        `get deployment ${workflow} -n ${namespace} -o jsonpath='{.status.conditions[?(@.type=="Progressing")].status}'`,
      );
      const cleaned = status.replace(/'/g, "");
      if (cleaned === "True") {
        return;
      }
    } catch {
      // not available yet
    }
    await sleep(2_000);
  }
  console.warn(
    `[deploy-sonataflow] TIMEOUT waiting for reconciliation of ${workflow} after ${timeoutSecs}s (${attempt} attempts)`,
  );
}

function oc(args: string): string {
  return execSync(`oc ${args}`, { encoding: "utf-8" }).trim();
}

/** Detect operator version from the CSV matching the given OLM label. */
function detectOperatorVersion(label: string): string {
  try {
    return oc(
      `get csv -n openshift-operators -o jsonpath={.items[0].spec.version} -l ${label}`,
    );
  } catch {
    return "";
  }
}

/** Wait for a pod matching `namePattern` to reach Running & Ready. */
async function waitForPodReady(
  namespace: string,
  namePattern: string,
  timeoutMinutes = 5,
  intervalSeconds = 10,
): Promise<void> {
  const maxAttempts = (timeoutMinutes * 60) / intervalSeconds;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const podLine = oc(`get pods -n ${namespace} --no-headers`)
        .split("\n")
        .find((l) => l.includes(namePattern));
      if (podLine) {
        const podName = podLine.trim().split(/\s+/)[0];
        const phase = oc(
          `get pod ${podName} -n ${namespace} -o jsonpath='{.status.phase}'`,
        );
        const ready = oc(
          `get pod ${podName} -n ${namespace} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'`,
        );
        if (
          phase.replaceAll("'", "") === "Running" &&
          ready.replaceAll("'", "") === "True"
        ) {
          return;
        }
      }
    } catch {
      // not available yet
    }
    if (i === maxAttempts) {
      return;
    }
    await sleep(intervalSeconds * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
