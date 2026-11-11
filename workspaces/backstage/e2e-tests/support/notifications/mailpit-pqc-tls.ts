import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  CA_CERT_KEY,
  CONFIG_DIR,
  MAILPIT_TLS_SECRET_NAME,
  OPENSSL_CNF_KEY,
  OPENSSL_CONFIGMAP_NAME,
} from "../../tests/config/notifications-email-pqc/fixture";

const COMMAND_TIMEOUT_MS = 30_000;
const FORCED_GROUP = "X25519MLKEM768";

const HUB_DEPLOYMENT = {
  helm: "redhat-developer-hub",
  operator: "backstage-developer-hub",
} as const;

export interface MailpitTlsMaterial {
  directory: string;
  caCertPath: string;
  certPath: string;
  keyPath: string;
}

/**
 * Runs a command. Stdout is returned to the caller. Stderr is included only
 * when the process fails, and stdout is not, so a dry-run Secret manifest
 * cannot land in the thrown error.
 */
function runCommand(
  file: string,
  args: string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      settle();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => {
        reject(
          new Error(
            `${file} ${args[0]} timed out after ${COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      });
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "ENOENT") {
          reject(new Error(`${file} is not available on PATH`));
          return;
        }
        reject(error);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          const errText = Buffer.concat(stderr).toString("utf8").trim();
          reject(new Error(`${file} ${args[0]} failed (${code}): ${errText}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });

    child.stdin.end(input ?? "");
  });
}

/** CA and server certificate for STARTTLS. The directory holds the private keys. */
export async function generateMailpitTls(
  hostname: string,
): Promise<MailpitTlsMaterial> {
  const directory = await mkdtemp(path.join(tmpdir(), "mailpit-pqc-"));
  const caKeyPath = path.join(directory, "ca.key");
  const caCertPath = path.join(directory, "ca.crt");
  const keyPath = path.join(directory, "tls.key");
  const csrPath = path.join(directory, "server.csr");
  const certPath = path.join(directory, "tls.crt");
  const extPath = path.join(directory, "san.cnf");

  try {
    await writeFile(
      extPath,
      [
        "[ext]",
        `subjectAltName=DNS:${hostname}`,
        "basicConstraints=CA:FALSE",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    await runCommand("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKeyPath,
      "-out",
      caCertPath,
      "-days",
      "2",
      "-subj",
      "/CN=mailpit-e2e-ca",
    ]);
    // CN is limited to 64 characters. The namespace DNS name is longer than
    // that. Node matches the SMTP host against the SAN, which is copied from
    // san.cnf when the CSR is signed.
    await runCommand("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-subj",
      "/CN=mailpit",
    ]);
    await runCommand("openssl", [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caCertPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      certPath,
      "-days",
      "2",
      "-extfile",
      extPath,
      "-extensions",
      "ext",
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return { directory, caCertPath, certPath, keyPath };
}

export async function deleteMailpitTls(
  material: MailpitTlsMaterial,
): Promise<void> {
  await rm(material.directory, { recursive: true, force: true });
}

async function applyManifest(
  namespace: string,
  manifest: string,
): Promise<void> {
  await runCommand("kubectl", ["apply", "-f", "-", "-n", namespace], manifest);
}

/** Mailpit TLS secret. The manifest is not logged. */
export async function applyMailpitTlsSecret(
  namespace: string,
  material: MailpitTlsMaterial,
): Promise<void> {
  const manifest = await runCommand("kubectl", [
    "create",
    "secret",
    "generic",
    MAILPIT_TLS_SECRET_NAME,
    "--namespace",
    namespace,
    "--from-file",
    `tls.crt=${material.certPath}`,
    "--from-file",
    `tls.key=${material.keyPath}`,
    "--dry-run=client",
    "-o",
    "yaml",
  ]);
  await applyManifest(namespace, manifest);
}

/** openssl-pq.cnf from git plus the generated CA certificate. */
export async function applyOpensslConfigMap(
  namespace: string,
  caCertPath: string,
): Promise<void> {
  const cnfPath = WorkspacePaths.resolve(`${CONFIG_DIR}/${OPENSSL_CNF_KEY}`);
  const manifest = await runCommand("kubectl", [
    "create",
    "configmap",
    OPENSSL_CONFIGMAP_NAME,
    "--namespace",
    namespace,
    "--from-file",
    `${OPENSSL_CNF_KEY}=${cnfPath}`,
    "--from-file",
    `${CA_CERT_KEY}=${caCertPath}`,
    "--dry-run=client",
    "-o",
    "yaml",
  ]);
  await applyManifest(namespace, manifest);
}

/**
 * OpenSSL 3.5 already offers ML-KEM by default, so a delivered message does
 * not prove this project's OPENSSL_CONF was applied. Read the backend
 * container and require the mounted config to force that one group.
 */
export async function assertForcedMlKemWiring(
  namespace: string,
  method: keyof typeof HUB_DEPLOYMENT,
): Promise<void> {
  const deployment = HUB_DEPLOYMENT[method];
  const container = await containerWithEnv(
    namespace,
    deployment,
    "OPENSSL_CONF",
  );
  const script = [
    "conf=$(printenv OPENSSL_CONF) || true",
    'if [ -z "$conf" ]; then echo "OPENSSL_CONF is unset" >&2; exit 1; fi',
    'if [ ! -f "$conf" ]; then echo "OPENSSL_CONF file is missing" >&2; exit 1; fi',
    `if ! grep -q '^Groups = ${FORCED_GROUP}$' "$conf"; then echo "forced group is missing" >&2; exit 1; fi`,
    "ca=$(printenv NODE_EXTRA_CA_CERTS) || true",
    'if [ -z "$ca" ]; then echo "NODE_EXTRA_CA_CERTS is unset" >&2; exit 1; fi',
    'if [ ! -f "$ca" ]; then echo "NODE_EXTRA_CA_CERTS file is missing" >&2; exit 1; fi',
  ].join("\n");

  await runCommand("kubectl", [
    "exec",
    "-n",
    namespace,
    `deploy/${deployment}`,
    "-c",
    container,
    "--",
    "sh",
    "-c",
    script,
  ]);
}

async function containerWithEnv(
  namespace: string,
  deployment: string,
  envName: string,
): Promise<string> {
  const manifest = await runCommand("kubectl", [
    "get",
    "deploy",
    deployment,
    "-n",
    namespace,
    "-o",
    "json",
  ]);

  let containers: Array<{ name?: string; env?: Array<{ name?: string }> }>;
  try {
    containers = JSON.parse(manifest).spec.template.spec.containers;
  } catch {
    throw new Error(`could not read containers on deployment ${deployment}`);
  }
  if (!Array.isArray(containers)) {
    throw new Error(`could not read containers on deployment ${deployment}`);
  }

  const match = containers.find((container) =>
    container.env?.some((entry) => entry.name === envName),
  );
  if (!match?.name) {
    throw new Error(`${envName} is not set on deployment ${deployment}`);
  }
  return match.name;
}
