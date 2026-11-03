/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// Test support: the one manifest builder the plugin-path tests share.

import { DYNAMIC_PACKAGES_ANNOTATION } from "../../../smoke-tests-native/src/plugin-path.ts";
import type { ManifestResult } from "./plugin-path.ts";

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
