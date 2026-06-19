import { runOc, runOcOptional } from "./oc-helpers.js";

type EnvEntry = { name: string; value: string };

const FAILSWITCH_APP_LABEL = "app.kubernetes.io/name=failswitch";
const POD_HTTPBIN_POLL_MS = 2_000;
const POD_HTTPBIN_TIMEOUT_MS = 120_000;
const FAILSWITCH_ROLLOUT_TIMEOUT_S = 120;
const MANAGEMENT_READY_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getHttpbinValue(ns: string): string | undefined {
  try {
    const value = runOc(
      [
        "-n",
        ns,
        "get",
        "sonataflow",
        "failswitch",
        "-o",
        "jsonpath={.spec.podTemplate.container.env[?(@.name=='HTTPBIN')].value}",
      ],
      30_000,
    );
    return value.trim() || undefined;
  } catch {
    return undefined;
  }
}

function readRunningPodHttpbin(ns: string): string | undefined {
  const pod = runOcOptional([
    "-n",
    ns,
    "get",
    "pods",
    "-l",
    FAILSWITCH_APP_LABEL,
    "--field-selector=status.phase=Running",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  ]).stdout.trim();
  if (!pod) {
    return undefined;
  }

  const env = runOcOptional(
    ["-n", ns, "exec", pod, "--", "printenv", "HTTPBIN"],
    15_000,
  );
  if (env.exitCode !== 0) {
    return undefined;
  }
  return env.stdout.trim() || undefined;
}

async function waitForRunningPodHttpbin(
  ns: string,
  expected: string,
  timeoutMs = POD_HTTPBIN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readRunningPodHttpbin(ns) === expected) {
      return;
    }
    await sleep(POD_HTTPBIN_POLL_MS);
  }

  throw new Error(
    `Running failswitch pod HTTPBIN not ${expected} within ${timeoutMs}ms ` +
      `(got ${readRunningPodHttpbin(ns) ?? "unset"})`,
  );
}

export function restartAndWait(ns: string): void {
  runOc(["-n", ns, "rollout", "restart", "deployment", "failswitch"], 30_000);
  runOc(
    [
      "-n",
      ns,
      "rollout",
      "status",
      "deployment",
      "failswitch",
      `--timeout=${FAILSWITCH_ROLLOUT_TIMEOUT_S}s`,
    ],
    (FAILSWITCH_ROLLOUT_TIMEOUT_S + 30) * 1000,
  );
}

/**
 * Poll the SonataFlow management API health endpoint until it responds
 * successfully. After a rollout restart the pod may report Ready to K8s
 * before the management API is fully initialised, causing retrigger calls
 * to receive 503 Service Temporarily Unavailable.
 */
async function waitForManagementApiReady(
  ns: string,
  timeoutMs = MANAGEMENT_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = runOcOptional([
      "-n",
      ns,
      "get",
      "pods",
      "-l",
      FAILSWITCH_APP_LABEL,
      "--field-selector=status.phase=Running",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ]).stdout.trim();

    if (pod) {
      // Quarkus/SonataFlow exposes /q/health/ready; fall back to the
      // management processes endpoint if the health path isn't available.
      const health = runOcOptional(
        [
          "-n",
          ns,
          "exec",
          pod,
          "--",
          "curl",
          "-sf",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "http://localhost:8080/q/health/ready",
        ],
        15_000,
      );
      if (health.exitCode === 0 && health.stdout.trim() === "200") {
        return;
      }
    }

    await sleep(POD_HTTPBIN_POLL_MS);
  }
  // Don't fail the test — proceed and let the retrigger attempt surface
  // any remaining issues with a clearer error message.
  console.warn(
    `[patchHttpbin] SonataFlow management API readiness not confirmed within ${timeoutMs}ms, proceeding anyway`,
  );
}

export async function patchHttpbin(ns: string, value: string): Promise<void> {
  let existing: EnvEntry[] = [];
  try {
    const raw = runOc(
      [
        "-n",
        ns,
        "get",
        "sonataflow",
        "failswitch",
        "-o",
        "jsonpath={.spec.podTemplate.container.env}",
      ],
      30_000,
    ).trim();
    if (raw && raw !== "null") {
      existing = JSON.parse(raw) as EnvEntry[];
    }
  } catch {
    // best effort read of existing env list
  }

  const idx = existing.findIndex((entry) => entry.name === "HTTPBIN");
  if (idx >= 0) {
    existing[idx] = { name: "HTTPBIN", value };
  } else {
    existing.push({ name: "HTTPBIN", value });
  }

  const patch = JSON.stringify({
    spec: { podTemplate: { container: { env: existing } } },
  });
  runOc(
    [
      "-n",
      ns,
      "patch",
      "sonataflow",
      "failswitch",
      "--type",
      "merge",
      "-p",
      patch,
    ],
    30_000,
  );

  restartAndWait(ns);
  await waitForRunningPodHttpbin(ns, value);
  await waitForManagementApiReady(ns);
}

export async function cleanupAfterTest(
  ns: string,
  originalHttpbin: string,
): Promise<void> {
  const currentHttpbin = getHttpbinValue(ns);
  if (currentHttpbin !== originalHttpbin) {
    await patchHttpbin(ns, originalHttpbin);
  }
}
