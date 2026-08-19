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

import type { MfRemoteInfo, PluginEntry, PluginError } from "./loader";
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

/**
 * Describe why a served module-federation remote may contribute nothing to the new
 * frontend system, or null when there is nothing to say.
 *
 * Never a failure. The remote is a valid artifact — the router serves it — and what is or
 * is not mountable is a property of the plugin's own source. Failing it would turn several
 * workspaces red for work that belongs upstream.
 *
 * The two cases are worded differently on purpose, because only one of them is knowable
 * from metadata. RHDH's `nfsModuleFilter` returns no resolver at all when
 * `backstage.features` is absent or empty, so the router then advertises EVERY exposed
 * module and `@backstage/frontend-dynamic-feature-loader` decides at runtime by the
 * `$$type` of each module's default export. Reporting that as "mounts nothing" would state
 * a guess as a fact.
 */
export function describeNfsShortfall(mf: MfRemoteInfo | null): string | null {
  if (!mf?.servable) return null;
  // A failure to read backstage.features is not a finding about the artifact. Saying
  // anything here would turn "we could not look" into "it declares nothing".
  if (mf.nfsFeaturesError) return null;
  if (mf.nfsFeatures.length === 0) {
    return (
      "the remote is served but declares no backstage.features, so nfsModuleFilter " +
      "installs no filter and every exposed module is advertised — whether the new " +
      "frontend system mounts any of them cannot be determined without executing the bundle"
    );
  }
  if (mf.nfsFeaturesExposed.length === 0) {
    return (
      "the remote is served and declares NFS entry points, but does not expose them " +
      `(declared ${mf.nfsFeatures.join(", ")}; exposes ${
        mf.exposes.join(", ") || "nothing"
      }) — nfsModuleFilter will keep no modules, so the new frontend system will mount nothing`
    );
  }
  return null;
}
