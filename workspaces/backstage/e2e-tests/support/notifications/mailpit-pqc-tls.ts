import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MAILPIT_TLS_SECRET_NAME } from "../../tests/config/notifications-email-pqc/fixture";

const COMMAND_TIMEOUT_MS = 30_000;

export interface MailpitTlsMaterial {
  directory: string;
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

/** Self-signed certificate for SMTP STARTTLS. The directory holds the private key. */
export async function generateMailpitTls(
  hostname: string,
): Promise<MailpitTlsMaterial> {
  const directory = await mkdtemp(path.join(tmpdir(), "mailpit-pqc-"));
  const keyPath = path.join(directory, "tls.key");
  const certPath = path.join(directory, "tls.crt");

  try {
    // CN is limited to 64 characters. The namespace DNS name is longer than
    // that, so it goes in the SAN.
    await runCommand("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-subj",
      "/CN=mailpit",
      "-addext",
      `subjectAltName=DNS:${hostname}`,
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return { directory, certPath, keyPath };
}

export async function deleteMailpitTls(
  material: MailpitTlsMaterial,
): Promise<void> {
  await rm(material.directory, { recursive: true, force: true });
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
  await runCommand("kubectl", ["apply", "-f", "-", "-n", namespace], manifest);
}
