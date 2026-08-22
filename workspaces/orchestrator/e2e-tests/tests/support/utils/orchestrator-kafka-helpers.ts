import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  const tmpDir = mkdtempSync(join(tmpdir(), "orch-kafka-appconfig-"));
  const inFile = join(tmpDir, "app-config-in.yaml");
  const outFile = join(tmpDir, "app-config-out.yaml");
  try {
    writeFileSync(inFile, current, "utf-8");
    const py = `
import sys
try:
    import yaml
except ImportError:
    sys.stderr.write("PyYAML required (python3 -m pip install pyyaml)\\n")
    sys.exit(2)
path_in, path_out, bootstrap = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path_in, encoding="utf-8") as f:
    data = yaml.safe_load(f) or {}
orch = data.setdefault("orchestrator", {})
orch["kafka"] = {
    "clientId": "orchestratorKafka",
    "brokers": [bootstrap],
}
with open(path_out, "w", encoding="utf-8") as f:
    yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
`;
    const pyResult = spawnSync(
      "python3",
      ["-c", py, inFile, outFile, bootstrap],
      { encoding: "utf-8" },
    );
    if (pyResult.status !== 0) {
      throw new Error(
        `Failed to merge orchestrator.kafka into app-config: ${pyResult.stderr || pyResult.stdout}`,
      );
    }

    const apply = spawnSync(
      "bash",
      [
        "-c",
        `oc create configmap ${APP_CONFIG_CM} -n ${namespace} --from-file=${APP_CONFIG_KEY}=${outFile} --dry-run=client -o yaml | oc apply -f -`,
      ],
      { encoding: "utf-8" },
    );
    if (apply.status !== 0) {
      throw new Error(
        `Failed to apply ${APP_CONFIG_CM}: ${apply.stderr || apply.stdout}`,
      );
    }
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
  await sleep(5_000);
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
