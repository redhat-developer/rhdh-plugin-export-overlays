import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type KubernetesClientHelper,
  runQuietUnlessFailure,
} from "@red-hat-developer-hub/e2e-test-utils/utils";

const TOKEN_SECRET = "sonarqube-e2e-token";
const sonarqubeDir = path.join(import.meta.dirname, "../config/sonarqube");

/**
 * Reads the generated token. Command output stays in the child-process buffer
 * and is never written to the console. A failure is replaced so the payload
 * cannot ride along on the thrown error.
 */
export function readSonarQubeToken(namespace: string): string {
  return readSecretKey(namespace, TOKEN_SECRET, "token");
}

export async function deploySonarQube(
  k8s: KubernetesClientHelper,
  namespace: string,
): Promise<void> {
  await applyManifest(
    k8s,
    path.join(sonarqubeDir, "sonarqube.yaml"),
    namespace,
  );
  await k8s.createOrUpdateConfigMap(
    "sonarqube-catalog-entities",
    namespace,
    path.join(sonarqubeDir, "catalog-entities.yaml"),
    "entities.yaml",
  );
  await k8s.createOrUpdateConfigMap(
    "sonarqube-scan-app",
    namespace,
    path.join(sonarqubeDir, "scan/app.js"),
  );
  await k8s.createOrUpdateConfigMap(
    "sonarqube-scan-lcov-high",
    namespace,
    path.join(sonarqubeDir, "scan/lcov-high.info"),
  );
  await k8s.createOrUpdateConfigMap(
    "sonarqube-scan-lcov-low",
    namespace,
    path.join(sonarqubeDir, "scan/lcov-low.info"),
  );

  const rendered = writeRenderedCatalog();
  try {
    await applyManifest(k8s, rendered.filePath, namespace);
  } finally {
    rmSync(rendered.directory, { recursive: true, force: true });
  }

  await k8s.waitForPodsWithFailureDetection(
    namespace,
    "app=sonarqube-catalog",
    180,
  );
  await k8s.waitForPodsWithFailureDetection(namespace, "app=sonarqube", 300);

  const baseUrl = await waitForRoute(k8s, namespace);
  await waitForSonarUp(baseUrl);

  if (!secretExists(namespace, TOKEN_SECRET)) {
    await provisionToken(k8s, namespace, baseUrl);
  }

  deleteJobIfPresent(namespace);
  await applyManifest(k8s, path.join(sonarqubeDir, "scan-job.yaml"), namespace);
  await waitForScanJob(namespace);
}

/**
 * Applies one manifest file. `KubernetesClientHelper.applyManifest` is still
 * commented out in e2e-test-utils 2.2.3. Replace this body with
 * `k8s.applyManifest(filePath, namespace)` when that method ships.
 */
async function applyManifest(
  _k8s: KubernetesClientHelper,
  filePath: string,
  namespace: string,
): Promise<void> {
  await runQuietUnlessFailure`oc apply --namespace=${namespace} -f ${filePath}`;
}

function writeRenderedCatalog(): { directory: string; filePath: string } {
  const image = resolvePythonImage();
  const source = readFileSync(
    path.join(sonarqubeDir, "catalog-server.yaml"),
    "utf8",
  );
  if (!source.includes("${PYTHON_IMAGE}")) {
    throw new Error("Catalog manifest is missing the PYTHON_IMAGE placeholder");
  }
  const directory = mkdtempSync(path.join(tmpdir(), "sonarqube-catalog-"));
  const filePath = path.join(directory, "catalog-server.yaml");
  writeFileSync(filePath, source.replaceAll("${PYTHON_IMAGE}", image), {
    mode: 0o600,
  });
  return { directory, filePath };
}

function resolvePythonImage(): string {
  const tags = runOcOrThrow(
    [
      "get",
      "imagestream",
      "python",
      "-n",
      "openshift",
      "-o",
      "jsonpath={.spec.tags[*].name}",
    ],
    "Failed to read imagestream openshift/python",
  );
  const tag = tags
    .split(/\s+/)
    .map((name) => name.trim())
    .filter((name) => name.endsWith("ubi9"))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )
    .at(-1);
  if (!tag) {
    throw new Error("No ubi9 tag on imagestream openshift/python");
  }
  return `image-registry.openshift-image-registry.svc:5000/openshift/python:${tag}`;
}

async function waitForRoute(
  k8s: KubernetesClientHelper,
  namespace: string,
): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      return await k8s.getRouteLocation(namespace, "sonarqube");
    } catch {
      await sleep(2_000);
    }
  }
  throw new Error("Timed out waiting for the SonarQube route");
}

async function waitForSonarUp(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      const response = await requestSonar(
        new URL("/api/system/status", baseUrl),
        "GET",
        {},
      );
      if (response.statusCode === 200 && readStatus(response.body) === "UP") {
        return;
      }
    } catch {
      // The route can refuse connections until the router sees the pod.
    }
    await sleep(10_000);
  }
  throw new Error("Timed out waiting for SonarQube to report UP");
}

async function provisionToken(
  k8s: KubernetesClientHelper,
  namespace: string,
  baseUrl: string,
): Promise<void> {
  const password = randomBytes(12).toString("hex");
  await changeAdminPassword(baseUrl, password);
  const token = await generateUserToken(baseUrl, password);
  try {
    await k8s.applySecretFromObject(
      TOKEN_SECRET,
      { stringData: { token } },
      namespace,
    );
  } catch {
    throw new Error(
      `Failed to store the SonarQube token in secret ${TOKEN_SECRET}`,
    );
  }
}

async function changeAdminPassword(
  baseUrl: string,
  password: string,
): Promise<void> {
  const body = new URLSearchParams({
    login: "admin",
    previousPassword: "admin",
    password,
  }).toString();
  const response = await requestSonar(
    new URL("/api/users/change_password", baseUrl),
    "POST",
    formHeaders(basicAuthorization("admin", "admin")),
    body,
  );
  if (response.statusCode !== 204 && response.statusCode !== 200) {
    throw new Error(
      `Failed to change the SonarQube admin password (HTTP ${response.statusCode})`,
    );
  }
}

async function generateUserToken(
  baseUrl: string,
  password: string,
): Promise<string> {
  const body = new URLSearchParams({ name: "scorecard-e2e" }).toString();
  const response = await requestSonar(
    new URL("/api/user_tokens/generate", baseUrl),
    "POST",
    formHeaders(basicAuthorization("admin", password)),
    body,
  );
  if (response.statusCode !== 200) {
    throw new Error(
      `Failed to create a SonarQube user token (HTTP ${response.statusCode})`,
    );
  }
  return readJsonToken(response.body);
}

function formHeaders(authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

type SonarResponse = {
  statusCode: number;
  body: string;
};

function requestSonar(
  target: URL,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<SonarResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      target,
      {
        method,
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `SonarQube request failed (${method} ${target.pathname}: ${error.code ?? "error"})`,
        ),
      );
    });
    if (body !== undefined) {
      request.setHeader("Content-Length", Buffer.byteLength(body));
      request.write(body);
    }
    request.end();
  });
}

function readStatus(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "status" in parsed &&
      typeof parsed.status === "string"
    ) {
      return parsed.status;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readJsonToken(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("SonarQube token response was not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("token" in parsed) ||
    typeof parsed.token !== "string" ||
    parsed.token.length === 0
  ) {
    throw new Error("Failed to create a SonarQube user token");
  }
  return parsed.token;
}

function deleteJobIfPresent(namespace: string): void {
  try {
    runOc([
      "delete",
      "job",
      "sonarqube-scan",
      "--namespace",
      namespace,
      "--ignore-not-found",
    ]);
  } catch {
    throw new Error(
      `Failed to delete job sonarqube-scan in namespace ${namespace}`,
    );
  }
}

async function waitForScanJob(namespace: string): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (jobCondition(namespace, "Complete") === "True") {
      return;
    }
    if (jobCondition(namespace, "Failed") === "True") {
      throw new Error(
        `Job sonarqube-scan failed in namespace ${namespace}. Scanner logs were not collected because they can contain the token.`,
      );
    }
    await sleep(5_000);
  }
  throw new Error(
    `Timed out waiting for job sonarqube-scan in namespace ${namespace}`,
  );
}

function jobCondition(namespace: string, type: "Complete" | "Failed"): string {
  try {
    return runOc([
      "get",
      "job",
      "sonarqube-scan",
      "--namespace",
      namespace,
      "-o",
      `jsonpath={.status.conditions[?(@.type=="${type}")].status}`,
    ]);
  } catch {
    return "";
  }
}

function secretExists(namespace: string, name: string): boolean {
  try {
    runOc(["get", "secret", name, "--namespace", namespace, "-o", "name"]);
    return true;
  } catch {
    return false;
  }
}

function readSecretKey(namespace: string, name: string, key: string): string {
  let encoded: string;
  try {
    encoded = runOc([
      "get",
      "secret",
      name,
      "--namespace",
      namespace,
      "-o",
      `jsonpath={.data.${key}}`,
    ]);
  } catch {
    throw new Error(
      `Failed to read key ${key} from secret ${name} in namespace ${namespace}`,
    );
  }
  const value = Buffer.from(encoded, "base64").toString("utf8");
  if (value.length === 0) {
    throw new Error(`Secret ${name} key ${key} is empty`);
  }
  return value;
}

function runOc(args: readonly string[]): string {
  return execFileSync("oc", [...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- Sonar requires the PATH environment key
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runOcOrThrow(args: readonly string[], label: string): string {
  try {
    return runOc(args);
  } catch {
    throw new Error(label);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
