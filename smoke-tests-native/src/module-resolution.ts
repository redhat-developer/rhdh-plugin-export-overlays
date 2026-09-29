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

import { resolve } from "node:path";
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
