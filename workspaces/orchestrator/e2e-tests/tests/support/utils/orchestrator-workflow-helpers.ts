import { runOc } from "./test-helpers.js";

const DATA_INDEX_HEALTH_CHECK_TIMEOUT_MS = 15_000;
const DATA_INDEX_ROLLOUT_STATUS_TIMEOUT_MS = 130_000;
const DATA_INDEX_RECOVERY_POLL_INTERVAL_MS = 5_000;
const DATA_INDEX_RECOVERY_MAX_POLLS = 6;

type TestSkipLike = {
  skip: (condition: boolean, reason: string) => void;
};

export type EnsureDataIndexOrSkip = (
  ns: string,
  testObj: TestSkipLike,
) => Promise<void>;

export function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}

function isDataIndexHealthy(ns: string): boolean {
  try {
    const health = runOc(
      [
        "exec",
        "-n",
        ns,
        "deploy/sonataflow-platform-data-index-service",
        "--",
        "curl",
        "-s",
        "--max-time",
        "5",
        "http://localhost:8080/q/health/ready",
      ],
      DATA_INDEX_HEALTH_CHECK_TIMEOUT_MS,
    );
    const parsed = JSON.parse(health);
    return parsed.status === "UP";
  } catch {
    return false;
  }
}

async function recoverDataIndex(ns: string): Promise<boolean> {
  try {
    runOc(
      [
        "rollout",
        "restart",
        "deploy/sonataflow-platform-data-index-service",
        "-n",
        ns,
      ],
      DATA_INDEX_HEALTH_CHECK_TIMEOUT_MS,
    );
    runOc(
      [
        "rollout",
        "status",
        "deploy/sonataflow-platform-data-index-service",
        "-n",
        ns,
        "--timeout=120s",
      ],
      DATA_INDEX_ROLLOUT_STATUS_TIMEOUT_MS,
    );
    for (let attempt = 0; attempt < DATA_INDEX_RECOVERY_MAX_POLLS; attempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, DATA_INDEX_RECOVERY_POLL_INTERVAL_MS),
      );
      if (isDataIndexHealthy(ns)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function createDataIndexGuard(): EnsureDataIndexOrSkip {
  let dataIndexRecoveryFailed = false;

  return async (ns, testObj) => {
    if (dataIndexRecoveryFailed) {
      testObj.skip(
        true,
        "Data-index recovery already failed earlier - skipping",
      );
      return;
    }
    if (isDataIndexHealthy(ns)) {
      return;
    }
    const recovered = await recoverDataIndex(ns);
    if (!recovered) {
      dataIndexRecoveryFailed = true;
    }
    testObj.skip(
      !recovered,
      "Data-index is unhealthy and could not be recovered - skipping workflow execution test",
    );
  };
}
