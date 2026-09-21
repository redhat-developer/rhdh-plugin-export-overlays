/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { after } from "node:test";

// Every mkdtempSync would otherwise leak an unbounded pile of directories in $TMPDIR.
// node:test runs each file in its own process, so this hook is per file.
const TEMP_DIRS: string[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});
