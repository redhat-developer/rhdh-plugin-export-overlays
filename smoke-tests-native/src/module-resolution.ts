/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Module resolution patch (ported from RHDH PR #4967:
 * e2e-tests/playwright/utils/module-resolution-patch.ts).
 *
 * Extracted OCI plugins live under a temp dir and have no node_modules of their
 * own, so their bare `@backstage/*` imports must resolve against THIS harness's
 * node_modules. Node's default resolution walks up from the plugin's temp path and
 * never reaches here, so we extend `Module._nodeModulePaths` to append the harness
 * node_modules. Requires a node-modules linker (see .yarnrc.yml), not PnP.
 */

import { join, resolve } from "node:path";
import Module from "node:module";

// Uses the undocumented-but-stable Node internal `Module._nodeModulePaths`.
// Tested with Node 22/24. If it breaks, fall back to NODE_PATH.
export function patchModuleResolution(extraNodeModulesPath: string): void {
  const resolvedPath = resolve(extraNodeModulesPath);

  const nodeModule = Module as unknown as {
    _nodeModulePaths: (...args: unknown[]) => string[];
    _initPaths?: () => void;
  };

  if (!nodeModule._nodeModulePaths) {
    console.warn(
      "Module._nodeModulePaths not available - falling back to NODE_PATH. " +
        "Plugins may fail to load if peer dependencies cannot be resolved.",
    );
    const sep = process.platform === "win32" ? ";" : ":";
    const paths = (process.env.NODE_PATH || "").split(sep).filter(Boolean);
    if (!paths.includes(resolvedPath)) {
      paths.push(resolvedPath);
      process.env.NODE_PATH = paths.join(sep);
      nodeModule._initPaths?.();
      console.log(`✓ Added to NODE_PATH: ${resolvedPath}`);
    }
    return;
  }

  const original = nodeModule._nodeModulePaths;
  nodeModule._nodeModulePaths = (...args: unknown[]) => {
    const paths = original.apply(nodeModule, args);
    if (!paths.includes(resolvedPath)) paths.push(resolvedPath);
    return paths;
  };

  console.log(`✓ Patched module resolution to include: ${resolvedPath}`);
}

/** What `patchDynamicPackageJsonResolution` needs to know about an installed plugin. */
export type DynamicPackage = { name: string; path: string };

// Only requests coming from backend-plugin-api's own code, as in Backstage's loader: any
// other `x/package.json` that fails to resolve is a real missing dependency and must
// keep failing.
const BACKEND_PLUGIN_API_RE =
  /[/\\](?:@backstage|packages)[/\\]backend-plugin-api(?:[/\\]|$)/;
const PACKAGE_JSON_SUFFIX = "/package.json";
const DYNAMIC_SUFFIX = "-dynamic";

/**
 * Where a `<pkg>/package.json` request resolves among the installed dynamic plugins,
 * or undefined when it is not one Backstage's loader would redirect.
 *
 * `resolvePackagePath()` in @backstage/backend-plugin-api requires the plugin's
 * package.json by its NON-dynamic name, to find the package root for migrations and
 * assets. An exported plugin is installed as `<pkg>-dynamic`, so that require fails
 * unless something maps it. In RHDH that is @backstage/backend-dynamic-feature-service:
 * `CommonJSModuleLoader` patches `Module._resolveFilename` with exactly this rule. The
 * harness boots plugins without that loader, so without this every plugin with a
 * database (adoption-insights, bulk-import, notifications, scorecard…) failed to load
 * here and loads fine in RHDH (RHIDP-17310, RHDHBUGS-3557).
 */
export function dynamicPackageJsonPath(
  request: string,
  parentPath: string | undefined,
  plugins: DynamicPackage[],
): string | undefined {
  if (!request.endsWith(PACKAGE_JSON_SUFFIX)) return undefined;
  if (!BACKEND_PLUGIN_API_RE.test(parentPath ?? "")) return undefined;
  const searched = request.slice(0, -PACKAGE_JSON_SUFFIX.length);
  const names = new Set([searched, `${searched}${DYNAMIC_SUFFIX}`]);
  const match = plugins.find((plugin) => names.has(plugin.name));
  return match ? join(match.path, "package.json") : undefined;
}

/**
 * Install the `<pkg>/package.json` redirect for the given plugins. Tried only after
 * Node's own resolution fails, so anything resolvable normally is untouched. Returns a
 * function that removes the patch (the harness never does; tests must).
 */
export function patchDynamicPackageJsonResolution(
  plugins: DynamicPackage[],
): () => void {
  const nodeModule = Module as unknown as {
    _resolveFilename: (
      request: string,
      parent: { path?: string } | undefined,
      ...rest: unknown[]
    ) => string;
  };
  const original = nodeModule._resolveFilename;
  nodeModule._resolveFilename = (request, parent, ...rest) => {
    try {
      return original.call(nodeModule, request, parent, ...rest);
    } catch (err) {
      const redirected = dynamicPackageJsonPath(request, parent?.path, plugins);
      if (redirected) return redirected;
      throw err;
    }
  };
  return () => {
    nodeModule._resolveFilename = original;
  };
}
