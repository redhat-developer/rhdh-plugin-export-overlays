/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Plugin loader utilities (ported from RHDH PR #4967:
 * e2e-tests/playwright/utils/plugin-loader.ts).
 *
 * Reused as-is to validate the recommendation in RHIDP-15076 / RHIDP-15075:
 * the published `install-dynamic-plugins` CLI + `startTestBackend` can replace
 * the 694-line bespoke harness from the closed PR #2231 — no Docker.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { BackendFeature } from "@backstage/backend-plugin-api";

// The package is ESM ("type": "module"), so the global `require` is undefined.
// createRequire gives us a CommonJS require to load the extracted (CJS) plugins.
const require = createRequire(import.meta.url);

export type PluginRole = "backend" | "frontend";

export type PluginEntry = {
  name: string;
  version: string;
  dirName: string;
  path: string;
  role: PluginRole;
};

export type PluginManifest = {
  backend: PluginEntry[];
  frontend: PluginEntry[];
};

export type LoadedPlugin = { plugin: PluginEntry; feature: BackendFeature };
export type PluginError = { plugin: PluginEntry; error: string };

/**
 * Discover installed plugins by scanning the install root. The CLI does not emit a
 * manifest.json — it lays out one directory per plugin, each with a package.json whose
 * `backstage.role` classifies it (backend-plugin[-module] vs frontend-plugin[-module]).
 */
export function discoverPlugins(root: string): PluginManifest {
  const backend: PluginEntry[] = [];
  const frontend: PluginEntry[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;

    let pkg: { name?: string; version?: string; backstage?: { role?: string } };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      // A malformed package.json shouldn't abort discovery of the rest, but it's a real
      // problem — warn loudly so it isn't skipped silently.
      console.warn(
        `⚠ skipping '${entry.name}': malformed package.json (${pkgPath})`,
      );
      continue;
    }
    const role: string = pkg.backstage?.role ?? "";
    const isFrontend = role.includes("frontend");
    const item: PluginEntry = {
      name: pkg.name ?? entry.name,
      version: pkg.version ?? "0.0.0",
      dirName: entry.name,
      path: dir,
      role: isFrontend ? "frontend" : "backend",
    };

    if (isFrontend) frontend.push(item);
    else if (role.includes("backend")) backend.push(item);
    // dirs without a backstage role aren't plugins — skip
  }

  return { backend, frontend };
}

/** Resolve the entry point for a backend plugin package. */
function resolveEntryPoint(pluginPath: string): string {
  const pkgPath = join(pluginPath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`package.json not found in ${pluginPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // Normalize "./dist/…" → "dist/…" so an explicit main is not silently excluded.
  const main: string | undefined = pkg.main?.replace(/^\.\//, "");
  const candidates = [
    "dist/index.cjs.js",
    "dist/index.esm.js",
    "dist/index.js",
    main?.startsWith("dist/") ? main : undefined,
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const full = join(pluginPath, candidate);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `No entry point found in ${pluginPath}. Tried: ${candidates.join(", ")}; ` +
      `package.json main: ${pkg.main || "(not set)"}`,
  );
}

/** require() each backend plugin and verify it exposes a default BackendFeature. */
export function loadBackendPlugins(plugins: PluginEntry[]): {
  loaded: LoadedPlugin[];
  errors: PluginError[];
} {
  const loaded: LoadedPlugin[] = [];
  const errors: PluginError[] = [];
  for (const plugin of plugins) {
    try {
      const entryPoint = resolveEntryPoint(plugin.path);
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- OCI plugins are CJS
      const mod = require(entryPoint) as { default?: BackendFeature };
      if (!mod.default) {
        errors.push({ plugin, error: "No default export" });
        continue;
      }
      loaded.push({ plugin, feature: mod.default });
    } catch (err) {
      errors.push({
        plugin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { loaded, errors };
}

/** Which frontend system(s) a plugin's bundle supports. */
export type FrontendSystem = "legacy" | "new-frontend-system";

export type FrontendBundleResult = {
  systems: FrontendSystem[];
  error: string | null;
};

/**
 * Check that a frontend plugin's bundle artifacts EXIST for at least one frontend
 * system (presence check only — the bundle is never loaded or evaluated):
 * - legacy frontend system: `dist-scalprum/` + `plugin-manifest.json` (Scalprum)
 * - new frontend system: `dist/remoteEntry.js` + `dist/mf-manifest.json` (module
 *   federation remote, loaded by @backstage/frontend-dynamic-feature-loader)
 * Dual-system plugins (e.g. tech-radar) ship both layouts; new-system-only plugins
 * (e.g. app-auth) ship only the module-federation one. A present-but-incomplete
 * layout is an error even when the other system's layout is valid — the artifact
 * advertises a system it can't deliver.
 */
export function validateFrontendBundle(plugin: PluginEntry): FrontendBundleResult {
  const has = (rel: string) => existsSync(join(plugin.path, rel));
  if (!has("package.json")) return { systems: [], error: "missing package.json" };

  const systems: FrontendSystem[] = [];
  if (has("dist-scalprum")) {
    if (!has("dist-scalprum/plugin-manifest.json")) {
      return { systems, error: "dist-scalprum/ found but missing plugin-manifest.json" };
    }
    systems.push("legacy");
  }
  if (has("dist/remoteEntry.js")) {
    if (!has("dist/mf-manifest.json")) {
      return {
        systems,
        error: "dist/remoteEntry.js found but missing dist/mf-manifest.json",
      };
    }
    systems.push("new-frontend-system");
  }
  if (systems.length === 0) {
    return {
      systems,
      error:
        "no frontend bundle found — needs dist-scalprum/ (legacy frontend system) " +
        "and/or dist/remoteEntry.js (new frontend system)",
    };
  }
  return { systems, error: null };
}
