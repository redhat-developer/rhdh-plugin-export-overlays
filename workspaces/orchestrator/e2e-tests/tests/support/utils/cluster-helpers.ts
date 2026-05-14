import { runOc } from "./workflow-deployment-helpers.js";

type EnvEntry = { name: string; value: string };

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

export function patchHttpbin(ns: string, value: string): void {
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
      "--timeout=60s",
    ],
    90_000,
  );
}

export function cleanupAfterTest(ns: string, originalHttpbin: string): void {
  const currentHttpbin = getHttpbinValue(ns);
  if (currentHttpbin !== originalHttpbin) {
    patchHttpbin(ns, originalHttpbin);
    restartAndWait(ns);
  }
}
