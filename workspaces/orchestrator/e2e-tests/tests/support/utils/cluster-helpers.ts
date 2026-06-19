import { runOc, runOcOptional } from "./oc-helpers.js";

type EnvEntry = { name: string; value: string };

const FAILSWITCH_APP_LABEL = "app.kubernetes.io/name=failswitch";
const POD_HTTPBIN_POLL_MS = 2_000;
const POD_HTTPBIN_TIMEOUT_MS = 120_000;
const FAILSWITCH_ROLLOUT_TIMEOUT_S = 120;

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
