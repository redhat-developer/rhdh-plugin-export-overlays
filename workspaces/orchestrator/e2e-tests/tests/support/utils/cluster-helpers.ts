import { runOc, runOcOptional } from "./oc-helpers.js";

type EnvEntry = { name: string; value: string };

const FAILSWITCH_APP_LABEL = "app.kubernetes.io/name=failswitch";
const FAILSWITCH_CONTAINER = "workflow";
const FAILSWITCH_PROPS_CM = "failswitch-props";
const HTTPBIN_REST_CLIENT_PROP = "quarkus.rest-client.httpbin_yaml.url";
const POD_HTTPBIN_POLL_MS = 2_000;
const POD_HTTPBIN_TIMEOUT_MS = 120_000;
const PROPS_HTTPBIN_POLL_MS = 2_000;
const PROPS_HTTPBIN_TIMEOUT_MS = 120_000;
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

function readFailswitchProps(ns: string): string | undefined {
  const result = runOcOptional([
    "get",
    "configmap",
    FAILSWITCH_PROPS_CM,
    "-n",
    ns,
    "-o",
    "jsonpath={.data.application\\.properties}",
  ]);
  return result.exitCode === 0 ? result.stdout : undefined;
}

function readHttpbinFromFailswitchProps(ns: string): string | undefined {
  const props = readFailswitchProps(ns);
  if (!props) {
    return undefined;
  }
  const match = props.match(/^quarkus\.rest-client\.httpbin_yaml\.url=(.+)$/m);
  return match?.[1]?.trim();
}

function withHttpbinRestClientUrl(props: string, httpbinUrl: string): string {
  const line = `${HTTPBIN_REST_CLIENT_PROP}=${httpbinUrl}`;
  const pattern = /^quarkus\.rest-client\.httpbin_yaml\.url=.*$/m;
  if (pattern.test(props)) {
    return props.replace(pattern, line);
  }
  return `${props.trimEnd()}\n${line}\n`;
}

function patchFailswitchPropsHttpbin(ns: string, httpbinUrl: string): void {
  const props = readFailswitchProps(ns);
  if (!props) {
    throw new Error(
      `ConfigMap ${FAILSWITCH_PROPS_CM} not found or empty in namespace ${ns}`,
    );
  }
  const patch = JSON.stringify({
    data: {
      // Kubernetes ConfigMap data key (not camelCase)
      // eslint-disable-next-line @typescript-eslint/naming-convention
      "application.properties": withHttpbinRestClientUrl(props, httpbinUrl),
    },
  });
  runOc(
    [
      "patch",
      "configmap",
      FAILSWITCH_PROPS_CM,
      "-n",
      ns,
      "--type",
      "merge",
      "-p",
      patch,
    ],
    30_000,
  );
}

function readRunningPodHttpbin(ns: string): string | undefined {
  const list = runOcOptional([
    "-n",
    ns,
    "get",
    "pods",
    "-l",
    FAILSWITCH_APP_LABEL,
    "-o",
    'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
  ]);
  if (list.exitCode !== 0) {
    return undefined;
  }

  const pods = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = pods.length - 1; i >= 0; i -= 1) {
    const pod = pods[i];
    const ready = runOcOptional([
      "-n",
      ns,
      "get",
      "pod",
      pod,
      "-o",
      `jsonpath={.status.containerStatuses[?(@.name=="${FAILSWITCH_CONTAINER}")].ready}`,
    ]).stdout.trim();
    if (ready !== "true") {
      continue;
    }

    const value = runOcOptional([
      "-n",
      ns,
      "get",
      "pod",
      pod,
      "-o",
      `jsonpath={.spec.containers[?(@.name=="${FAILSWITCH_CONTAINER}")].env[?(@.name=="HTTPBIN")].value}`,
    ]).stdout.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
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

async function waitForFailswitchPropsHttpbin(
  ns: string,
  expected: string,
  timeoutMs = PROPS_HTTPBIN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readHttpbinFromFailswitchProps(ns) === expected) {
      return;
    }
    await sleep(PROPS_HTTPBIN_POLL_MS);
  }

  throw new Error(
    `failswitch-props ${HTTPBIN_REST_CLIENT_PROP} not ${expected} within ${timeoutMs}ms ` +
      `(got ${readHttpbinFromFailswitchProps(ns) ?? "unset"})`,
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

  // Quarkus resolves the REST client URL from failswitch-props at pod startup.
  patchFailswitchPropsHttpbin(ns, value);
  await waitForFailswitchPropsHttpbin(ns, value);

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
