/**
 * CI-only SonataFlow deploy readiness helpers.
 * Operator version detection, image tag resolution, deployment wait, and failure diagnostics.
 */

export const WORKFLOW_DEPLOYMENT_TIMEOUT_MS = 600_000;
export const POSTGRES_ALIGN_TIMEOUT_MS = 300_000;

export const SERVERLESS_OPERATOR_PACKAGE = "serverless-operator";
export const LOGIC_OPERATOR_PACKAGE = "logic-operator";

export type WorkflowOcDeps = {
  runOc: (args: string[], timeoutMs?: number) => string;
};

type CsvList = {
  items?: Array<{
    spec?: { name?: string; version?: string };
    status?: { phase?: string };
  }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOcJson<T>(
  deps: WorkflowOcDeps,
  args: string[],
  timeoutMs: number,
): T | undefined {
  try {
    return JSON.parse(deps.runOc(args, timeoutMs)) as T;
  } catch {
    return undefined;
  }
}

function compareMajorMinor(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  if (aMajor !== bMajor) return aMajor - bMajor;
  return aMinor - bMinor;
}

function detectOperatorVersionByPackageName(
  deps: WorkflowOcDeps,
  packageName: string,
): string {
  const data = parseOcJson<CsvList>(
    deps,
    ["get", "csv", "-n", "openshift-operators", "-o", "json"],
    30_000,
  );
  if (!data?.items?.length) return "";

  const csv = data.items.find(
    (item) =>
      item.spec?.name === packageName && item.status?.phase === "Succeeded",
  );
  return csv?.spec?.version ?? "";
}

export function getOperatorMajorMinorVersions(deps: WorkflowOcDeps): {
  osMajorMinor: string;
  oslMajorMinor: string;
} {
  const toMajorMinor = (version: string) =>
    version.replace(/^(\d+\.\d+).*/, "$1") || "";

  return {
    oslMajorMinor: toMajorMinor(
      detectOperatorVersionByPackageName(deps, LOGIC_OPERATOR_PACKAGE),
    ),
    osMajorMinor: toMajorMinor(
      detectOperatorVersionByPackageName(deps, SERVERLESS_OPERATOR_PACKAGE),
    ),
  };
}

/**
 * Pick a published Quay workflow image tag when OS and OSL versions differ.
 * Quay typically only has images for the lower published OSL line (e.g. osl_1_37).
 */
export function resolveWorkflowImageMajorMinor(
  osMajorMinor: string,
  oslMajorMinor: string,
): string {
  const envOverride = process.env.SERVERLESS_WORKFLOW_IMAGE_OSL?.trim();
  if (envOverride) {
    return envOverride.replace(/^osl_(\d+)_(\d+)$/i, "$1.$2");
  }

  if (!osMajorMinor && !oslMajorMinor) return "";
  if (!osMajorMinor) return oslMajorMinor;
  if (!oslMajorMinor) return osMajorMinor;

  if (osMajorMinor === oslMajorMinor) {
    return oslMajorMinor;
  }

  return compareMajorMinor(osMajorMinor, oslMajorMinor) <= 0
    ? osMajorMinor
    : oslMajorMinor;
}

function formatOcFailure(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.trim();
    return m.includes("\n") ? (m.split("\n")[0] ?? m) : m;
  }
  return String(err);
}

/**
 * CI failure diagnostics — mirrors:
 *   oc get deploy,ksvc -n <namespace>
 *   oc describe sonataflow <workflow> -n <namespace>  (status/conditions in describe output)
 */
export function logWorkflowDeployCiDiagnostics(
  namespace: string,
  workflows: readonly string[],
  runOc: WorkflowOcDeps["runOc"],
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

  banner(`oc get deploy,ksvc -n ${namespace}`);
  dumpOc(
    safeOc(["get", "deploy,ksvc", "-n", namespace], 60_000),
    "(no Deployments or Knative Services in namespace)",
  );

  for (const workflow of workflows) {
    banner(`oc describe sonataflow ${workflow} -n ${namespace}`);
    dumpOc(
      safeOc(["describe", "sonataflow", workflow, "-n", namespace], 120_000),
      `(describe sonataflow/${workflow} — empty or not found)`,
    );
  }
}

/** Wait until the SonataFlow operator creates the workflow Deployment. */
export async function waitForWorkflowDeployment(
  namespace: string,
  workflow: string,
  timeoutMs: number,
  deps: WorkflowOcDeps,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      deps.runOc(["get", "deployment", workflow, "-n", namespace], 15_000);
      return;
    } catch {
      await sleep(2_000);
    }
  }

  logWorkflowDeployCiDiagnostics(namespace, [workflow], deps.runOc);
  throw new Error(
    `[deploy-sonataflow] TIMEOUT (${timeoutMs}ms): deployment/${workflow} was not created in namespace ${namespace}`,
  );
}

/** Workflow deployment dumps for deploy failure diagnostics. */
export function logWorkflowDeployFailureDiagnostics(
  namespace: string,
  workflows: readonly string[],
  runOc: WorkflowOcDeps["runOc"],
): void {
  logWorkflowDeployCiDiagnostics(namespace, workflows, runOc);
}
