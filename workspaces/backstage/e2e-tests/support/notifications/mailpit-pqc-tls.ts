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

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`${file} is not available on PATH`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const errText = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`${file} ${args[0]} failed (${code}): ${errText}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
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
  // that. Node matches the SMTP host against the SAN, not the CN.
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
    "-addext",
    `subjectAltName=DNS:${hostname}`,
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
