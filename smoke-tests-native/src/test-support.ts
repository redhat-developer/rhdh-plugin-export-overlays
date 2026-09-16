/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { after } from "node:test";

// Every mkdtempSync would otherwise leak: the loader suite alone left 26 directories in
// $TMPDIR per run, unbounded on a developer machine and on any long-lived runner.
// `after` registers per test file under node:test, so each file cleans up its own.
const TEMP_DIRS: string[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});
