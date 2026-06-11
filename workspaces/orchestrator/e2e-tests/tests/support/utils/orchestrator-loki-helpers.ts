import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Agent } from "undici";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { runOc, runOcOptional } from "./oc-helpers.js";

const lokiHelpersDir = import.meta.dirname;
const LOKI_INSTALL_SCRIPT = join(
  lokiHelpersDir,
  "../scripts/install-orchestrator-loki.sh",
);
const LOKI_PLACEHOLDER_TOKEN = "e2e-ci-placeholder";
const LOKI_PLACEHOLDER_URL = "http://localhost:3100";
const LOKI_API_PATH_SUFFIX =
  process.env.LOKI_API_PATH ?? "/api/logs/v1/application";

const LOKI_WORKFLOW_LOGGING_PROPERTIES = `
# Include process instance IDs in stdout for orchestrator-backend-module-loki (LogQL |= "<instanceId>")
quarkus.log.category."org.kie.kogito".level=DEBUG
quarkus.log.category."org.jbpm.workflow".level=DEBUG
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** curl -sk equivalent for OpenShift route certs; token stays in headers only. */
const lokiHttpsDispatcher = new Agent({
  connect: { rejectUnauthorized: false },
});

async function fetchLokiApi(
  probeUrl: string,
  token: string,
): Promise<{ status: number; body: string }> {
  if (!probeUrl.startsWith("https://")) {
    throw new Error(`Loki API probe requires https URL: ${probeUrl}`);
  }

  try {
    const response = await fetch(probeUrl, {
      dispatcher: lokiHttpsDispatcher,
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
    } as RequestInit & { dispatcher: Agent });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    throw new Error(
      `Loki API request failed for ${probeUrl}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function resolveOpenShiftAuthToken(): Promise<string> {
  const fromEnv = process.env.AUTH_TOKEN?.trim();
  if (fromEnv && fromEnv !== LOKI_PLACEHOLDER_TOKEN) {
    return fromEnv;
  }

  try {
    const token = runOc(["whoami", "-t"]);
    if (token && token !== LOKI_PLACEHOLDER_TOKEN) {
      return token;
    }
  } catch {
    // fall through
  }

  throw new Error(
    "Could not obtain OpenShift token via `oc whoami -t`. Log in with `oc login` before running orchestrator Loki tests.",
  );
}

function normalizeLokiApiPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  return trimmed || "/api/logs/v1/application";
}

async function resolveLokiInternalUrl(): Promise<string | undefined> {
  const ns = process.env.LOKI_NAMESPACE ?? "openshift-logging";
  const svc = process.env.LOKI_GATEWAY_SERVICE ?? "logging-loki-gateway-http";
  try {
    let portNum = "";
    for (const portName of ["public", "https", "http"]) {
      const result = runOcOptional([
        "get",
        "svc",
        svc,
        "-n",
        ns,
        "-o",
        `jsonpath={.spec.ports[?(@.name=="${portName}")].port}`,
      ]);
      if (result.exitCode === 0) {
        portNum = result.stdout;
      }
      if (portNum) {
        break;
      }
    }
    if (!portNum) {
      const fallback = runOcOptional([
        "get",
        "svc",
        svc,
        "-n",
        ns,
        "-o",
        "jsonpath={.spec.ports[0].port}",
      ]);
      if (fallback.exitCode === 0) {
        portNum = fallback.stdout;
      }
    }
    if (!portNum) {
      return undefined;
    }
    const apiPath = normalizeLokiApiPath(LOKI_API_PATH_SUFFIX);
    return `https://${svc}.${ns}.svc.cluster.local:${portNum}${apiPath}`;
  } catch {
    return undefined;
  }
}

/** install-orchestrator-loki.sh prints the URL on stdout; logs go to stderr. */
function parseLokiInstallScriptUrl(
  stdout: string,
  stderr = "",
): string | undefined {
  const stdoutUrl = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (stdoutUrl?.startsWith("https://")) {
    return stdoutUrl;
  }

  const combined = `${stdout}\n${stderr}`;
  const httpsLines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("https://"));
  return httpsLines.at(-1);
}

async function resolveLokiUrlFromCluster(): Promise<string | undefined> {
  const routeName = process.env.LOKI_ROUTE_NAME ?? "logging-loki";
  const ns = process.env.LOKI_NAMESPACE ?? "openshift-logging";
  try {
    const result = runOcOptional([
      "get",
      "route",
      routeName,
      "-n",
      ns,
      "-o",
      "jsonpath={.spec.host}",
    ]);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const host = result.stdout;
    if (!host) {
      return undefined;
    }
    const apiPath = normalizeLokiApiPath(LOKI_API_PATH_SUFFIX);
    return `https://${host}${apiPath}`;
  } catch {
    return undefined;
  }
}

async function runLokiInstallScript(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const result = spawnSync("bash", [LOKI_INSTALL_SCRIPT], {
    encoding: "utf-8",
    timeout: 1_800_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function buildLokiQueryRangeProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/loki/api/v1/query_range?query=${encodeURIComponent('{openshift_log_type="application"}')}&limit=1`;
}

async function verifyLokiApiReturnsJson(
  baseUrl: string,
  token: string,
): Promise<void> {
  const probeUrl = buildLokiQueryRangeProbeUrl(baseUrl);
  const { status, body } = await fetchLokiApi(probeUrl, token);
  if (status >= 300 && status < 400) {
    throw new Error(
      `Loki API redirected (${status}) for ${probeUrl} — invalid or expired AUTH_TOKEN`,
    );
  }
  if (body.trimStart().startsWith("<")) {
    throw new Error(
      `Loki API returned HTML instead of JSON from ${probeUrl} (check baseUrl path includes /api/logs/v1/application)`,
    );
  }
  try {
    JSON.parse(body);
  } catch (error) {
    throw new Error(`Loki API returned non-JSON from ${probeUrl}`, {
      cause: error,
    });
  }
}

async function selectLokiBaseUrlForRhdh(
  externalUrl: string,
  token: string,
): Promise<string> {
  const preferExternal = process.env.LOKI_USE_EXTERNAL_ROUTE === "true";
  const internalUrl = await resolveLokiInternalUrl();
  const candidates = preferExternal
    ? [externalUrl, internalUrl]
    : [internalUrl, externalUrl];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      await verifyLokiApiReturnsJson(candidate, token);
      console.warn(
        `[configureOrchestratorLoki] Using Loki baseUrl: ${candidate}`,
      );
      return candidate;
    } catch (error) {
      console.warn(
        `[configureOrchestratorLoki] Loki URL candidate rejected (${candidate}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  throw new Error(
    "No Loki baseUrl passed query_range probe (tried in-cluster gateway and external route)",
  );
}

function buildLokiInstanceLogQuery(instanceId: string): string {
  return `{openshift_log_type="application"} |= ${JSON.stringify(instanceId)}`;
}

function lokiQueryRangeUrl(
  baseUrl: string,
  query: string,
  lookbackSeconds: number,
  limit = 10,
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const startNs = String((nowSec - lookbackSeconds) * 1_000_000_000);
  const endNs = String(nowSec * 1_000_000_000);
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    start: startNs,
    end: endNs,
  });
  return `${baseUrl.replace(/\/+$/, "")}/loki/api/v1/query_range?${params.toString()}`;
}

async function countLokiLogLinesForInstance(
  instanceId: string,
  baseUrl: string,
  token: string,
  lookbackSeconds = 7200,
): Promise<number> {
  const probeUrl = lokiQueryRangeUrl(
    baseUrl,
    buildLokiInstanceLogQuery(instanceId),
    lookbackSeconds,
  );

  let status: number;
  let body: string;
  try {
    ({ status, body } = await fetchLokiApi(probeUrl, token));
  } catch (error) {
    throw new Error(
      `Loki instance log probe failed for ${instanceId}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (status < 200 || status >= 300) {
    const detail = body.trim().slice(0, 200);
    throw new Error(
      `Loki instance log probe returned HTTP ${status} for ${instanceId}${detail ? `: ${detail}` : ""}`,
    );
  }
  const parsed = JSON.parse(body) as {
    data?: { result?: Array<{ values?: unknown[] }> };
  };
  return (parsed.data?.result ?? []).reduce(
    (total, stream) => total + (stream.values?.length ?? 0),
    0,
  );
}

/**
 * Discovers cluster Loki (openshift-logging/logging-loki) and sets env vars consumed
 * by rhdh-secrets.yaml (envsubst) and orchestrator-backend-module-loki plugin config.
 * @see https://docs.redhat.com/en/documentation/red_hat_developer_hub/1.9/html/orchestrator_in_red_hat_developer_hub/integrate-loki-logs-to-debug-orchestrator-workflows_orchestrator-in-rhdh
 */
export async function configureOrchestratorLoki(): Promise<void> {
  process.env.AUTH_TOKEN = await resolveOpenShiftAuthToken();

  try {
    const result = await runLokiInstallScript();
    const output = `${result.stdout}${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      throw new Error(
        output || `install-orchestrator-loki.sh exited with ${result.exitCode}`,
      );
    }
    const externalUrl =
      parseLokiInstallScriptUrl(result.stdout, result.stderr) ??
      (await resolveLokiUrlFromCluster());
    if (!externalUrl || externalUrl === LOKI_PLACEHOLDER_URL) {
      throw new Error(
        `Loki install script returned invalid URL: ${externalUrl ?? "(empty)"}`,
      );
    }
    process.env.LOKI_BASE_URL = await selectLokiBaseUrlForRhdh(
      externalUrl,
      process.env.AUTH_TOKEN ?? "",
    );
  } catch (error) {
    if (process.env.LOKI_ALLOW_PLACEHOLDER === "true") {
      console.warn(
        "[configureOrchestratorLoki] Loki unavailable; LOKI_ALLOW_PLACEHOLDER=true:",
        error,
      );
      process.env.LOKI_BASE_URL =
        process.env.LOKI_BASE_URL?.trim() || LOKI_PLACEHOLDER_URL;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[configureOrchestratorLoki] Loki is required for orchestrator log tests. ${message}`,
      { cause: error },
    );
  }
}

/**
 * Poll Loki until logs containing the workflow instance ID are ingested.
 * OpenShift log collectors typically need 30–90s after a workflow completes.
 */
export async function waitForLokiWorkflowLogs(
  instanceId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const token = await resolveOpenShiftAuthToken();
  const clusterUrl = await resolveLokiUrlFromCluster();
  const baseUrl =
    process.env.LOKI_BASE_URL?.trim().replace(/\/+$/, "") ||
    clusterUrl?.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "waitForLokiWorkflowLogs: LOKI_BASE_URL is not configured (run configureOrchestratorLoki first)",
    );
  }

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const lineCount = await countLokiLogLinesForInstance(
        instanceId,
        baseUrl,
        token,
      );
      if (lineCount > 0) {
        console.warn(
          `[waitForLokiWorkflowLogs] Found ${lineCount} log line(s) for instance ${instanceId}`,
        );
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(5_000);
  }

  const detail =
    lastError instanceof Error ? lastError.message : String(lastError ?? "");
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Loki logs for workflow instance ${instanceId}.${detail ? ` Last probe error: ${detail}` : ""}`,
  );
}

/** Patches workflow *-props ConfigMaps so stdout includes process instance IDs for Loki. */
export async function patchWorkflowPropsForLokiLogging(
  namespace: string,
  workflows: readonly string[],
): Promise<void> {
  for (const workflow of workflows) {
    const configMapName = `${workflow}-props`;
    const getResult = runOcOptional([
      "get",
      "configmap",
      configMapName,
      "-n",
      namespace,
      "-o",
      "jsonpath={.data.application\\.properties}",
    ]);
    if (getResult.exitCode !== 0) {
      console.warn(
        `[deploy-sonataflow] Skipping Loki logging patch; ${configMapName} not found`,
      );
      continue;
    }

    const applicationProperties = getResult.stdout;
    if (applicationProperties.includes('org.kie.kogito".level=DEBUG')) {
      continue;
    }

    const patched = `${applicationProperties.trimEnd()}\n${LOKI_WORKFLOW_LOGGING_PROPERTIES.trim()}\n`;
    const patchPayload = {
      // Kubernetes ConfigMap data key (not camelCase)
      // eslint-disable-next-line @typescript-eslint/naming-convention
      data: { "application.properties": patched },
    };
    await $`oc patch configmap ${configMapName} -n ${namespace} --type merge -p ${JSON.stringify(patchPayload)}`;
    console.warn(
      `[deploy-sonataflow] Patched ${configMapName} for orchestrator Loki log correlation`,
    );
  }
}
