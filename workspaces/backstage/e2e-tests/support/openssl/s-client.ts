import { execFileSync } from "node:child_process";

import { type TlsGroup } from "../../tests/config/openssl-pqc/fixture.js";

export type OpensslSClientResult = {
  raw: string;
  protocol: string | undefined;
  negotiatedGroup: string | undefined;
  peerTempKey: string | undefined;
  verifyReturnCode: string | undefined;
  hasHandshakeError: boolean;
};

/** Hub only — not postgresql, which also carries instance=redhat-developer-hub. */
function rhdhPodLabelSelector(): string {
  return process.env.INSTALLATION_METHOD === "operator"
    ? "rhdh.redhat.com/app=backstage-developer-hub"
    : "app.kubernetes.io/name=developer-hub";
}

export function getRhdhPodName(namespace: string): string {
  const labelSelector = rhdhPodLabelSelector();
  // Use execFileSync (FIPS-style): zx $ does not reliably capture oc jsonpath stdout.
  const podName = execFileSync(
    "oc",
    [
      "get",
      "pod",
      "-n",
      namespace,
      "-l",
      labelSelector,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
    { encoding: "utf-8" },
  ).trim();
  if (!podName) {
    throw new Error(
      `No RHDH pod found in ${namespace} with selector ${labelSelector}`,
    );
  }
  return podName;
}

function firstMatch(raw: string, pattern: RegExp): string | undefined {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const match = pattern.exec(trimmed);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function parseOpensslSClientOutput(raw: string): OpensslSClientResult {
  // Hybrid / PQ-only print "Negotiated TLS1.3 group". Classical often only
  // prints "Peer Temp Key: X25519, …" (OpenSSL 3.5+).
  const protocol = firstMatch(raw, /^Protocol\s*:\s*(.+)$/iu);
  const negotiatedGroup = firstMatch(
    raw,
    /^Negotiated TLS1\.3 group:\s*(.+)$/iu,
  );
  const peerTempKey = firstMatch(raw, /^Peer Temp Key:\s*([^,]+)/iu);
  const verifyReturnCode = firstMatch(raw, /^Verify return code:\s*(.+)$/iu);

  // Ignore "verify error" / "Verification error" from the self-signed peer cert.
  const hasHandshakeError =
    /ssl(v3)?\s+alert/iu.test(raw) ||
    /handshake failure/iu.test(raw) ||
    /no suitable (key share|signature algorithm|shared cipher)/iu.test(raw) ||
    /:error:[0-9A-Fa-f]+:SSL routines:/iu.test(raw);

  return {
    raw,
    protocol,
    negotiatedGroup,
    peerTempKey,
    verifyReturnCode,
    hasHandshakeError,
  };
}

/** Resolve the negotiated key-exchange name across classical and PQ output forms. */
export function resolvedKeyExchangeGroup(
  result: OpensslSClientResult,
): string | undefined {
  return result.negotiatedGroup ?? result.peerTempKey;
}

/**
 * Run openssl s_client inside the RHDH hub container against the httpd edge
 * Route hostname (north-south via the OpenShift router), not Service DNS.
 */
export function runOpensslSClientFromRhdhPod(options: {
  namespace: string;
  host: string;
  group: TlsGroup;
}): OpensslSClientResult {
  const { namespace, host, group } = options;
  const podName = getRhdhPodName(namespace);

  // Self-signed edge/router cert: tolerate non-zero openssl exit (verify code).
  // Assertions use Protocol / Negotiated group / handshake errors.
  const remoteCmd = [
    "echo | openssl s_client",
    `-connect ${host}:443`,
    `-servername ${host}`,
    `-groups ${group}`,
  ].join(" ");

  try {
    const raw = execFileSync(
      "oc",
      ["exec", "-n", namespace, podName, "--", "sh", "-c", remoteCmd],
      {
        encoding: "utf-8",
        // openssl s_client often exits non-zero on self-signed verify.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return parseOpensslSClientOutput(raw);
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return parseOpensslSClientOutput(
      `${err.stdout ?? ""}\n${err.stderr ?? ""}`,
    );
  }
}
