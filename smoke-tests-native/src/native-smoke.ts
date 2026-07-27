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
 *   4. Check frontend plugin bundles exist for the legacy (Scalprum) and/or new
 *      (module federation) frontend system — presence only, never executed.
 *   5. Emit results.json with per-plugin status; exit non-zero on any failure.
 *
 * What this CANNOT do (by design): render frontend UI. UI behaviour tests need a real
 * frontend (NFS / app-next) — see RHIDP-15082. That is the deliberate scope boundary.
 *
 * Usage:
 *   yarn smoke --dynamic-plugins <dynamic-plugins.yaml> [--out results.json]
 *   yarn smoke --workspace <name>                       [--out results.json]
 *   ... either form also takes [--app-config <app-config.test.yaml>] [--test-env <test.env>]
 *
 * Workspace mode resolves ALL of `workspaces/<name>/metadata/*.yaml`'s oci://
 * dynamicArtifact refs and validates them together (the Docker smoke's unit).
 *
 * --app-config / --test-env mirror what the Docker smoke passes to the container
 * (an extra --config mount and docker run --env-file) — see src/test-config.ts.
 * (The flag is --test-env, not --env-file: Node claims --env-file for itself even
 * when it appears after the script path, exiting 9 if the file is missing.)
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { startTestBackend, mockServices } from "@backstage/backend-test-utils";
import scaffolderPlugin from "@backstage/plugin-scaffolder-backend";
import type { JsonObject } from "@backstage/types";
import {
  discoverPlugins,
  loadBackendPlugins,
  validateFrontendBundle,
  type FrontendSystem,
  type PluginEntry,
  type LoadedPlugin,
  type PluginError,
} from "./loader";
import { patchModuleResolution } from "./module-resolution";
import { buildMergedConfig, KNOWN_FAILURES } from "./plugin-config";
import { loadAppConfig, loadEnvFile } from "./test-config";
import {
  collectWorkspaceRefs,
  discoverSmokeTestConfig,
  isValidWorkspaceName,
  writeDynamicPluginsConfig,
} from "./workspace";

const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// This harness's own node_modules — extracted plugins resolve @backstage/* against it.
const HARNESS_NODE_MODULES = join(HARNESS_ROOT, "node_modules");
// The harness lives at <repo>/smoke-tests-native, so workspaces/ sits one level up.
const REPO_ROOT = dirname(HARNESS_ROOT);

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
type BackendStartResult = { ok: boolean; skipped?: boolean; error?: string };
// Which frontend system(s) each bundle ships — the signal for tracking migration to
// the new frontend system across the catalog.
type FrontendBundleInfo = { name: string; version: string; systems: FrontendSystem[] };
// Bump when the results.json shape changes — downstream tooling (e.g. the parity
// runs comparing native vs Docker verdicts) parses this file.
const REPORT_SCHEMA_VERSION = 1;

// Workspace-mode provenance: which metadata files were skipped (non-oci artifacts),
// so a "pass" can't silently hide that part of the workspace was never validated.
type WorkspaceInfo = { name: string; refCount: number; skippedMetadata: string[] };
type Report = {
  schemaVersion: number;
  cliVersion: string;
  workspace?: WorkspaceInfo;
  backend: {
    total: number;
    loaded: number;
    skipped: string[];
    errors: PluginError[];
  };
  backendStart: BackendStartResult;
  frontend: {
    total: number;
    valid: number;
    errors: PluginError[];
    bundles: FrontendBundleInfo[];
  };
  status: Status;
};

// execFileSync (args array, no shell) so workspace names / OCI refs can never be
// interpolated into a shell command as this grows beyond a single fixed plugin.
function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf-8", stdio: "pipe" }).trim();
}

// --out comes from the CLI; constrain it to the working directory so a faulty
// argument can never write outside it (Sonar S8707). Returns the resolved absolute
// path, or null when the argument escapes the working directory.
function resolveOutPath(outArg: string): string | null {
  const resolved = resolve(outArg);
  return resolved.startsWith(process.cwd() + sep) ? resolved : null;
}

// Resolve the effective test-config: workspace mode auto-discovers the workspace's
// Docker-smoke files (smoke-tests/app-config.test.yaml + test.env), explicit flags
// win. Env vars load first — the app-config layer's ${VAR} substitution reads
// process.env. Returns the parsed app-config layer, if any.
function resolveTestConfig(
  inputs: CliInputs,
  source: SmokeSource,
): JsonObject | undefined {
  if (source.kind === "workspace") {
    const discovered = discoverSmokeTestConfig(REPO_ROOT, source.name);
    inputs.appConfig ??= discovered.appConfig;
    inputs.envFile ??= discovered.testEnv;
  }
  if (inputs.envFile) {
    const applied = loadEnvFile(inputs.envFile);
    console.log(`▶ test-env: ${inputs.envFile} (${applied.length} var(s) applied)`);
  }
  if (inputs.appConfig) console.log(`▶ app-config: ${inputs.appConfig}`);
  return inputs.appConfig ? loadAppConfig(inputs.appConfig) : undefined;
}

// Workspace mode: resolve every published plugin of the workspace into a generated
// dynamic-plugins.yaml the install CLI can consume, keeping the skip provenance
// for results.json.
async function materializeWorkspaceConfig(
  workspace: string,
  destDir: string,
): Promise<{ path: string; info: WorkspaceInfo }> {
  const { refs, skipped } = collectWorkspaceRefs(REPO_ROOT, workspace);
  console.log(`▶ workspace '${workspace}': ${refs.length} oci plugin ref(s)`);
  const path = await writeDynamicPluginsConfig(refs, destDir);
  return {
    path,
    info: { name: workspace, refCount: refs.length, skippedMetadata: skipped },
  };
}

// Partition backend entries into known-failure skips and loadable plugins in one
// pass, so the two lists stay complementary.
function partitionKnownFailures(entries: PluginEntry[]): {
  skipped: string[];
  backendPlugins: PluginEntry[];
} {
  const skipped: string[] = [];
  const backendPlugins: PluginEntry[] = [];
  for (const entry of entries) {
    if (KNOWN_FAILURES.has(entry.dirName)) skipped.push(entry.dirName);
    else backendPlugins.push(entry);
  }
  return { skipped, backendPlugins };
}

// Any failure — bad args, install CLI crash, boot error before the report is built —
// still produces a results.json (status: error), so a consumer never reads a stale
// "pass" or finds no report at all.
async function writeErrorReport(
  out: string,
  cliVersion: string,
  message: string,
): Promise<void> {
  const report: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    cliVersion,
    backend: { total: 0, loaded: 0, skipped: [], errors: [] },
    backendStart: { ok: false, error: message },
    frontend: { total: 0, valid: 0, errors: [], bundles: [] },
    status: "error",
  };
  await writeFile(out, JSON.stringify(report, null, 2));
  console.error(`▶ report → ${out} (status: error)\n${message}`);
}

type SmokeSource =
  | { kind: "file"; path: string }
  | { kind: "workspace"; name: string };

type CliInputs = {
  out: string | null;
  source?: SmokeSource;
  appConfig?: string;
  envFile?: string;
  usageError?: string;
};

// Validate the CLI arguments up front: a sane --out, exactly one plugin source
// (--dynamic-plugins <file> XOR --workspace <name>), and the optional
// --app-config/--test-env test-config inputs (see test-config.ts).
function parseCliInputs(): CliInputs {
  const { values } = parseArgs({
    options: {
      "dynamic-plugins": { type: "string" },
      workspace: { type: "string" },
      "app-config": { type: "string" },
      "test-env": { type: "string" },
      out: { type: "string" },
    },
  });

  const outArg = values.out ?? "results.json";
  const out = resolveOutPath(outArg);
  if (!out) {
    return { out: null, usageError: `--out must resolve inside the working directory: ${outArg}` };
  }

  const optionalFiles: Array<[flag: string, file: string | undefined]> = [
    ["--app-config", values["app-config"]],
    ["--test-env", values["test-env"]],
  ];
  for (const [flag, file] of optionalFiles) {
    if (file && !existsSync(file)) {
      return { out, usageError: `${flag} file not found: ${file}` };
    }
  }
  const common = {
    out,
    appConfig: values["app-config"],
    envFile: values["test-env"],
  };

  const file = values["dynamic-plugins"];
  const workspace = values.workspace;
  if (file && workspace) {
    return { out, usageError: "Provide only one of --dynamic-plugins or --workspace." };
  }
  if (workspace) {
    // Validated here, before ANY filesystem consumer (auto-discovery runs early).
    if (!isValidWorkspaceName(workspace)) {
      return { out, usageError: `invalid workspace name: '${workspace}'` };
    }
    return { ...common, source: { kind: "workspace", name: workspace } };
  }
  if (!file) {
    return { out, usageError: "Provide --dynamic-plugins <dynamic-plugins.yaml> or --workspace <name>." };
  }
  if (!existsSync(file)) {
    return { out, usageError: `dynamic-plugins file not found: ${file}` };
  }
  return { ...common, source: { kind: "file", path: file } };
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
  appConfig?: JsonObject,
): Promise<BackendStartResult> {
  // No backend plugins (e.g. a frontend-only workspace) — boot wasn't attempted, not a
  // failure. Flag it so results.json doesn't read like the backend crashed.
  if (loaded.length === 0) return { ok: true, skipped: true };
  try {
    // Inject a root config (dummy values for plugins that validate config at boot,
    // overridden by the caller's --app-config layer when provided).
    const config = buildMergedConfig(loaded, appConfig);
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

// Check frontend bundles are present (presence check only — the bundle is not
// executed), recording which frontend system(s) each one ships.
function validateFrontends(frontend: PluginEntry[]): {
  valid: number;
  errors: PluginError[];
  bundles: FrontendBundleInfo[];
} {
  const errors: PluginError[] = [];
  const bundles: FrontendBundleInfo[] = [];
  let valid = 0;
  for (const plugin of frontend) {
    const { systems, error } = validateFrontendBundle(plugin);
    bundles.push({ name: plugin.name, version: plugin.version, systems });
    if (error) errors.push({ plugin, error });
    else {
      valid += 1;
      console.log(`  frontend '${plugin.name}': ${systems.join(" + ")}`);
    }
  }
  return { valid, errors, bundles };
}

async function main(): Promise<number> {
  const inputs = parseCliInputs();
  if (!inputs.out) {
    // No safe report path to write to — console is all we have.
    console.error(inputs.usageError);
    return 2;
  }
  const { out, source } = inputs;
  if (inputs.usageError || !source) {
    await writeErrorReport(out, "unknown", inputs.usageError ?? "invalid arguments");
    return 2;
  }

  // Declared outside the try so the catch/finally can see them even if setup fails.
  let cliVersion = "unknown";
  let tempDir: string | undefined;

  try {
    // Everything fallible lives in the try, so any failure still writes a results.json
    // (status: error) instead of exiting with no report.
    const appConfig = resolveTestConfig(inputs, source);

    cliVersion = run(process.execPath, [CLI_BIN, "--version"]);
    console.log(`▶ install CLI: ${CLI}@${cliVersion}`);

    tempDir = await mkdtemp(join(tmpdir(), "native-smoke-"));
    const root = join(tempDir, "dynamic-plugins-root");
    await mkdir(root, { recursive: true });

    const materialized =
      source.kind === "workspace"
        ? await materializeWorkspaceConfig(source.name, tempDir)
        : { path: source.path, info: undefined };
    await extractPlugins(root, materialized.path);

    const manifest = discoverPlugins(root);
    console.log(
      `▶ manifest: ${manifest.backend.length} backend, ${manifest.frontend.length} frontend`,
    );

    // Let extracted plugins (under a temp dir) resolve their @backstage/* peers here.
    patchModuleResolution(HARNESS_NODE_MODULES);

    const { skipped, backendPlugins } = partitionKnownFailures(manifest.backend);
    if (skipped.length > 0) {
      console.warn(
        `⚠ skipped ${skipped.length} known-failure backend plugin(s): ${skipped.join(", ")}`,
      );
    }
    const { loaded, errors: loadErrors } = loadBackendPlugins(backendPlugins);
    const start = await startBackend(loaded, appConfig);
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
      schemaVersion: REPORT_SCHEMA_VERSION,
      cliVersion,
      // undefined outside workspace mode — JSON.stringify omits it.
      workspace: materialized.info,
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
        bundles: frontend.bundles,
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
    // e.g. the install CLI failing on a bad OCI ref — see writeErrorReport.
    await writeErrorReport(out, cliVersion, err instanceof Error ? err.message : String(err));
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
