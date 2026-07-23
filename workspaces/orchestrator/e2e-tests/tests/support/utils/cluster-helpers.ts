import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOc } from "./workflow-deployment-helpers.js";

type EnvEntry = { name: string; value: string };

const K8S_NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Minimal in-cluster /get mock so recovery does not depend on public httpbin.org. */
export function ensureE2eHttpbin(ns: string): void {
  if (!K8S_NAMESPACE_RE.test(ns)) {
    throw new Error(`invalid kubernetes namespace for e2e-httpbin: ${ns}`);
  }
  const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: e2e-httpbin
  namespace: ${ns}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: e2e-httpbin
  template:
    metadata:
      labels:
        app: e2e-httpbin
    spec:
      containers:
        - name: httpbin
          image: registry.access.redhat.com/ubi9/python-311@sha256:a0bdb55576fc5b8d6704279307817828ef027e1065533ceba133fe9516003a6c
          command:
            - python3
            - -c
            - |
              from http.server import HTTPServer, BaseHTTPRequestHandler
              class H(BaseHTTPRequestHandler):
                def do_GET(self):
                  b=b'{"args":{},"headers":{},"origin":"e2e","url":"http://e2e-httpbin/get"}'
                  self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
                def log_message(self,*_): pass
              HTTPServer(("0.0.0.0",8080),H).serve_forever()
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /get
              port: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: e2e-httpbin
  namespace: ${ns}
spec:
  selector:
    app: e2e-httpbin
  ports:
    - port: 80
      targetPort: 8080
`;
  const file = join(tmpdir(), `e2e-httpbin-${ns}.yaml`);
  writeFileSync(file, manifest);
  try {
    runOc(["apply", "-f", file], 60_000);
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // best-effort cleanup of temp manifest
    }
  }
  runOc(
    ["-n", ns, "rollout", "status", "deployment/e2e-httpbin", "--timeout=180s"],
    210_000,
  );
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
