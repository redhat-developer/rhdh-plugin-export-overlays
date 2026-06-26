#!/usr/bin/env node
/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Native (Docker-free) smoke harness — POC for RHIDP-15075 / RHIDP-15076.
 *
 * Goal: prove that the published `@red-hat-developer-hub/cli-module-install-dynamic-plugins`
 * CLI + `startTestBackend` (@backstage/backend-test-utils) can validate dynamic plugins
 * IN-PROCESS, with no Docker container and no cluster — replacing both:
 *   - the 32 Docker-based `docker run rhdh` smoke-tests, and
 *   - the 694-line bespoke harness from the closed POC PR #2231 (which predated the npm CLI).
 *
 * Flow (mirrors RHDH PR #4967's plugin-dynamic-loading.spec.ts):
 *   1. Run the install CLI to extract OCI plugins into a temp dynamic-plugins-root.
 *   2. Load each backend plugin and assert a default BackendFeature export.
 *   3. Boot startTestBackend with core features + loaded features → confirms they integrate.
 *   4. Validate frontend plugin bundles (scalprum/remoteEntry) — load-only, no render.
 *   5. Emit results.json with per-plugin status; exit non-zero on any failure.
 *
 * What this CANNOT do (by design): render frontend UI. UI behaviour tests need a real
 * frontend (NFS / app-next) — see RHIDP-15082. That is the deliberate scope boundary.
 *
 * Usage:
 *   yarn smoke --dynamic-plugins <dynamic-plugins.yaml> [--out results.json]
 *   # or, to extract a whole catalog index instead of explicit OCI refs:
 *   CATALOG_INDEX_IMAGE=<image> yarn smoke:catalog-index
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { startTestBackend, mockServices } from "@backstage/backend-test-utils";
import catalogPlugin from "@backstage/plugin-catalog-backend";
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
// NOTE: catalogPlugin does not boot cleanly in this minimal standalone harness yet
// (needs more service wiring than RHDH's full e2e env provides), so it is omitted for
// now. Scaffolder + scaffolder/other modules boot fine. Wiring the catalog so
// catalog-extending modules (e.g. entity providers) can boot is tracked as follow-up.
void catalogPlugin;
const coreFeatures = [scaffolderPlugin];

type Status = "pass" | "fail-load" | "fail-start" | "fail-bundle" | "error";
type Report = {
  cliVersion: string;
  backend: { total: number; loaded: number; errors: PluginError[] };
  backendStart: { ok: boolean; error?: string };
  frontend: { total: number; valid: number; errors: PluginError[] };
  status: Status;
};

// execFileSync (args array, no shell) so workspace names / OCI refs can never be
// interpolated into a shell command as this grows beyond the POC.
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

// Write the dynamic-plugins.yaml the CLI consumes, then extract (the part PR #2231
// hand-rolled in 694 lines — now one CLI call).
async function extractPlugins(
  root: string,
  useCatalogIndex: boolean,
  dynamicPlugins: string | undefined,
  catalogIndexImage: string | undefined,
): Promise<void> {
  if (useCatalogIndex) {
    // Empty list => CLI extracts everything from CATALOG_INDEX_IMAGE.
    await writeFile(join(root, "dynamic-plugins.yaml"), "plugins: []\n");
  } else if (dynamicPlugins) {
    await copyFile(dynamicPlugins, join(root, "dynamic-plugins.yaml"));
  }
  console.log("▶ extracting plugins via CLI…");
  // The CLI reads dynamic-plugins.yaml from its CWD, so run it inside `root`
  // (where we just wrote the config) and extract into the same dir.
  execFileSync(process.execPath, [CLI_BIN, "install", root], {
    stdio: "inherit",
    cwd: root,
    env: catalogIndexImage
      ? { ...process.env, CATALOG_INDEX_IMAGE: catalogIndexImage }
      : process.env,
  });
}

// Boot the loaded backend features in-process to confirm they integrate.
async function startBackend(
  loaded: LoadedPlugin[],
): Promise<{ ok: boolean; error?: string }> {
  if (loaded.length === 0) return { ok: false };
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

// Validate frontend bundles (load-only; no render).
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
      "catalog-index": { type: "boolean", default: false },
      out: { type: "string", default: "results.json" },
    },
  });

  const out = values.out ?? "results.json";
  const dynamicPlugins = values["dynamic-plugins"];
  const useCatalogIndex = values["catalog-index"] ?? false;
  const catalogIndexImage = process.env.CATALOG_INDEX_IMAGE;

  if (!useCatalogIndex && !dynamicPlugins) {
    console.error(
      "Provide --dynamic-plugins <yaml> OR --catalog-index with CATALOG_INDEX_IMAGE set.",
    );
    return 2;
  }

  const cliVersion = run(process.execPath, [CLI_BIN, "--version"]);
  console.log(`▶ install CLI: ${CLI}@${cliVersion}`);

  const tempDir = await mkdtemp(join(tmpdir(), "native-smoke-"));
  const root = join(tempDir, "dynamic-plugins-root");
  await mkdir(root, { recursive: true });

  try {
    await extractPlugins(root, useCatalogIndex, dynamicPlugins, catalogIndexImage);

    const manifest = discoverPlugins(root);
    console.log(
      `▶ manifest: ${manifest.backend.length} backend, ${manifest.frontend.length} frontend`,
    );

    // Let extracted plugins (under a temp dir) resolve their @backstage/* peers here.
    patchModuleResolution(HARNESS_NODE_MODULES);
    const backendPlugins = manifest.backend.filter(
      (p) => !KNOWN_FAILURES.has(p.dirName),
    );
    const { loaded, errors: loadErrors } = loadBackendPlugins(backendPlugins);
    const start = await startBackend(loaded);
    const frontend = validateFrontends(manifest.frontend);

    const report: Report = {
      cliVersion,
      backend: {
        total: manifest.backend.length,
        loaded: loaded.length,
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
    console.log(`▶ report → ${out} (status: ${report.status})`);
    console.log(
      `  backend loaded ${report.backend.loaded}/${report.backend.total}, ` +
        `start=${start.ok}, frontend ${frontend.valid}/${manifest.frontend.length}`,
    );
    return report.status === "pass" ? 0 : 1;
  } catch (err) {
    // Any failure before the report is built (e.g. the install CLI failing on a bad
    // OCI ref) still writes a results.json, so a consumer never reads a stale "pass".
    const message = err instanceof Error ? err.message : String(err);
    const report: Report = {
      cliVersion,
      backend: { total: 0, loaded: 0, errors: [] },
      backendStart: { ok: false, error: message },
      frontend: { total: 0, valid: 0, errors: [] },
      status: "error",
    };
    await writeFile(out, JSON.stringify(report, null, 2));
    console.error(`▶ report → ${out} (status: error)\n${message}`);
    return 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err);
  process.exit(1);
}
