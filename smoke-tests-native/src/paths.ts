/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Path containment for CLI-supplied file arguments.
 *
 * Every path these tools touch comes from an argv flag, so a bad (or hostile) value
 * could otherwise read or write anywhere the process can reach. Each is canonicalized
 * and required to stay inside the working directory before any filesystem call —
 * the rule `native-smoke.ts` already applied to its own `--out` (Sonar S8707), lifted
 * here so `sweep.ts` and `aggregate.ts` enforce the same one.
 */

import { resolve, sep } from "node:path";

/**
 * Resolve `arg` and return it only if it stays inside `root` (default: the working
 * directory). Returns null otherwise — callers turn that into a usage error.
 *
 * `root` itself is accepted; `resolve` collapses any `..` first, so a path that
 * escapes and returns (`a/../../b`) is judged on where it actually lands.
 */
export function resolveContained(
  arg: string,
  root: string = process.cwd(),
): string | null {
  const base = resolve(root);
  const resolved = resolve(base, arg);
  return resolved === base || resolved.startsWith(base + sep) ? resolved : null;
}

/** `resolveContained`, but throwing a flag-labelled usage error instead of null. */
export function requireContained(
  flag: string,
  arg: string,
  root: string = process.cwd(),
): string {
  const resolved = resolveContained(arg, root);
  if (!resolved) {
    throw new Error(
      `${flag} must resolve inside the working directory: ${arg}`,
    );
  }
  return resolved;
}
