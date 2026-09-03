import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { runOc } from "./oc-helpers.js";

const kafkaHelpersDir = import.meta.dirname;
const KAFKA_INSTALL_SCRIPT = join(
  kafkaHelpersDir,
  "../scripts/install-orchestrator-kafka.sh",
);

const APP_CONFIG_CM = "app-config-rhdh";
const APP_CONFIG_KEY = "app-config-rhdh.yaml";
const RHDH_DEPLOYMENT = "redhat-developer-hub";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runKafkaInstallScript(
  namespace: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  process.env.KAFKA_NAMESPACE = namespace;
  const result = spawnSync("bash", [KAFKA_INSTALL_SCRIPT], {
    encoding: "utf-8",
    timeout: 1_800_000,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) {
    throw new Error(
      `install-orchestrator-kafka.sh failed: ${result.error.message}`,
    );
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseBootstrapFromStdout(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bootstrap = lines[lines.length - 1];
  if (!bootstrap?.includes(":")) {
    throw new Error(
      `install-orchestrator-kafka.sh did not print bootstrap (stdout=${JSON.stringify(stdout)})`,
    );
  }
  return bootstrap;
}

/**
 * Merge orchestrator.kafka into ConfigMap app-config-rhdh and restart RHDH (scale 0→1).
 */
export async function patchAppConfigKafka(
  namespace: string,
  bootstrap: string,
): Promise<void> {
  const current = runOc(
    [
      "-n",
      namespace,
      "get",
      "configmap",
      APP_CONFIG_CM,
      "-o",
      "jsonpath={.data.app-config-rhdh\\.yaml}",
    ],
    60_000,
  );
  if (!current.trim()) {
    throw new Error(
      `ConfigMap ${APP_CONFIG_CM} has empty ${APP_CONFIG_KEY} in namespace ${namespace}`,
    );
  }

  let data: Record<string, unknown>;
  try {
    const loaded = yaml.load(current);
    data =
      loaded && typeof loaded === "object" && !Array.isArray(loaded)
        ? (loaded as Record<string, unknown>)
        : {};
  } catch (err) {
    throw new Error(
      `Failed to parse ${APP_CONFIG_KEY} as YAML: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const orchRaw = data.orchestrator;
  const orch: Record<string, unknown> =
    orchRaw && typeof orchRaw === "object" && !Array.isArray(orchRaw)
      ? (orchRaw as Record<string, unknown>)
      : {};
  const existingKafka =
    orch.kafka && typeof orch.kafka === "object" && !Array.isArray(orch.kafka)
      ? (orch.kafka as Record<string, unknown>)
      : undefined;
  const existingBrokers = Array.isArray(existingKafka?.brokers)
    ? (existingKafka.brokers as unknown[])
    : [];
  if (
    existingKafka?.clientId === "orchestratorKafka" &&
    existingBrokers.length === 1 &&
    existingBrokers[0] === bootstrap
  ) {
    console.warn(
      `[configureOrchestratorKafka] app-config already has brokers=[${bootstrap}]; skipping restart`,
    );
    return;
  }

  orch.kafka = {
    clientId: "orchestratorKafka",
    brokers: [bootstrap],
  };
  data.orchestrator = orch;

  const merged = yaml.dump(data, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "orch-kafka-appconfig-"));
  const outFile = join(tmpDir, "app-config-out.yaml");
  const manifestFile = join(tmpDir, "configmap.yaml");
  try {
    writeFileSync(outFile, merged, "utf-8");

    const manifest = runOc(
      [
        "-n",
        namespace,
        "create",
        "configmap",
        APP_CONFIG_CM,
        `--from-file=${APP_CONFIG_KEY}=${outFile}`,
        "--dry-run=client",
        "-o",
        "yaml",
      ],
      120_000,
    );
    writeFileSync(manifestFile, manifest, "utf-8");
    runOc(["-n", namespace, "apply", "-f", manifestFile], 120_000);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  await restartRhdhScaleZeroOne(namespace);
}

async function restartRhdhScaleZeroOne(namespace: string): Promise<void> {
  console.warn(
    `[configureOrchestratorKafka] Restarting ${RHDH_DEPLOYMENT} via scale 0→1 in ${namespace}`,
  );
  runOc(
    ["-n", namespace, "scale", `deploy/${RHDH_DEPLOYMENT}`, "--replicas=0"],
    60_000,
  );
  try {
    // Prefer the Backstage Deployment pods only — the chart's postgresql
    // StatefulSet also carries app.kubernetes.io/instance=redhat-developer-hub.
    runOc(
      [
        "-n",
        namespace,
        "wait",
        "--for=delete",
        "pod",
        "-l",
        "app.kubernetes.io/component=backstage",
        "--timeout=180s",
      ],
      200_000,
    );
  } catch {
    // pods may already be gone
  }
  runOc(
    ["-n", namespace, "scale", `deploy/${RHDH_DEPLOYMENT}`, "--replicas=1"],
    60_000,
  );
  runOc(
    [
      "-n",
      namespace,
      "rollout",
      "status",
      `deployment/${RHDH_DEPLOYMENT}`,
      "--timeout=600s",
    ],
    620_000,
  );
  // Pod Ready is not enough — RBAC routes can 404 for a bit after restart.
  await waitForRhdhPermissionApiReady();
}

/**
 * Poll until POST-able RBAC routes are mounted (401/403 without a token is OK;
 * 404 means the permission backend is not serving yet).
 */
async function waitForRhdhPermissionApiReady(
  timeoutMs = 180_000,
): Promise<void> {
  const baseUrl = process.env.RHDH_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    console.warn(
      "[configureOrchestratorKafka] RHDH_BASE_URL unset; sleeping 15s after rollout",
    );
    await sleep(15_000);
    return;
  }
  const url = `${baseUrl}/api/permission/roles`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET", redirect: "manual" });
      // Route exists once we get anything other than 404/502/503.
      if (![404, 502, 503].includes(res.status)) {
        console.warn(
          `[configureOrchestratorKafka] Permission API ready (HTTP ${res.status})`,
        );
        return;
      }
      console.warn(
        `[configureOrchestratorKafka] Waiting for permission API (HTTP ${res.status})`,
      );
    } catch (err) {
      console.warn(
        `[configureOrchestratorKafka] Waiting for permission API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sleep(5_000);
  }
  throw new Error(
    `Timed out waiting for RHDH permission API at ${url} after ${timeoutMs}ms`,
  );
}

/**
 * Install Kafka (if needed), wire orchestrator.kafka into RHDH app-config, restart RHDH.
 * Returns bootstrap host:port.
 */
export async function configureOrchestratorKafka(
  namespace: string,
): Promise<string> {
  const result = await runKafkaInstallScript(namespace);
  if (result.stderr.trim()) {
    console.warn(result.stderr.trimEnd());
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `install-orchestrator-kafka.sh exited with ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
  const bootstrap = parseBootstrapFromStdout(result.stdout);
  console.warn(
    `[configureOrchestratorKafka] Using Kafka bootstrap: ${bootstrap}`,
  );
  await patchAppConfigKafka(namespace, bootstrap);
  return bootstrap;
}
