/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * The harness's pure decision logic, split out of native-smoke.ts so it can be tested:
 * that file ends in `process.exit(await main())`, which makes anything beside it
 * unreachable from a test runner.
 */

import type { PluginEntry, PluginError } from "./loader";
import type { Status } from "./report";

/**
 * The harness's verdict, most specific failure first.
 *
 * `loadedCount > 0` matters for the frontend-only case: startBackend short-circuits to
 * `{ok: true, skipped: true}` when nothing loaded, so a workspace with no backend
 * plugins is a pass rather than a boot failure.
 */
export function computeStatus(
  loadErrors: PluginError[],
  startOk: boolean,
  loadedCount: number,
  frontendErrors: PluginError[],
): Status {
  if (loadErrors.length > 0) return "fail-load";
  if (!startOk && loadedCount > 0) return "fail-start";
  if (frontendErrors.length > 0) return "fail-bundle";
  return "pass";
}

/**
 * Compare what the install actually laid out against what the workspace declared.
 *
 * Returns null when they agree (or when there is nothing to compare against, i.e.
 * `--dynamic-plugins` file mode, where no ref count is known).
 */
export function describeInstallShortfall(
  discovered: number,
  expected: number | undefined,
): string | null {
  if (expected === undefined) {
    return discovered === 0
      ? "nothing validated: the install produced no plugins at all"
      : null;
  }
  if (discovered === expected) return null;
  return (
    `installed ${discovered} plugin(s) but the workspace declared ${expected} ` +
    `oci:// ref(s) — part of the workspace was never validated`
  );
}

/**
 * Split backend entries into those that will be booted and those that will not, in one
 * pass so the two lists stay complementary. `bootExcluded` returns a truthy record for
 * a tracked boot-scope exclusion; `knownFailure` is the older dirName-keyed skip list.
 */
export function partitionBootable<T>(
  entries: PluginEntry[],
  bootExcluded: (packageName: string) => T | undefined,
  knownFailure: (dirName: string) => boolean,
): { skipped: string[]; excluded: T[]; bootable: PluginEntry[] } {
  const skipped: string[] = [];
  const excluded: T[] = [];
  const bootable: PluginEntry[] = [];
  for (const entry of entries) {
    const exclusion = bootExcluded(entry.name);
    if (exclusion) excluded.push(exclusion);
    if (exclusion || knownFailure(entry.dirName)) skipped.push(entry.dirName);
    else bootable.push(entry);
  }
  return { skipped, excluded, bootable };
}
