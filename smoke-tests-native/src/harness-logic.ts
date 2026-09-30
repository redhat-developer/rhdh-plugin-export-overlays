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
import { compareStrings, errorMessage } from "./util";
import {
  createBackendFeatureLoader,
  type BackendFeature,
} from "@backstage/backend-plugin-api";

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
  notApplicableKeys: string[] = [],
): ConfigKeyMismatch[] {
  const names = new Set(bundleNames);
  const notApplicable = new Set(notApplicableKeys);
  // Sorted once: every mismatch reports the same list, and it does not depend on the key.
  const reported = [...names].sort(compareStrings);
  const seen = new Set<string>();
  const mismatches: ConfigKeyMismatch[] = [];
  for (const { key, source } of configured) {
    if (names.has(key) || RHDH_BUILTIN_FRONTEND_KEYS.has(key)) continue;
    // Configures an MF-only bundle (see configKeysNotApplicable): RHDH's NFS app never
    // reads the key, so there is no Scalprum name to hold it to.
    if (notApplicable.has(key)) continue;
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

/** What a loaded BackendFeature registers: a plugin, or a module attached to one. */
export type FeatureTarget = { kind: "plugin" | "module"; pluginId: string };

/**
 * Read a feature's registrations without starting it.
 *
 * Uses the same `getRegistrations()` that backend-app-api calls at startup; it only
 * runs the feature's `register` callback, which records deps and extension points.
 * Anything that does not look like a registrations feature (a feature loader, a
 * service factory) contributes nothing rather than throwing: this is a best-effort
 * hint for adding host plugins, and a wrong guess only costs that hint.
 */
export function featureTargets(feature: unknown): FeatureTarget[] {
  const f = feature as {
    $$type?: unknown;
    featureType?: unknown;
    getRegistrations?: unknown;
  } | null;
  if (
    f?.$$type !== "@backstage/BackendFeature" ||
    f.featureType !== "registrations" ||
    typeof f.getRegistrations !== "function"
  ) {
    return [];
  }
  let registrations: unknown;
  try {
    registrations = (f.getRegistrations as () => unknown)();
  } catch {
    return [];
  }
  if (!Array.isArray(registrations)) return [];
  return registrations.flatMap(
    (r: { type?: unknown; pluginId?: unknown }): FeatureTarget[] => {
      if (typeof r?.pluginId !== "string" || typeof r.type !== "string") {
        return [];
      }
      // `plugin` / `module-v1.1` today; matched by prefix so a new version suffix
      // does not silently turn every host into "missing".
      if (r.type.startsWith("plugin"))
        return [{ kind: "plugin", pluginId: r.pluginId }];
      if (r.type.startsWith("module"))
        return [{ kind: "module", pluginId: r.pluginId }];
      return [];
    },
  );
}

/**
 * Plugin ids that loaded modules attach to but nothing in the run provides.
 *
 * RHDH ships some host plugins statically (auth) and loads others as dynamic plugins
 * that may sit in another support tier (notifications). A module whose host is absent
 * fails startup on a missing extension point, which says nothing about the module. The
 * caller adds a static copy of the host for the ids it has one for.
 */
export function missingHostPluginIds(
  targets: FeatureTarget[],
  providedPluginIds: Iterable<string>,
): string[] {
  const provided = new Set(providedPluginIds);
  for (const t of targets) if (t.kind === "plugin") provided.add(t.pluginId);
  const missing = new Set<string>();
  for (const t of targets) {
    if (t.kind === "module" && !provided.has(t.pluginId))
      missing.add(t.pluginId);
  }
  return [...missing].sort(compareStrings);
}

/**
 * Configured keys that belong to an MF-only bundle.
 *
 * Main is the NFS-only line: packages/app no longer reads `dynamicPlugins.frontend`,
 * and an rhdh-cli 2.1 export ships module federation only. Those keys are dead config
 * rather than a naming defect, so the cross-check sets them aside instead of failing
 * every migrated workspace (RHIDP-17311). A key is set aside when either
 *
 * - the package whose metadata configures it installed as an MF-only bundle (its npm
 *   name, or the `-dynamic` export of it) — newer exports drop `scalprum` from
 *   package.json entirely, so this is the only link for them; or
 * - it equals the `scalprum.name` an MF-only bundle's package.json still declares.
 *
 * A key tied to neither is still checked, and fails when nothing answers to it.
 */
export function configKeysNotApplicable(
  configured: ConfiguredFrontendKey[],
  mfOnly: { npmNames: string[]; scalprumNames: string[] },
): string[] {
  const npm = new Set(mfOnly.npmNames);
  const names = new Set(mfOnly.scalprumNames);
  const belongsToMfOnly = (c: ConfiguredFrontendKey) =>
    names.has(c.key) ||
    (c.packageName !== undefined &&
      (npm.has(c.packageName) || npm.has(`${c.packageName}-dynamic`)));
  return [
    ...new Set(configured.filter(belongsToMfOnly).map((c) => c.key)),
  ].sort(compareStrings);
}

type FeatureLoaderLike = {
  $$type?: unknown;
  featureType?: unknown;
  deps?: Record<string, unknown>;
  description?: unknown;
  loader?: (deps: Record<string, unknown>) => Promise<unknown[]>;
};

/**
 * A loader that yields `import('./x.cjs.js')` hands back the CJS `module.exports`
 * (`{ default: feature }`), one level above the feature, because import() of CommonJS
 * wraps it again. The backend unwraps it; so must anything reading the list before it.
 *
 * One level, as the backend's own `unwrapFeature` does: the loader returned by
 * createBackendFeatureLoader has already taken off the first. Deeper nesting is left
 * as is, so it fails here as it does in RHDH.
 */
function unwrapDefault(item: unknown): unknown {
  const i = item as { $$type?: unknown; default?: unknown } | null;
  if (i?.$$type === undefined && i?.default !== undefined) return i.default;
  return item;
}

// Loaders yielding loaders is legal but shallow in practice; the cap only stops a loader
// that yields itself from recursing forever. Past it the loader is left to the backend.
const MAX_LOADER_NESTING = 5;

/** What expandFeatureLoaders hands back; see there for why services stay apart. */
export type ExpandedFeatures = {
  /** Every feature, with dependency-free loaders replaced by what they yield. */
  features: unknown[];
  /** Service factories those loaders yielded, still owed loader semantics. */
  loaderServiceFactories: unknown[];
};

/**
 * Replace every dependency-free feature loader with the features it yields.
 *
 * startTestBackend adds an empty placeholder plugin for each module whose plugin is
 * not in the feature list, and a plugin that arrives through a loader is invisible to
 * it. So scorecard-backend (a loader yielding scorecardPlugin) plus any scorecard module
 * failed with "Plugin 'scorecard' is already registered". RHDH boots the same pair
 * fine. Expanding loaders up front shows startTestBackend the real plugin. A loader that
 * needs services is kept as is: resolving those deps is the backend's job.
 *
 * Service factories a loader yields are returned apart, not flattened in: the backend
 * skips a loader's factory when the service is already provided, but rejects an
 * explicit duplicate. The caller hands them back inside a loader to keep that rule.
 *
 * A loader that throws is reported with its description, as the backend does.
 */
export async function expandFeatureLoaders(
  features: unknown[],
): Promise<ExpandedFeatures> {
  const expanded: ExpandedFeatures = {
    features: [],
    loaderServiceFactories: [],
  };
  await expandInto(features, 0, false, expanded);
  return expanded;
}

// Recursive rather than looped, as partitionResolvable is: loaders run one at a time
// and in list order, as the backend runs them, and the output keeps that order.
async function expandInto(
  features: unknown[],
  depth: number,
  fromLoader: boolean,
  into: ExpandedFeatures,
  index = 0,
): Promise<void> {
  if (index >= features.length) return;
  await expandOne(features[index], depth, fromLoader, into);
  return expandInto(features, depth, fromLoader, into, index + 1);
}

async function expandOne(
  feature: unknown,
  depth: number,
  fromLoader: boolean,
  into: ExpandedFeatures,
): Promise<void> {
  const f = feature as FeatureLoaderLike | null;
  if (fromLoader && isServiceFactory(f)) {
    into.loaderServiceFactories.push(feature);
    return;
  }
  const loader = expandableLoader(f, depth);
  if (!loader) {
    into.features.push(feature);
    return;
  }
  let yielded: unknown[];
  try {
    yielded = (await loader({})).map(unwrapDefault);
  } catch (err) {
    const description =
      typeof f?.description === "string" ? f.description : "(no description)";
    throw new Error(
      `Feature loader ${description} failed: ${errorMessage(err)}`,
      { cause: err },
    );
  }
  return expandInto(yielded, depth + 1, true, into);
}

function isServiceFactory(f: FeatureLoaderLike | null): boolean {
  return (
    f?.$$type === "@backstage/BackendFeature" && f.featureType === "service"
  );
}

/** The loader function of a feature this module may expand, or undefined. */
function expandableLoader(
  f: FeatureLoaderLike | null,
  depth: number,
): FeatureLoaderLike["loader"] {
  if (
    f?.$$type !== "@backstage/BackendFeature" ||
    f.featureType !== "loader" ||
    typeof f.loader !== "function"
  ) {
    return undefined;
  }
  const needsDeps = f.deps !== undefined && Object.keys(f.deps).length > 0;
  return needsDeps || depth > MAX_LOADER_NESTING ? undefined : f.loader;
}

/**
 * The feature list handed to startTestBackend: `head` (core plugins, services, hosts),
 * then the loader holding expandFeatureLoaders' service factories, then the loaded
 * features, then `tail` (the root config).
 *
 * The service factories go back inside a loader, so a service already provided is
 * skipped rather than rejected as a duplicate. That loader comes before every loader
 * kept in `features`: the backend runs loaders in list order, and one that depends on
 * a root service must find it registered. In RHDH the loader yielding that service ran
 * where it was declared; here it was taken apart, and placed last it would leave the
 * dependent loader failing on a service RHDH provides.
 */
export function bootFeatureList(
  expanded: ExpandedFeatures,
  { head, tail }: { head: BackendFeature[]; tail: BackendFeature[] },
): BackendFeature[] {
  const serviceFactories = expanded.loaderServiceFactories as BackendFeature[];
  return [
    ...head,
    ...(serviceFactories.length > 0
      ? [createBackendFeatureLoader({ loader: () => serviceFactories })]
      : []),
    ...(expanded.features as BackendFeature[]),
    ...tail,
  ];
}
