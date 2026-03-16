import { installOrchestrator } from "rhdh-e2e-test-utils/orchestrator";
import { $ } from "rhdh-e2e-test-utils/utils";

const WORKFLOW_REPO =
  "https://github.com/rhdhorchestrator/serverless-workflows.git";

export async function deploySonataflow(namespace: string): Promise<void> {
  await installOrchestrator(namespace);

  const workflowDir = `/tmp/serverless-workflows-${process.pid}`;
  try {
    await $`git clone --depth=1 ${WORKFLOW_REPO} ${workflowDir}`;
    await $`oc apply -n ${namespace} -f ${workflowDir}/workflows/greeting/manifests/`;
    await $`oc apply -n ${namespace} -f ${workflowDir}/workflows/fail-switch/src/main/resources/manifests/`;
  } finally {
    await $`rm -rf ${workflowDir}`.catch(() => {});
  }

  await waitForWorkflows(namespace);
}

async function waitForWorkflows(namespace: string): Promise<void> {
  const resourceDeadline = Date.now() + 60_000;
  while (Date.now() < resourceDeadline) {
    try {
      const result = await $`oc get sonataflow -n ${namespace} --no-headers`;
      if (result.stdout.trim().split("\n").filter(Boolean).length >= 2) break;
    } catch {
      /* resources not available yet */
    }
    await sleep(5_000);
  }

  await Promise.all([
    waitForRunning(namespace, "greeting", 15),
    waitForRunning(namespace, "failswitch", 15),
  ]);
}

async function waitForRunning(
  namespace: string,
  name: string,
  timeoutMinutes: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    try {
      const result = await $`oc get sonataflow ${name} -n ${namespace} -o json`;
      const conditions: { type: string; status: string }[] =
        JSON.parse(result.stdout)?.status?.conditions ?? [];
      const running = conditions.find((c) => c.type === "Running");
      if (running?.status === "True") return;
    } catch {
      /* not ready yet */
    }
    await sleep(15_000);
  }
  throw new Error(
    `Timeout: workflow '${name}' did not reach Running in ${timeoutMinutes}m`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
