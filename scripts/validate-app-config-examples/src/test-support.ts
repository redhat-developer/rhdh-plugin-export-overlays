/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// Test support the plugin-path and published-images tests share.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vite-plus/test";
import { DYNAMIC_PACKAGES_ANNOTATION } from "../../../smoke-tests-native/src/plugin-path.ts";
import type { ManifestResult } from "./plugin-path.ts";

/** This repository's ghcr image prefix, without the trailing slash. */
export const OWN = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays";

/** A manifest whose annotation declares `paths`, as `plugin package` writes it. */
export function manifestDeclaring(...paths: string[]): ManifestResult {
  const entries = paths.map((path) => ({ [path]: {} }));
  return {
    kind: "ok",
    manifest: JSON.stringify({
      annotations: {
        [DYNAMIC_PACKAGES_ANNOTATION]: Buffer.from(JSON.stringify(entries)).toString("base64"),
      },
    }),
  };
}

/** A fresh directory under `parent`, removed when the current test ends. */
export function scratchDir(parent = tmpdir()): string {
  const dir = mkdtempSync(join(parent, "published-images-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
