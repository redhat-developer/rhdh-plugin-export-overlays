import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";

const lokiHelpersUrl = new URL(
  "../tests/support/utils/orchestrator-loki-helpers.ts",
  import.meta.url,
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./oc-helpers.js" &&
      context.parentURL === lokiHelpersUrl.href
    ) {
      return nextResolve("./oc-helpers.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { configureOrchestratorLoki, waitForLokiWorkflowLogs } = await import(
  lokiHelpersUrl.href
);

test("uses placeholders only when opted in and keeps Loki log checks strict", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-loki-"));
  const markerPath = join(tempDir, "install-called");
  const originalEnv = new Map(
    [
      "AUTH_TOKEN",
      "LOKI_BASE_URL",
      "LOKI_ALLOW_PLACEHOLDER",
      "PATH",
      "LOKI_INSTALL_MARKER",
    ].map((name) => [name, process.env[name]]),
  );
  await writeFile(join(tempDir, "oc"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  await writeFile(
    join(tempDir, "bash"),
    '#!/bin/sh\nprintf invoked > "$LOKI_INSTALL_MARKER"\nexit 0\n',
    { mode: 0o755 },
  );

  try {
    process.env.PATH = tempDir;
    delete process.env.AUTH_TOKEN;
    delete process.env.LOKI_BASE_URL;
    delete process.env.LOKI_ALLOW_PLACEHOLDER;
    process.env.LOKI_INSTALL_MARKER = markerPath;

    await assert.rejects(
      configureOrchestratorLoki(),
      /Could not obtain OpenShift token/,
    );

    process.env.LOKI_ALLOW_PLACEHOLDER = "true";
    await configureOrchestratorLoki();

    assert.equal(process.env.AUTH_TOKEN, "e2e-ci-placeholder");
    assert.equal(process.env.LOKI_BASE_URL, "http://localhost:3100");
    assert.equal(existsSync(markerPath), false);
    await assert.rejects(
      waitForLokiWorkflowLogs("test-instance", 0),
      /Could not obtain OpenShift token/,
    );
  } finally {
    for (const [name, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
