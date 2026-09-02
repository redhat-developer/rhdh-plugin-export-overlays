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
import type { ConfigKeyMismatch, Status } from "./report";
import type { ConfiguredFrontendKey } from "./workspace";
import { compareStrings } from "./util";

/**
 * The harness's verdict, most specific failure first.
 *
 * `loadedCount > 0` matters for the frontend-only case: startBackend short-circuits to
 * `{ok: true, skipped: true}` when nothing loaded, so a workspace with no backend
 * plugins is a pass rather than a boot failure.
 *
 * `bundleErrors` is both halves' bundle faults in one list, not the frontend's alone.
 * Nothing here distinguishes them — a bundle fault is `fail-bundle` whichever half it
 * came from — and one list keeps two same-typed arrays out of the signature, where
 * transposing them at the call site would be silent. The report still records them
 * separately, under `frontend.errors` and `backend.bundleErrors`.
 */
export function computeStatus(
  loadErrors: PluginError[],
  startOk: boolean,
  loadedCount: number,
  bundleErrors: PluginError[],
  configKeyMismatches: number,
): Status {
  if (loadErrors.length > 0) return "fail-load";
  if (!startOk && loadedCount > 0) return "fail-start";
  if (bundleErrors.length > 0 || configKeyMismatches > 0) return "fail-bundle";
  return "pass";
}

/**
 * `dynamicPlugins.frontend` keys RHDH itself owns, so they name no plugin and must never
 * be reported as a mismatch.
 *
 * This is not a judgement call or a workaround for a defect — it mirrors a hardcoded list
 * in RHDH, `ignoreStaticPlugins` in
 * `packages/app/src/utils/dynamicUI/initializeRemotePlugins.ts`, which filters these keys
 * out by `scope` before it ever asks Scalprum for a module. RHDH's own docs
 * (`docs/customization.md`) describe `default.main-menu-items` as the key for configuring
 * static main menu items, with the `default.` prefix required.
 *
 * A constant rather than a tracked exclusions file, deliberately. The exclusions file
 * exists for defects that carry a ticket and are meant to be deleted when fixed; these
 * are permanent product facts with no ticket and nothing to fix, and filing them there
 * would make "every entry has a ticket" — the file's whole enforcement mechanism — a lie.
 * Keep this in step with RHDH's list, not with anything in this repo.
 */
const RHDH_BUILTIN_FRONTEND_KEYS = new Set(["default.main-menu-items"]);

/**
 * Configured keys that no installed bundle answers to.
 *
 * Set-based on purpose: it asks whether ANY bundle in the run reports the name, not
 * whether the bundle of the package that declares the key does. A metadata file may
 * legitimately configure a sibling package's plugin — and one OCI image can carry
 * several plugins, so tying a key to "its own" bundle would need a metadata-to-directory
 * mapping that does not survive multi-plugin images. `cost-management` is exactly that
 * shape: two packages, one ref.
 */
export function findConfigKeyMismatches(
  configured: ConfiguredFrontendKey[],
  bundleNames: string[],
): ConfigKeyMismatch[] {
  const names = new Set(bundleNames);
  // Sorted once: every mismatch reports the same list, and it does not depend on the key.
  const reported = [...names].sort(compareStrings);
  const seen = new Set<string>();
  const mismatches: ConfigKeyMismatch[] = [];
  for (const { key, source } of configured) {
    if (names.has(key) || RHDH_BUILTIN_FRONTEND_KEYS.has(key)) continue;
    // A key repeated across metadata files is one finding, not one per file: the reader
    // fixes the bundle name or the key once.
    if (seen.has(key)) continue;
    seen.add(key);
    mismatches.push({ key, source, bundleNames: reported });
  }
  return mismatches;
}

/**
 * How many bundle names the message spells out before summarising the rest.
 *
 * Both sides have to survive `oneLine`'s DETAIL_LIMIT (220) in the sweep's failure table,
 * and "naming both sides" is this check's acceptance criterion — a row truncated inside
 * the list drops exactly the half that says what to write instead. Three names is what
 * fits once the key and the file are accounted for; the untruncated message is in
 * results.json and on the console either way.
 */
const NAMES_IN_MESSAGE = 3;

/**
 * Whether the set of installed bundle names is complete enough to judge configured keys
 * against.
 *
 * The cross-check asks whether a key matches a name some bundle reports, which is a
 * question about metadata ONLY while every installed package contributed its name. Two
 * things break that, and both already fail the run on their own:
 *
 * - an install shortfall — a declared ref never landed, so its key looks like a metadata
 *   defect when the real cause is a failed pull;
 * - a frontend bundle whose manifest could not be read — `scalprum.name` is null, so that
 *   package contributes nothing and its own key is blamed on top of the bundle error
 *   already reported. Two findings, one defect, and the second names the wrong artifact.
 *
 * Here rather than inline in native-smoke.ts because that file ends in
 * `process.exit(await main())`, which puts everything beside it out of reach of a test —
 * the same reason the rest of this module exists.
 */
export function bundleNamesAreComplete(
  installShortfall: string | null,
  frontendErrors: PluginError[],
): boolean {
  return !installShortfall && frontendErrors.length === 0;
}

/** One line per mismatch, naming both sides — the key and what the bundles do report. */
export function describeConfigKeyMismatch(mismatch: ConfigKeyMismatch): string {
  const shown = mismatch.bundleNames.slice(0, NAMES_IN_MESSAGE);
  const extra = mismatch.bundleNames.length - shown.length;
  const more = extra > 0 ? `, +${extra} more` : "";
  const reported = shown.length ? `${shown.join(", ")}${more}` : "nothing";
  // Key and names first, the fixed explanation last: the tail is the same on every
  // finding and is the part a reader can afford to lose to truncation.
  return (
    `dynamicPlugins.frontend.'${mismatch.key}' matches no installed bundle name ` +
    `(bundles report: ${reported}); configured in ${mismatch.source} — RHDH matches the ` +
    `key against dist-scalprum/plugin-manifest.json's name, so every mount point under ` +
    `it is ignored with nothing logged`
  );
}

export type ShortfallOptions = {
  /** What to call the source in the message ("workspace", "catalog index"). */
  subject?: string;
  /**
   * Accept MORE plugins than refs. Only for a deduplicated ref list, where the count is
   * a lower bound — one OCI image can carry several plugins. Workspace mode does not
   * dedup and deliberately treats any mismatch as a fault.
   */
  allowExtra?: boolean;
};

/**
 * Compare what the install laid out against what the source declared. Null when they
 * agree, or when there is nothing to compare (`--dynamic-plugins` file mode).
 * `subject` names the source: catalog-index mode has no workspace to send a reader to.
 */
export function describeInstallShortfall(
  discovered: number,
  expected: number | undefined,
  options: ShortfallOptions = {},
): string | null {
  const { subject = "source", allowExtra = false } = options;
  if (expected === undefined) {
    return discovered === 0
      ? "nothing validated: the install produced no plugins at all"
      : null;
  }
  if (discovered === expected) return null;
  if (allowExtra && discovered > expected) return null;
  return (
    `installed ${discovered} plugin(s) but the ${subject} declared ${expected} ` +
    `oci:// ref(s) — part of the ${subject} was never validated`
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
