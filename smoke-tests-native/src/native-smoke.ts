/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Native (Docker-free) smoke harness for RHDH dynamic backend plugins.
 *
 * Validates dynamic plugins IN-PROCESS with the published
 * `@red-hat-developer-hub/cli-module-install-dynamic-plugins` CLI +
 * `startTestBackend` (@backstage/backend-test-utils) — no Docker container, no cluster.
 * Replaces the per-workspace `docker run rhdh` smoke-test for backend plugins (~20x faster).
 *
 * Flow (mirrors RHDH PR #4967's plugin-dynamic-loading.spec.ts):
 *   1. Run the install CLI to extract OCI plugins into a temp dynamic-plugins-root.
 *   2. Load each backend plugin and assert a default BackendFeature export.
 *   3. Boot startTestBackend with core features + loaded features → confirms they integrate.
 *   4. Check frontend plugin bundles exist (scalprum/remoteEntry presence — not executed).
 *   5. Emit results.json with per-plugin status; exit non-zero on any failure.
 *
 * What this CANNOT do (by design): render frontend UI. UI behaviour tests need a real
 * frontend (NFS / app-next) — see RHIDP-15082. That is the deliberate scope boundary.
 *
 * Usage:
 *   yarn smoke --dynamic-plugins <dynamic-plugins.yaml> [--out results.json]
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { startTestBackend, mockServices } from "@backstage/backend-test-utils";
import scaffolderPlugin from "@backstage/plugin-scaffolder-backend";
import {
  discoverPlugins,
  loadBackendPlugins,
  validateFrontendBundle,
  type PluginEntry,
  type LoadedPlugin,
  type PluginError,
} from "./loader";
import { patchModuleResolution } from "./module-resolution";
import { buildMergedConfig, KNOWN_FAILURES } from "./plugin-config";

// This harness's own node_modules — extracted plugins resolve @backstage/* against it.
const HARNESS_NODE_MODULES = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "node_modules",
);

const CLI = "@red-hat-developer-hub/cli-module-install-dynamic-plugins";

// Resolve the CLI's bin to an absolute path and invoke it with the absolute Node
// binary (process.execPath), so the executable is never looked up via PATH (Sonar
// S4036). require.resolve(CLI) returns the package main (dist/index.cjs.js); its
// package root is two levels up, where the pinned 0.3.0 bin lives.
const require = createRequire(import.meta.url);
const CLI_BIN = join(
  dirname(dirname(require.resolve(CLI))),
  "bin/install-dynamic-plugins",
);

// Bundled core plugins so dynamic plugins/modules can attach to their extension points.
// catalogPlugin is intentionally NOT here: @backstage/plugin-catalog-backend does not boot
// cleanly in this minimal standalone harness yet (needs more service wiring than RHDH's
// full e2e env provides), so the dep is left out until that gap is closed (Path A / the
// catalog follow-up). Scaffolder + scaffolder/other modules boot fine today.
const coreFeatures = [scaffolderPlugin];

type Status = "pass" | "fail-load" | "fail-start" | "fail-bundle" | "error";
type Report = {
  cliVersion: string;
  backend: {
    total: number;
    loaded: number;
    skipped: string[];
    errors: PluginError[];
  };
  backendStart: { ok: boolean; skipped?: boolean; error?: string };
  frontend: { total: number; valid: number; errors: PluginError[] };
  status: Status;
};

// execFileSync (args array, no shell) so workspace names / OCI refs can never be
// interpolated into a shell command as this grows beyond a single fixed plugin.
function run(file: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(file, args, {
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, ...env },
  }).trim();
}

function computeStatus(
  loadErrors: PluginError[],
  startOk: boolean,
  loadedCount: number,
  frontendErrors: PluginError[],
): Status {
  if (loadErrors.length > 0) return "fail-load";
  if (!startOk && loadedCount > 0) return "fail-start";
  if (frontendErrors.length > 0) return "fail-bundle";
  return "pass";
}

// Copy the dynamic-plugins.yaml the CLI consumes, then extract (the part PR #2231
// hand-rolled in 694 lines — now one CLI call).
async function extractPlugins(root: string, dynamicPlugins: string): Promise<void> {
  await copyFile(dynamicPlugins, join(root, "dynamic-plugins.yaml"));
  console.log("▶ extracting plugins via CLI…");
  // The CLI reads dynamic-plugins.yaml from its CWD, so run it inside `root`
  // (where we just wrote the config) and extract into the same dir.
  execFileSync(process.execPath, [CLI_BIN, "install", root], {
    stdio: "inherit",
    cwd: root,
  });
}

// Boot the loaded backend features in-process to confirm they integrate.
async function startBackend(
  loaded: LoadedPlugin[],
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  // No backend plugins (e.g. a frontend-only workspace) — boot wasn't attempted, not a
  // failure. Flag it so results.json doesn't read like the backend crashed.
  if (loaded.length === 0) return { ok: true, skipped: true };
  try {
    // Inject a root config (dummy values for plugins that validate config at boot).
    const config = buildMergedConfig(loaded);
    const backend = await startTestBackend({
      features: [
        ...coreFeatures,
        ...loaded.map((p) => p.feature),
        mockServices.rootConfig.factory({ data: config }),
      ],
    });
    await backend.stop();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Check frontend bundles are present (presence check only — the bundle is not executed).
function validateFrontends(frontend: PluginEntry[]): {
  valid: number;
  errors: PluginError[];
} {
  const errors: PluginError[] = [];
  let valid = 0;
  for (const plugin of frontend) {
    const error = validateFrontendBundle(plugin);
    if (error) errors.push({ plugin, error });
    else valid += 1;
  }
  return { valid, errors };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dynamic-plugins": { type: "string" },
      out: { type: "string" },
    },
  });

  const out = values.out ?? "results.json";
  const dynamicPlugins = values["dynamic-plugins"];

  if (!dynamicPlugins) {
    console.error("Provide --dynamic-plugins <dynamic-plugins.yaml>.");
    return 2;
  }
  if (!existsSync(dynamicPlugins)) {
    console.error(`dynamic-plugins file not found: ${dynamicPlugins}`);
    return 2;
  }

  // Declared outside the try so the catch/finally can see them even if setup fails.
  let cliVersion = "unknown";
  let tempDir: string | undefined;

  try {
    // Everything fallible lives in the try, so any failure still writes a results.json
    // (status: error) instead of exiting with no report.
    cliVersion = run(process.execPath, [CLI_BIN, "--version"]);
    console.log(`▶ install CLI: ${CLI}@${cliVersion}`);

    tempDir = await mkdtemp(join(tmpdir(), "native-smoke-"));
    const root = join(tempDir, "dynamic-plugins-root");
    await mkdir(root, { recursive: true });

    await extractPlugins(root, dynamicPlugins);

    const manifest = discoverPlugins(root);
    console.log(
      `▶ manifest: ${manifest.backend.length} backend, ${manifest.frontend.length} frontend`,
    );

    // Let extracted plugins (under a temp dir) resolve their @backstage/* peers here.
    patchModuleResolution(HARNESS_NODE_MODULES);

    const skipped = manifest.backend
      .filter((p) => KNOWN_FAILURES.has(p.dirName))
      .map((p) => p.dirName);
    if (skipped.length > 0) {
      console.warn(
        `⚠ skipped ${skipped.length} known-failure backend plugin(s): ${skipped.join(", ")}`,
      );
    }

    const backendPlugins = manifest.backend.filter(
      (p) => !KNOWN_FAILURES.has(p.dirName),
    );
    const { loaded, errors: loadErrors } = loadBackendPlugins(backendPlugins);
    const start = await startBackend(loaded);
    const frontend = validateFrontends(manifest.frontend);

    // A workspace whose only backend plugin is a known failure would otherwise pass
    // silently having validated nothing — make that visible.
    if (loaded.length === 0 && manifest.frontend.length === 0) {
      console.warn(
        `⚠ nothing validated: 0 plugins loaded ` +
          `(${manifest.backend.length} backend found, ${skipped.length} skipped)`,
      );
    }

    const report: Report = {
      cliVersion,
      backend: {
        total: manifest.backend.length,
        loaded: loaded.length,
        skipped,
        errors: loadErrors,
      },
      backendStart: start,
      frontend: {
        total: manifest.frontend.length,
        valid: frontend.valid,
        errors: frontend.errors,
      },
      status: computeStatus(loadErrors, start.ok, loaded.length, frontend.errors),
    };

    await writeFile(out, JSON.stringify(report, null, 2));
    const startLabel = start.skipped
      ? "skipped (no backend plugins — frontend bundle presence only)"
      : String(start.ok);
    console.log(`▶ report → ${out} (status: ${report.status})`);
    console.log(
      `  backend loaded ${report.backend.loaded}/${report.backend.total}` +
        (skipped.length ? ` (${skipped.length} skipped)` : "") +
        `, start=${startLabel}, frontend ${frontend.valid}/${manifest.frontend.length}`,
    );
    return report.status === "pass" ? 0 : 1;
  } catch (err) {
    // Any failure before the report is built (e.g. the install CLI failing on a bad
    // OCI ref) still writes a results.json, so a consumer never reads a stale "pass".
    const message = err instanceof Error ? err.message : String(err);
    const report: Report = {
      cliVersion,
      backend: { total: 0, loaded: 0, skipped: [], errors: [] },
      backendStart: { ok: false, error: message },
      frontend: { total: 0, valid: 0, errors: [] },
      status: "error",
    };
    await writeFile(out, JSON.stringify(report, null, 2));
    console.error(`▶ report → ${out} (status: error)\n${message}`);
    return 1;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err);
  process.exit(1);
}
