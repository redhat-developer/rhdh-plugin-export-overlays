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
 *   tsx src/native-smoke.ts --dynamic-plugins <dynamic-plugins.yaml> [--out results.json]
 *   # or, to extract a whole catalog index instead of explicit OCI refs:
 *   CATALOG_INDEX_IMAGE=<image> tsx src/native-smoke.ts --catalog-index
 */

import { execSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { startTestBackend } from "@backstage/backend-test-utils";
import catalogPlugin from "@backstage/plugin-catalog-backend";
import scaffolderPlugin from "@backstage/plugin-scaffolder-backend";
import {
  loadManifest,
  loadBackendPlugins,
  validateFrontendBundle,
  type PluginError,
} from "./loader";

const CLI = "@red-hat-developer-hub/cli-module-install-dynamic-plugins";

// Bundled core plugins so dynamic plugins/modules can resolve their dependencies.
// Extend as needed (auth, permission, search, events) per the workspaces under test.
const coreFeatures = [catalogPlugin, scaffolderPlugin];

type Status = "pass" | "fail-load" | "fail-start" | "fail-bundle";
type Report = {
  cliVersion: string;
  backend: { total: number; loaded: number; errors: PluginError[] };
  backendStart: { ok: boolean; error?: string };
  frontend: { total: number; valid: number; errors: PluginError[] };
  status: Status;
};

function run(cmd: string, env?: NodeJS.ProcessEnv): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, ...env },
  }).trim();
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

  const cliVersion = run(`npx ${CLI} --version`);
  console.log(`▶ install CLI: ${CLI}@${cliVersion}`);

  const tempDir = await mkdtemp(join(tmpdir(), "native-smoke-"));
  const root = join(tempDir, "dynamic-plugins-root");
  await mkdir(root, { recursive: true });

  try {
    // Step 1: write the dynamic-plugins.yaml the CLI consumes.
    if (useCatalogIndex) {
      // Empty list => CLI extracts everything from CATALOG_INDEX_IMAGE.
      await writeFile(join(root, "dynamic-plugins.yaml"), "plugins: []\n");
    } else if (dynamicPlugins) {
      await copyFile(dynamicPlugins, join(root, "dynamic-plugins.yaml"));
    }

    // Step 2: extract (the part PR #2231 hand-rolled in 694 lines — now one CLI call).
    console.log("▶ extracting plugins via CLI…");
    execSync(`npx ${CLI} install ${root}`, {
      stdio: "inherit",
      env: catalogIndexImage
        ? { ...process.env, CATALOG_INDEX_IMAGE: catalogIndexImage }
        : process.env,
    });

    // Step 3: load backend plugins.
    const manifest = loadManifest(root);
    console.log(
      `▶ manifest: ${manifest.backend.length} backend, ${manifest.frontend.length} frontend`,
    );
    const { loaded, errors: loadErrors } = loadBackendPlugins(manifest.backend);

    // Step 4: boot the test backend with the loaded features.
    let startOk = false;
    let startError: string | undefined;
    if (loaded.length > 0) {
      try {
        const backend = await startTestBackend({
          features: [...coreFeatures, ...loaded.map((p) => p.feature)],
        });
        startOk = true;
        await backend.stop();
      } catch (err) {
        startError = err instanceof Error ? err.message : String(err);
      }
    }

    // Step 5: validate frontend bundles (load-only; no render).
    const frontendErrors: PluginError[] = [];
    let validFrontend = 0;
    for (const plugin of manifest.frontend) {
      const error = validateFrontendBundle(plugin);
      if (error) frontendErrors.push({ plugin, error });
      else validFrontend += 1;
    }

    const report: Report = {
      cliVersion,
      backend: {
        total: manifest.backend.length,
        loaded: loaded.length,
        errors: loadErrors,
      },
      backendStart: { ok: startOk, error: startError },
      frontend: {
        total: manifest.frontend.length,
        valid: validFrontend,
        errors: frontendErrors,
      },
      status:
        loadErrors.length > 0
          ? "fail-load"
          : !startOk && loaded.length > 0
            ? "fail-start"
            : frontendErrors.length > 0
              ? "fail-bundle"
              : "pass",
    };

    await writeFile(out, JSON.stringify(report, null, 2));
    console.log(`▶ report → ${out} (status: ${report.status})`);
    console.log(
      `  backend loaded ${report.backend.loaded}/${report.backend.total}, ` +
        `start=${startOk}, frontend ${validFrontend}/${manifest.frontend.length}`,
    );
    return report.status === "pass" ? 0 : 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
