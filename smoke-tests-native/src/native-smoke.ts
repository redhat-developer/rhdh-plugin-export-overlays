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
 *   yarn smoke --workspace <name> [--support community] [--out results.json]
 *   ... either form also takes [--app-config <app-config.test.yaml>] [--test-env <test.env>]
 *                             [--exclusions <plugin-sweep-excludes.txt>]
 *
 * Workspace mode resolves ALL of `workspaces/<name>/metadata/*.yaml`'s oci://
 * dynamicArtifact refs and validates them together (the Docker smoke's unit).
 * `--support <level>` narrows that to one `spec.support` tier — how the community
 * sweep (src/sweep.ts, RHIDP-13510) drives this harness one workspace at a time.
 *
 * --app-config / --test-env mirror what the Docker smoke passes to the container
 * (an extra --config mount and docker run --env-file) — see src/test-config.ts.
 * (The flag is --test-env, not --env-file: Node claims --env-file for itself even
 * when it appears after the script path, exiting 9 if the file is missing.)
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
import searchPlugin from "@backstage/plugin-search-backend";
import type { JsonObject } from "@backstage/types";
import {
  discoverPlugins,
  loadBackendPlugins,
  validateFrontendBundle,
  type PluginEntry,
  type LoadedPlugin,
  type PluginError,
} from "./loader";
import { patchModuleResolution } from "./module-resolution";
import { resolveContained } from "./paths";
import { errorMessage } from "./util";
import { buildMergedConfig, KNOWN_FAILURES } from "./plugin-config";
import { loadAppConfig, loadEnvFile } from "./test-config";
import {
  excluderFor,
  loadExclusions,
  type Exclusion,
  type ExclusionRecord,
} from "./exclusions";
import {
  REPORT_SCHEMA_VERSION,
  type BackendStartResult,
  type FrontendBundleInfo,
  type Report,
  type Status,
  type WorkspaceInfo,
} from "./report";
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
// searchPlugin was added for the community sweep (RHIDP-13510): without it, every
// search-backend module fails to even LOAD — its bare
// `@backstage/plugin-search-backend-node/alpha` import has nothing to resolve against —
// so a whole class of community backend modules reported a load error that said nothing
// about the plugin.
// catalogPlugin is intentionally NOT here: @backstage/plugin-catalog-backend does not boot
// cleanly in this minimal standalone harness yet (needs more service wiring than RHDH's
// full e2e env provides), so the dep is left out until RHIDP-16017 closes that gap.
// Catalog-extending modules are boot-excluded in plugin-sweep-excludes.txt meanwhile.
const coreFeatures = [scaffolderPlugin, searchPlugin];

// execFileSync (args array, no shell) so workspace names / OCI refs can never be
// interpolated into a shell command as this grows beyond a single fixed plugin.
function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf-8", stdio: "pipe" }).trim();
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
    console.log(
      `▶ test-env: ${inputs.envFile} (${applied.length} var(s) applied)`,
    );
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
  support: string | undefined,
  exclusions: Exclusion[],
): Promise<{ path: string; info: WorkspaceInfo; excluded: ExclusionRecord[] }> {
  const { refs, skipped, excluded, outOfScope } = collectWorkspaceRefs(
    REPO_ROOT,
    workspace,
    { support, installExcluded: excluderFor(exclusions, "install") },
  );
  console.log(
    `▶ workspace '${workspace}': ${refs.length} oci plugin ref(s)` +
      (support ? ` at support '${support}' (${outOfScope} out of scope)` : ""),
  );
  const path = await writeDynamicPluginsConfig(refs, destDir);
  return {
    path,
    info: {
      name: workspace,
      refCount: refs.length,
      skippedMetadata: skipped,
      support,
      outOfScope: support ? outOfScope : undefined,
    },
    excluded,
  };
}

// Partition backend entries into skips and loadable plugins in one pass, so the two
// lists stay complementary. Two sources of skip, both meaning "installed and its
// artifact validated, but never loaded into startTestBackend":
//   - KNOWN_FAILURES, the dirName list ported from RHDH PR #4967;
//   - boot-scope entries in the exclusions file, matched on npm package name, each
//     carrying a tracking ticket (see src/exclusions.ts).
function partitionUnbootable(
  entries: PluginEntry[],
  exclusions: Exclusion[],
): {
  skipped: string[];
  excluded: ExclusionRecord[];
  backendPlugins: PluginEntry[];
} {
  const bootExcluded = excluderFor(exclusions, "boot");
  const skipped: string[] = [];
  const excluded: ExclusionRecord[] = [];
  const backendPlugins: PluginEntry[] = [];
  for (const entry of entries) {
    const exclusion = bootExcluded(entry.name);
    if (exclusion) excluded.push(exclusion);
    if (exclusion || KNOWN_FAILURES.has(entry.dirName))
      skipped.push(entry.dirName);
    else backendPlugins.push(entry);
  }
  return { skipped, excluded, backendPlugins };
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
    exclusions: [],
    status: "error",
  };
  await writeFile(out, JSON.stringify(report, null, 2));
  console.error(`▶ report → ${out} (status: error)\n${message}`);
}

type SmokeSource =
  { kind: "file"; path: string } | { kind: "workspace"; name: string };

type CliInputs = {
  out: string | null;
  source?: SmokeSource;
  appConfig?: string;
  envFile?: string;
  support?: string;
  exclusions: Exclusion[];
  usageError?: string;
};

// Validate the CLI arguments up front: a sane --out, exactly one plugin source
// (--dynamic-plugins <file> XOR --workspace <name>), the optional
// --app-config/--test-env test-config inputs (see test-config.ts), and the sweep's
// --support / --exclusions filters.
function parseCliInputs(): CliInputs {
  const { values } = parseArgs({
    options: {
      "dynamic-plugins": { type: "string" },
      workspace: { type: "string" },
      support: { type: "string" },
      exclusions: { type: "string" },
      "app-config": { type: "string" },
      "test-env": { type: "string" },
      out: { type: "string" },
    },
  });

  const outArg = values.out ?? "results.json";
  // Contain --out to the working directory (Sonar S8707); sweep.ts and
  // aggregate.ts enforce the same rule via the same helper.
  const out = resolveContained(outArg);
  if (!out) {
    return {
      out: null,
      exclusions: [],
      usageError: `--out must resolve inside the working directory: ${outArg}`,
    };
  }

  const optionalFiles: Array<[flag: string, file: string | undefined]> = [
    ["--app-config", values["app-config"]],
    ["--test-env", values["test-env"]],
    ["--exclusions", values.exclusions],
  ];
  for (const [flag, file] of optionalFiles) {
    if (file && !existsSync(file)) {
      return {
        out,
        exclusions: [],
        usageError: `${flag} file not found: ${file}`,
      };
    }
  }

  // Parsed here so a malformed exclusions file — a pattern with no ticket, above all —
  // fails before anything is pulled, with the same message wherever it is loaded from.
  let exclusions: Exclusion[] = [];
  if (values.exclusions) {
    try {
      exclusions = loadExclusions(values.exclusions);
    } catch (err) {
      return {
        out,
        exclusions: [],
        usageError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const common = {
    out,
    exclusions,
    appConfig: values["app-config"],
    envFile: values["test-env"],
  };

  return {
    ...common,
    ...resolveSource(
      values["dynamic-plugins"],
      values.workspace,
      values.support,
    ),
  };
}

/**
 * Pick the plugin source from the mutually exclusive `--dynamic-plugins` /
 * `--workspace` pair, and validate the flags that only apply to one of them.
 */
function resolveSource(
  file: string | undefined,
  workspace: string | undefined,
  support: string | undefined,
): { source: SmokeSource; support?: string } | { usageError: string } {
  if (file && workspace) {
    return {
      usageError: "Provide only one of --dynamic-plugins or --workspace.",
    };
  }
  // --support filters metadata by spec.support, which only workspace mode reads; an
  // explicit dynamic-plugins.yaml has no metadata to filter, so silently ignoring it
  // would produce a run that looks scoped but is not.
  if (support && !workspace) {
    return { usageError: "--support requires --workspace." };
  }
  if (workspace) {
    // Validated here, before ANY filesystem consumer (auto-discovery runs early).
    if (!isValidWorkspaceName(workspace)) {
      return { usageError: `invalid workspace name: '${workspace}'` };
    }
    return { support, source: { kind: "workspace", name: workspace } };
  }
  if (!file) {
    return {
      usageError:
        "Provide --dynamic-plugins <dynamic-plugins.yaml> or --workspace <name>.",
    };
  }
  if (!existsSync(file)) {
    return { usageError: `dynamic-plugins file not found: ${file}` };
  }
  return { source: { kind: "file", path: file } };
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
async function extractPlugins(
  root: string,
  dynamicPlugins: string,
): Promise<void> {
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
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
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
    await writeErrorReport(
      out,
      "unknown",
      inputs.usageError ?? "invalid arguments",
    );
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
        ? await materializeWorkspaceConfig(
            source.name,
            tempDir,
            inputs.support,
            inputs.exclusions,
          )
        : { path: source.path, info: undefined, excluded: [] };
    await extractPlugins(root, materialized.path);

    const manifest = discoverPlugins(root);
    console.log(
      `▶ manifest: ${manifest.backend.length} backend, ${manifest.frontend.length} frontend`,
    );

    // Let extracted plugins (under a temp dir) resolve their @backstage/* peers here.
    patchModuleResolution(HARNESS_NODE_MODULES);

    const { skipped, excluded, backendPlugins } = partitionUnbootable(
      manifest.backend,
      inputs.exclusions,
    );
    if (skipped.length > 0) {
      console.warn(
        `⚠ not booted (installed and layout-validated): ${skipped.length} backend plugin(s): ${skipped.join(", ")}`,
      );
    }
    for (const record of excluded) {
      console.warn(
        `  ${record.packageName}: boot excluded by ${record.patternSource} (${record.ticket})`,
      );
    }
    const { loaded, errors: loadErrors } = loadBackendPlugins(backendPlugins);
    const start = await startBackend(loaded, appConfig);
    const frontend = validateFrontends(manifest.frontend);

    // The install CLI can exit 0 having laid out fewer plugins than we asked for, and
    // discoverPlugins silently drops any directory without a backstage.role. Without
    // this, a workspace whose artifacts half-materialized reports a clean pass over
    // packages nothing ever looked at — the silent green this sweep exists to prevent.
    const discovered = manifest.backend.length + manifest.frontend.length;
    const expected = materialized.info?.refCount;
    if (expected !== undefined && discovered !== expected) {
      throw new Error(
        `installed ${discovered} plugin(s) but the workspace declared ${expected} ` +
          `oci:// ref(s) — the install produced fewer plugins than requested, so part ` +
          `of the workspace was never validated.`,
      );
    }
    if (discovered === 0) {
      throw new Error(
        "nothing validated: the install produced no plugins at all",
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
      exclusions: [...materialized.excluded, ...excluded],
      status: computeStatus(
        loadErrors,
        start.ok,
        loaded.length,
        frontend.errors,
      ),
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
    await writeErrorReport(out, cliVersion, errorMessage(err));
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
