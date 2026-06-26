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
 * the 694-line bespoke harness from the closed POC PR #2231 — no Docker.
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

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const role: string = pkg.backstage?.role ?? "";
    const item: PluginEntry = {
      name: pkg.name ?? entry.name,
      version: pkg.version ?? "0.0.0",
      dirName: entry.name,
      path: dir,
      role: role.includes("frontend") ? "frontend" : "backend",
    };

    if (role.includes("frontend")) frontend.push(item);
    else if (role.includes("backend")) backend.push(item);
    // dirs without a backstage role aren't plugins — skip
  }

  return { backend, frontend };
}

/** Resolve the entry point for a backend plugin package. */
export function resolveEntryPoint(pluginPath: string): string {
  const pkgPath = join(pluginPath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`package.json not found in ${pluginPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const candidates = [
    "dist/index.cjs.js",
    "dist/index.esm.js",
    "dist/index.js",
    pkg.main?.startsWith("dist/") ? pkg.main : undefined,
  ].filter(Boolean) as string[];

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

/** Verify a frontend plugin has the required scalprum/remoteEntry bundle artifacts. */
export function validateFrontendBundle(plugin: PluginEntry): string | null {
  const has = (rel: string) => existsSync(join(plugin.path, rel));
  if (!has("package.json")) return "missing package.json";
  if (!has("dist-scalprum") && !has("dist/remoteEntry.js")) {
    return "missing both dist-scalprum/ and dist/remoteEntry.js - needs at least one";
  }
  if (has("dist-scalprum") && !has("dist-scalprum/plugin-manifest.json")) {
    return "dist-scalprum/ found but missing plugin-manifest.json";
  }
  return null;
}

/** Best-effort: does a backend plugin dir contain any JS (used for warn-only checks). */
export function hasJs(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (hasJs(full)) return true;
    } else if (/\.(js|mjs|cjs)$/.test(e.name)) {
      return true;
    }
  }
  return false;
}
