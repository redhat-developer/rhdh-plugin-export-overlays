/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Plugin loader utilities (ported from RHDH PR #4967:
 * e2e-tests/playwright/utils/plugin-loader.ts).
 *
 * Reused as-is to validate the recommendation in RHIDP-15076 / RHIDP-15075:
 * the published `install-dynamic-plugins` CLI + `startTestBackend` can replace
 * the 694-line bespoke harness from the closed PR #2231 — no Docker.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import type { BackendFeature } from "@backstage/backend-plugin-api";
import { resolveContained } from "./paths";
import { errorMessage } from "./util";

// The package is ESM ("type": "module"), so the global `require` is undefined.
// createRequire gives us a CommonJS require to load the extracted (CJS) plugins.
const require = createRequire(import.meta.url);

export type PluginRole = "backend" | "frontend";

export type PluginEntry = {
  name: string;
  version: string;
  dirName: string;
  path: string;
  role: PluginRole;
};

export type PluginManifest = {
  backend: PluginEntry[];
  frontend: PluginEntry[];
};

export type LoadedPlugin = { plugin: PluginEntry; feature: BackendFeature };
export type PluginError = { plugin: PluginEntry; error: string };

/**
 * Discover installed plugins by scanning the install root. The CLI does not emit a
 * manifest.json — it lays out one directory per plugin, each with a package.json whose
 * `backstage.role` classifies it (backend-plugin[-module] vs frontend-plugin[-module]).
 */
export function discoverPlugins(root: string): PluginManifest {
  const backend: PluginEntry[] = [];
  const frontend: PluginEntry[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;

    let pkg: { name?: string; version?: string; backstage?: { role?: string } };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      // A malformed package.json shouldn't abort discovery of the rest, but it's a real
      // problem — warn loudly so it isn't skipped silently.
      console.warn(
        `⚠ skipping '${entry.name}': malformed package.json (${pkgPath})`,
      );
      continue;
    }
    const role: string = pkg.backstage?.role ?? "";
    const isFrontend = role.includes("frontend");
    const item: PluginEntry = {
      name: pkg.name ?? entry.name,
      version: pkg.version ?? "0.0.0",
      dirName: entry.name,
      path: dir,
      role: isFrontend ? "frontend" : "backend",
    };

    if (isFrontend) frontend.push(item);
    else if (role.includes("backend")) backend.push(item);
    // dirs without a backstage role aren't plugins — skip
  }

  return { backend, frontend };
}

/** Resolve the entry point for a backend plugin package. */
function resolveEntryPoint(pluginPath: string): string {
  const pkgPath = join(pluginPath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`package.json not found in ${pluginPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // Normalize "./dist/…" → "dist/…" so an explicit main is not silently excluded.
  const main: string | undefined = pkg.main?.replace(/^\.\//, "");
  const candidates = [
    "dist/index.cjs.js",
    "dist/index.esm.js",
    "dist/index.js",
    main?.startsWith("dist/") ? main : undefined,
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const full = join(pluginPath, candidate);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `No entry point found in ${pluginPath}. Tried: ${candidates.join(", ")}; ` +
      `package.json main: ${pkg.main || "(not set)"}`,
  );
}

/** require() each backend plugin and verify it exposes a default BackendFeature. */
export function loadBackendPlugins(plugins: PluginEntry[]): {
  loaded: LoadedPlugin[];
  errors: PluginError[];
} {
  const loaded: LoadedPlugin[] = [];
  const errors: PluginError[] = [];
  for (const plugin of plugins) {
    try {
      const entryPoint = resolveEntryPoint(plugin.path);
      const mod = require(entryPoint) as { default?: BackendFeature };
      if (!mod.default) {
        errors.push({ plugin, error: "No default export" });
        continue;
      }
      loaded.push({ plugin, feature: mod.default });
    } catch (err) {
      errors.push({
        plugin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { loaded, errors };
}

/** Which frontend system(s) a plugin's bundle supports. */
export type FrontendSystem = "legacy" | "new-frontend-system";

/** Entry-point feature types the new frontend system recognises. */
const NFS_FEATURE_TYPES = new Set([
  "@backstage/FrontendPlugin",
  "@backstage/FrontendModule",
]);

/**
 * Put an entry-point name into one form so the two sides can be compared.
 *
 * `backstage.features` keys are `./`-prefixed (`"./alpha"`, or `"."` for the root) while
 * manifests expose bare names (`"alpha"`, `"."`). Normalising both ways round rather than
 * stripping one side means a manifest that does emit the prefixed form still matches — the
 * alternative silently reports a correctly-migrated package as exposing nothing.
 */
function canonicalEntryPoint(name: string): string {
  return name === "." || name.startsWith("./") ? name : `./${name}`;
}

/**
 * What the module-federation half of a bundle actually declares.
 *
 * `servable` and `nfsFeatures` are deliberately separate, because they are two
 * independent failure modes and both are silent at runtime:
 *
 * - `servable: false` — the remotes router in @backstage/backend-dynamic-feature-service
 *   logs the reason and `continue`s, so `GET /.backstage/dynamic-features/remotes`
 *   answers `200 []`. The app boots clean with no plugins.
 * - `nfsFeaturesExposed: []` — the router serves the remote, but nothing the new
 *   frontend system can mount is reachable through it, so the loader
 *   `console.debug`-skips every module. Also a clean boot with no plugins.
 *
 * Only the first is an artifact defect. The second is upstream migration state: a
 * plugin can legitimately ship a module-federation bundle for the legacy path while
 * exposing no NFS entry point yet.
 */
export type MfRemoteInfo = {
  /** `name` from mf-manifest.json — the MF host registers the remote under this. */
  name: string | null;
  /** `metaData.remoteEntry.name` — the asset the host fetches. */
  remoteEntry: string | null;
  /** Module names the remote exposes. */
  exposes: string[];
  /** Entry points whose `backstage.features` type the new frontend system mounts. */
  nfsFeatures: string[];
  /**
   * Why `backstage.features` could not be read, when it could not. Null normally.
   *
   * Without this, an I/O failure and a package that genuinely declares nothing are the
   * same record — `nfsFeatures: []` with `servable: true` — and both this file's own
   * consumers and anyone reading results.json would derive the same verdict from either.
   * The field exists so a failure to look is never recorded as a finding.
   */
  nfsFeaturesError: string | null;
  /**
   * The subset of `nfsFeatures` the manifest actually exposes. Declaring a feature the
   * remote does not expose leaves nothing for NFS to resolve, and neither `servable`
   * nor `nfsFeatures` shows it on its own — so this is the field to judge "will NFS
   * mount anything" by.
   */
  nfsFeaturesExposed: string[];
  /** Whether the remotes router will serve this remote rather than skipping it. */
  servable: boolean;
};

/**
 * The Scalprum plugin manifest as `@openshift/dynamic-plugin-sdk` reads it.
 *
 * The legacy half used to be a bare presence check, which passes on a manifest that
 * cannot load anything. RHDHBUGS-2180 is the bug this exists for, and both of the faults
 * below reproduce it: they are silent at runtime — the app boots,
 * nothing errors, and every configured frontend surface is simply absent:
 *
 * - a `loadScripts` entry with no matching asset: the host fetches a 404 and the plugin's
 *   registration callback never runs, so it contributes nothing. Configured routes 404.
 * - `name` missing: RHDH matches `dynamicPlugins.frontend.<key>` in app-config against
 *   this name, so without it no mount point can ever be addressed.
 *
 * The extension count and `registrationMethod` are RECORDED but never failed on — see
 * {@link ScalprumInfo.extensionCount}.
 */
export type ScalprumInfo = {
  /** `name` from plugin-manifest.json. */
  name: string | null;
  /**
   * How many extensions the manifest declares statically. Named for what it holds — a
   * count, not the list — because beside `loadScripts` in results.json a bare
   * `extensions: 0` reads as though the array itself were being published. Null when
   * `extensions` is not an array at all, which the SDK's own schema rejects.
   *
   * Zero is NOT a defect and must never fail the harness. `@red-hat-developer-hub/cli`
   * constructs its `DynamicRemotePlugin` with a literal `extensions: []`
   * (lib/bundler/scalprumConfig.cjs.js), so every bundle this repo publishes reports 0 —
   * 76 of 76 across the catalog as published today. The SDK agrees: its `RemotePluginManifest`
   * schema is `z.array(extensionSchema)` with no `.nonempty()`, while `loadScripts` is
   * `.nonempty()`. With `registrationMethod: "callback"` the plugin registers at runtime
   * through the Scalprum callback and RHDH drives its surfaces from app-config mount
   * points, so a static extension list is not where anything is declared. Failing on the
   * empty array would fail the entire catalogue and could never go green.
   */
  extensionCount: number | null;
  /** `callback` for everything RHDH publishes; `custom` is the SDK's other mode. */
  registrationMethod: string | null;
  /** Assets the host loads to initialise the plugin. */
  loadScripts: string[];
  /**
   * `loadScripts` entries that do not resolve to a file inside dist-scalprum/ — absent,
   * naming a directory, or escaping the bundle. Non-empty means the bundle is broken:
   * this is the check, the array is the evidence. The error message separates escaping
   * from absent; this field is the union, because either way nothing loads.
   */
  missingScripts: string[];
};

/** What became of one schema file the export writes beside a shipped bundle. */
export type ConfigSchemaState =
  | "ok"
  | "missing"
  | "unreadable"
  | "empty"
  /**
   * Present and non-empty, but shaped so the gatherer will not load it — missing
   * `$schema`, or a `type` other than `"object"`. Separate from `empty` because the
   * remedy differs: an empty schema means the export collected nothing, a malformed one
   * means it collected something unusable.
   *
   * Known limit: the gatherer also accepts a wrapped form, `backstageConfigSchemaVersion:
   * 1`, which it merges through `mergeConfigSchemas` BEFORE applying the guards above.
   * That form is not modelled here — `export-dynamic-plugin` never writes it, and judging
   * it would mean reimplementing the merge. A bundle shipping one would be reported
   * `invalid`; that is this function declining to guess, not a verdict on the artifact.
   */
  | "invalid";

/** Which host reads a given schema file, and therefore whether its absence matters here. */
export type ConfigSchemaConsumer =
  /**
   * What RHDH's own `schemaLocator` resolves to for this package's role. RHDH overrides
   * the upstream default in `packages/backend/src/index.ts`:
   *
   * ```ts
   * return path.join(platform === "node" ? "dist" : "dist-scalprum", "configSchema.json");
   * ```
   *
   * The locator is keyed on the package's ROLE, so the path differs by half:
   * `getRoleInfo("frontend-plugin").platform` is `"web"` and gives
   * `dist-scalprum/configSchema.json`, while both backend roles are `"node"` and give
   * `dist/configSchema.json` (verified by executing `@backstage/cli-node`, not inferred).
   * Whichever it resolves to, that is the file whose absence drops the plugin's config, so
   * it is the only one failed on.
   */
  | "rhdh"
  /**
   * `dist/.config-schema.json`, the default locator in
   * `@backstage/backend-dynamic-feature-service`. RHDH's override means it is never the
   * file RHDH reads, for either half — a backend package ships it beside RHDH's own
   * `dist/configSchema.json`, in the same directory and under a different name. It is
   * reported for a plain-Backstage host's benefit and never failed on: failing it would
   * reject an artifact over a file this platform ignores.
   */
  | "upstream-default";

export type ConfigSchemaFile = {
  /** Bundle-relative path, e.g. `dist-scalprum/configSchema.json`. */
  path: string;
  consumer: ConfigSchemaConsumer;
  state: ConfigSchemaState;
  /**
   * How many top-level `properties` keys the schema declares; null unless it was read.
   * Named for what it holds, for the reason {@link ScalprumInfo.extensionCount} is —
   * beside `path` and `state` in results.json, a bare `properties: 5` reads as though
   * the list of names were being published.
   */
  propertyCount: number | null;
};

/**
 * Whether a bundle that declares configuration actually ships a schema for it.
 *
 * Without a schema, Backstage's config loader has nothing to match the plugin's
 * app-config keys against and drops them without a word — the plugin runs on its
 * defaults while the operator's settings appear to be applied (RHDHBUGS-1157).
 *
 * `declared` is the whole reason this type is not just a boolean. The export merges the
 * package's own `configSchema` with every one it finds in the filtered dependency tree,
 * so an empty schema means "declares nothing" for most packages and "the declaration was
 * lost" for the ones that do declare — 33 of 76 in the catalogue declare, 32 ship an
 * empty schema, and only the intersection is a finding. Reporting an empty schema as a
 * defect without `declared` would accuse 32 packages of a bug they do not have.
 */
export type ConfigSchemaInfo = {
  /** `configSchema` present in the shipped package.json — Backstage's own signal. */
  declared: boolean;
  /**
   * Why `declared` could not be established, when it could not. Null normally.
   *
   * Without this, `declared: false` means both "ships no configuration" and "we could not
   * read package.json to find out", and results.json publishes the second as the first —
   * the mistake `mf.nfsFeaturesError` exists to prevent, and which REPORT_SCHEMA_VERSION 5
   * was bumped to fix on the other half of this same record.
   */
  declaredError: string | null;
  /**
   * One entry per path the export writes, each tagged with the host that reads it. Only
   * the `rhdh` one can fail — see {@link ConfigSchemaConsumer}.
   *
   * Note what `ok` does and does not establish. The export writes the schema MERGED across
   * the package and its filtered dependency tree, so `ok` means some schema survived, not
   * that this plugin's own keys did: a declaring package whose `config.d.ts` was lost still
   * reports `ok` as soon as one dependency contributed a property. 11 of the 76 published
   * packages ship a non-empty schema built purely from dependencies. Proving the plugin's
   * own keys are present would mean compiling its config.d.ts, which is the export's job,
   * not this harness's — so the check catches the total loss, which is what 1157 was.
   */
  files: ConfigSchemaFile[];
};

/**
 * What inspecting a backend bundle establishes.
 *
 * Only the one field, because everything else a backend artifact must satisfy is already
 * proven by loading and booting it — see {@link BackendBundleInfo}. Shaped like
 * FrontendBundleResult so the two halves are wired into the report the same way.
 */
export type BackendBundleResult = {
  configSchema: ConfigSchemaInfo;
  error: string | null;
};

export type FrontendBundleResult = {
  systems: FrontendSystem[];
  /**
   * Present whenever dist/mf-manifest.json exists. An unparseable one still yields an
   * `mf` — blank, with `servable: false` — so the reason travels with the failure.
   */
  mf: MfRemoteInfo | null;
  /** Present whenever dist-scalprum/plugin-manifest.json exists. */
  scalprum: ScalprumInfo | null;
  /** Always present: "declares no configuration" is itself a reportable answer. */
  configSchema: ConfigSchemaInfo;
  error: string | null;
};

/**
 * Read the NFS-recognised entry points a package declares in backstage.features.
 *
 * Returns the read failure rather than an empty list, because an empty list is a
 * *verdict* downstream — `describeNfsShortfall` reads it as "declares no
 * backstage.features". Deriving that from an I/O error would state a fact about the
 * artifact that nobody established.
 */
function readNfsFeatures(pluginPath: string): {
  features: string[];
  error: string | null;
} {
  try {
    const pkg = JSON.parse(
      readFileSync(join(pluginPath, "package.json"), "utf8"),
    );
    const features: unknown = pkg?.backstage?.features;
    if (typeof features !== "object" || features === null) {
      return { features: [], error: null };
    }
    const declared = Object.entries(features as Record<string, unknown>)
      .filter(
        ([, type]) => typeof type === "string" && NFS_FEATURE_TYPES.has(type),
      )
      .map(([entryPoint]) => entryPoint);
    return { features: declared, error: null };
  } catch (err) {
    // Unreachable for malformed JSON — discoverPlugins skips those and warns before this
    // runs — so this is a real I/O error, which means the artifact cannot be judged at all.
    // Warn loudly, matching discoverPlugins' handling of the same class of problem, and
    // report the failure so no NFS verdict is derived from it.
    const detail = `could not read package.json (${errorMessage(err)})`;
    console.warn(`⚠ ${detail} in '${pluginPath}'`);
    return { features: [], error: detail };
  }
}

/** The manifest fields the router and the MF runtime each care about. */
type MfManifestFields = {
  name: string | null;
  remoteEntry: string | null;
  /** `metaData.remoteEntry.path` — "" for a root-level entry. */
  remoteEntryDir: string;
  /** Null when `exposes` is not an array at all, which the router rejects outright. */
  exposesRaw: unknown[] | null;
  /** Whether every entry satisfies the router's per-entry predicate. */
  exposesAllNamed: boolean;
  /** The usable module names, for the NFS intersection. */
  exposes: string[];
};

function readManifestFields(manifest: unknown): MfManifestFields {
  const parsed = (manifest ?? {}) as {
    name?: unknown;
    metaData?: { remoteEntry?: { name?: unknown; path?: unknown } };
    exposes?: unknown;
  };
  const name =
    typeof parsed.name === "string" && parsed.name ? parsed.name : null;
  const remoteEntryName = parsed.metaData?.remoteEntry?.name;
  const remoteEntryPath = parsed.metaData?.remoteEntry?.path;
  const exposesRaw = Array.isArray(parsed.exposes) ? parsed.exposes : null;
  return {
    name,
    remoteEntry:
      typeof remoteEntryName === "string" && remoteEntryName
        ? remoteEntryName
        : null,
    remoteEntryDir: typeof remoteEntryPath === "string" ? remoteEntryPath : "",
    exposesRaw,
    // Mirrors the router's own predicate. Note it does NOT require the list to be
    // non-empty — `[]` is truthy, is an array, and `[].every()` is vacuously true, so an
    // empty exposes list is served. Requiring non-empty would fail an artifact that works.
    exposesAllNamed:
      exposesRaw?.every(
        (e) => e !== null && typeof e === "object" && "name" in e,
      ) ?? false,
    exposes: (exposesRaw ?? [])
      .map((e) => (e as { name?: unknown })?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0),
  };
}

/**
 * The guards in the remotes router itself. Only these may set `servable: false` — that
 * field is documented as the router's verdict, so folding anything else into it would put
 * a false value in the one signal `results.json` publishes as such.
 */
function findRouterGuardProblems(fields: MfManifestFields): string[] {
  const problems: string[] = [];
  if (!fields.name) problems.push("`name` missing");
  if (!fields.remoteEntry) {
    problems.push("`metaData.remoteEntry.name` missing");
  }
  if (!fields.exposesRaw) problems.push("`exposes` is not an array");
  else if (!fields.exposesAllNamed) {
    problems.push("`exposes` has an entry without a `name`");
  }
  return problems;
}

/**
 * Faults the router does not check. On the default path `getRemoteEntryType()` returns
 * "manifest", so the router probes mf-manifest.json itself and never reads
 * `metaData.remoteEntry.path` — it serves these remotes, and the breakage surfaces in the
 * browser's Module Federation runtime instead.
 */
function findBundleAssetProblems(
  pluginPath: string,
  fields: MfManifestFields,
): string[] {
  if (!fields.remoteEntry) return [];
  const rel = join(fields.remoteEntryDir, fields.remoteEntry);
  // `path` is untrusted: it comes from JSON inside a published OCI artifact. Contain it
  // before touching the filesystem, per the rule src/paths.ts documents — otherwise a
  // manifest declaring `../../..` probes outside its own bundle.
  const distDir = join(pluginPath, "dist");
  const resolved = resolveContained(rel, distDir);
  if (!resolved) {
    return [
      `metaData.remoteEntry path '${rel}' escapes the bundle's dist/ directory`,
    ];
  }
  if (!existsSync(resolved)) {
    return [
      `remote entry asset dist/${relative(distDir, resolved)} not present ` +
        `(needed by the MF runtime)`,
    ];
  }
  return [];
}

/**
 * Inspect the module-federation manifest, reporting why a remote would be skipped rather
 * than a bare boolean — a skipped remote is invisible at runtime, so the reason is the
 * whole value of this check.
 */
function inspectMfRemote(pluginPath: string): {
  mf: MfRemoteInfo;
  error: string | null;
} {
  const { features: nfsFeatures, error: featuresError } =
    readNfsFeatures(pluginPath);

  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(join(pluginPath, "dist/mf-manifest.json"), "utf8"),
    );
  } catch (err) {
    return {
      mf: {
        name: null,
        remoteEntry: null,
        exposes: [],
        nfsFeatures,
        nfsFeaturesError: featuresError,
        nfsFeaturesExposed: [],
        servable: false,
      },
      error: `dist/mf-manifest.json is not valid JSON (${errorMessage(err)})`,
    };
  }

  const fields = readManifestFields(manifest);
  const routerProblems = findRouterGuardProblems(fields);
  const bundleProblems = [
    ...(featuresError ? [featuresError] : []),
    ...findBundleAssetProblems(pluginPath, fields),
  ];
  const exposedSet = new Set(fields.exposes.map(canonicalEntryPoint));

  const mf: MfRemoteInfo = {
    name: fields.name,
    remoteEntry: fields.remoteEntry,
    exposes: fields.exposes,
    nfsFeatures,
    nfsFeaturesError: featuresError,
    nfsFeaturesExposed: nfsFeatures.filter((f) =>
      exposedSet.has(canonicalEntryPoint(f)),
    ),
    servable: routerProblems.length === 0,
  };
  const messages = [
    routerProblems.length
      ? `dist/mf-manifest.json would be skipped by the remotes router: ${routerProblems.join(", ")}`
      : null,
    bundleProblems.length
      ? // Deliberately does not claim the remote is servable: when the router guards also
        // failed, both messages appear together and "servable but broken" contradicts the
        // first half. Whether it is servable is `mf.servable`, not this string's job.
        `dist/mf-manifest.json has bundle problems: ${bundleProblems.join(", ")}`
      : null,
  ].filter((m): m is string => m !== null);
  return { mf, error: messages.length ? messages.join("; ") : null };
}

/**
 * Inspect the Scalprum manifest, reporting the faults that make a present bundle
 * unusable. See {@link ScalprumInfo} for why `extensions` is not among them.
 */
function inspectScalprum(pluginPath: string): {
  scalprum: ScalprumInfo;
  error: string | null;
} {
  const scalprumDir = join(pluginPath, "dist-scalprum");
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(join(scalprumDir, "plugin-manifest.json"), "utf8"),
    );
  } catch (err) {
    // The old check only asked whether this file existed, so a truncated or
    // half-written one passed as a valid legacy bundle.
    return {
      scalprum: {
        name: null,
        extensionCount: null,
        registrationMethod: null,
        loadScripts: [],
        missingScripts: [],
      },
      error: `dist-scalprum/plugin-manifest.json is not valid JSON (${errorMessage(err)})`,
    };
  }

  const fields = readScalprumFields(manifest, scalprumDir);
  const problems = findScalprumProblems(fields);
  return {
    scalprum: fields.scalprum,
    error: problems.length
      ? `dist-scalprum/plugin-manifest.json is unusable: ${problems.join("; ")}`
      : null,
  };
}

/**
 * Whether `path` names a regular file.
 *
 * `statSync` rather than `existsSync` because a directory the bundle does ship (`static/`)
 * exists but is not a script the host can load. Wrapped, because unlike `existsSync` it
 * THROWS on a path Node rejects outright — ERR_INVALID_ARG_VALUE for an embedded NUL,
 * ENAMETOOLONG for an over-long name — and `throwIfNoEntry: false` suppresses only ENOENT.
 * These paths come from JSON inside a published OCI artifact, so one malformed entry would
 * otherwise escape validateFrontendBundle to native-smoke's outer catch and collapse the
 * whole workspace into `status: error`, discarding every other plugin's result.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** The Scalprum manifest fields, plus what the raw `loadScripts` looked like. */
type ScalprumFields = {
  scalprum: ScalprumInfo;
  /** Null when `loadScripts` is not an array at all, which the SDK's schema rejects. */
  loadScriptsRaw: unknown[] | null;
  /** Entries that resolve outside dist-scalprum/ — a different fault from an absent one. */
  escaping: string[];
};

function readScalprumFields(
  manifest: unknown,
  scalprumDir: string,
): ScalprumFields {
  const parsed = (manifest ?? {}) as {
    name?: unknown;
    extensions?: unknown;
    registrationMethod?: unknown;
    loadScripts?: unknown;
  };
  const loadScriptsRaw = Array.isArray(parsed.loadScripts)
    ? parsed.loadScripts
    : null;
  // Only non-empty strings survive, the same way readManifestFields keeps only `exposes`
  // entries with a usable `name`. Keeping the rest would defeat the check below rather
  // than widen it: `resolveContained("")` returns dist-scalprum/ itself, which exists, so
  // a manifest listing `""` would be reported as having every asset it needs.
  const loadScripts = (loadScriptsRaw ?? []).filter(
    (script): script is string =>
      typeof script === "string" && script.length > 0,
  );
  // Each entry is untrusted JSON from inside a published OCI artifact, so contain it
  // before touching the filesystem — the rule src/paths.ts documents, applied here for
  // the same reason findBundleAssetProblems applies it to metaData.remoteEntry.path.
  // Resolved once per entry: `escaping` and `missingScripts` are two readings of the same
  // resolution, and doing it twice invited them to drift apart.
  const resolved = loadScripts.map((script) => ({
    script,
    full: resolveContained(script, scalprumDir),
  }));
  const escaping = resolved
    .filter((entry) => !entry.full)
    .map((entry) => entry.script);
  return {
    scalprum: {
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : null,
      extensionCount: Array.isArray(parsed.extensions)
        ? parsed.extensions.length
        : null,
      registrationMethod:
        typeof parsed.registrationMethod === "string"
          ? parsed.registrationMethod
          : null,
      loadScripts,
      missingScripts: resolved
        .filter((entry) => !entry.full || !isFile(entry.full))
        .map((entry) => entry.script),
    },
    loadScriptsRaw,
    escaping,
  };
}

function findScalprumProblems(fields: ScalprumFields): string[] {
  const { scalprum, loadScriptsRaw, escaping } = fields;
  const problems: string[] = [];
  if (!scalprum.name) {
    problems.push(
      "`name` missing — RHDH matches app-config `dynamicPlugins.frontend.<key>` " +
        "against it, so no mount point can be addressed",
    );
  }
  if (scalprum.extensionCount === null) {
    problems.push("`extensions` is missing or not an array");
  }
  // Three distinct faults, reported apart for the reason findRouterGuardProblems keeps
  // "`exposes` is not an array" and "`exposes` has an entry without a `name`" apart:
  // "empty" sends a reader looking for a field that is in fact present and malformed.
  if (!loadScriptsRaw) {
    problems.push("`loadScripts` is not an array");
  } else if (loadScriptsRaw.length === 0) {
    problems.push(
      "`loadScripts` is empty — the host has nothing to fetch, so the plugin's " +
        "registration callback never runs",
    );
  } else if (scalprum.loadScripts.length !== loadScriptsRaw.length) {
    problems.push(
      "`loadScripts` has an entry that is not a non-empty asset name — it names " +
        "nothing for the host to fetch",
    );
  }
  // Escaping is called out separately from merely absent, as findBundleAssetProblems does
  // on the MF side: folding it into "not present in dist-scalprum/" sends the reader
  // looking inside the bundle for a name that was never bundle-relative.
  if (escaping.length > 0) {
    problems.push(
      `loadScripts entr(y/ies) escaping the bundle's dist-scalprum/ directory: ` +
        escaping.join(", "),
    );
  }
  // Independent of the checks above, so a manifest with one bad entry AND one absent
  // asset reports both rather than hiding the second behind the first.
  const absent = scalprum.missingScripts.filter(
    (script) => !escaping.includes(script),
  );
  if (absent.length > 0) {
    problems.push(
      `loadScripts asset(s) not present in dist-scalprum/: ${absent.join(", ")} — ` +
        `the host fetches a 404 and the plugin registers nothing, so every configured ` +
        `route answers 404`,
    );
  }
  return problems;
}

/**
 * What to say about a schema file that cannot be used. Keyed on every state EXCEPT `ok`,
 * so the exhaustive Record still forces a message for any state added later without
 * carrying a string for the one case that never reaches it.
 */
/** What RHDH's `schemaLocator` resolves to for a `frontend-plugin` role (platform "web"). */
const RHDH_FRONTEND_SCHEMA = "dist-scalprum/configSchema.json";
/**
 * The same locator for `backend-plugin` and `backend-plugin-module` (both platform
 * "node"). Note it is NOT the upstream default below: they sit in the same directory and
 * differ only by filename, which is exactly the pair a reader is likely to conflate.
 */
const RHDH_BACKEND_SCHEMA = "dist/configSchema.json";
/** The default locator in @backstage/backend-dynamic-feature-service, which RHDH overrides. */
const UPSTREAM_DEFAULT_SCHEMA = "dist/.config-schema.json";

const CONFIG_SCHEMA_FAULTS: Record<Exclude<ConfigSchemaState, "ok">, string> = {
  missing: "is not in the bundle",
  unreadable: "could not be read or parsed",
  empty: "declares no properties (the export collected an empty schema)",
  invalid:
    'is missing `$schema` or is not `type: "object"`, so the backend\'s schema ' +
    "gatherer rejects it",
};

/** Read one schema file the export wrote, classifying why it cannot be used. */
function readConfigSchemaFile(
  pluginPath: string,
  rel: string,
  consumer: ConfigSchemaConsumer,
): ConfigSchemaFile {
  const file = (
    state: ConfigSchemaState,
    propertyCount: number | null,
  ): ConfigSchemaFile => ({ path: rel, consumer, state, propertyCount });
  const full = join(pluginPath, rel);
  if (!existsSync(full)) return file("missing", null);
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(full, "utf8"));
  } catch {
    // Covers an I/O failure as well as a parse failure, which is why the message says
    // "could not be read or parsed" rather than naming JSON: an EACCES reported as
    // malformed JSON sends a reader after the wrong defect.
    return file("unreadable", null);
  }

  const parsed = schema as {
    properties?: unknown;
    $schema?: unknown;
    type?: unknown;
  };
  const properties = parsed?.properties;
  // Array.isArray is not redundant with the typeof: `typeof [] === "object"`, so
  // `{"properties": ["a"]}` would otherwise count 1. A JSON Schema's `properties` must be
  // an object; an array declares nothing.
  const count =
    typeof properties === "object" &&
    properties !== null &&
    !Array.isArray(properties)
      ? Object.keys(properties).length
      : 0;

  // `empty` mirrors the gatherer's own `isEmpty(serialized)` over the WHOLE document, not
  // a count of top-level `properties`. Counting was stricter than the consumer: a schema
  // declaring its keys through `patternProperties`, `additionalProperties` or `allOf` has
  // no top-level `properties` and would have been failed for a bundle RHDH loads fine.
  // This function mirrors the consumer's guards; it does not referee JSON Schema.
  if (
    schema === null ||
    (typeof schema === "object" && Object.keys(schema).length === 0)
  ) {
    return file("empty", 0);
  }
  // The gatherer's last guard, mirrored: `if (!serialized?.$schema || serialized?.type
  // !== "object")` it logs and skips. Unlike the conditions above this one is not silent —
  // it writes "Serialized configuration schema is invalid for plugin X" — but the outcome
  // is identical, the config is dropped, and a line in a backend log is not meaningfully
  // louder than nothing for an artifact published weeks earlier. No published schema
  // reaches this state today: the 64 that would fail it are literally `{}` and are
  // classified `empty` first.
  // One condition, because the gatherer's is one condition and nothing downstream
  // distinguishes which half failed — splitting it produced two identical returns and
  // drifted from the guard this claims to mirror.
  if (
    typeof parsed?.$schema !== "string" ||
    !parsed.$schema ||
    parsed?.type !== "object"
  ) {
    return file("invalid", count);
  }
  return file("ok", count);
}

/**
 * Check that a bundle declaring configuration actually ships a schema for it.
 *
 * `rhdhSchema` is the path RHDH's own `schemaLocator` resolves to for this package's
 * role — see {@link ConfigSchemaConsumer}. It is the caller's job because the role lives
 * on the PluginEntry and this function only ever sees a directory; passing the wrong one
 * would check a file the host never reads, which is the failure mode the frontend half
 * shipped with and had to fix.
 *
 * The messages are worded so a reader cannot mistake one case for the other: a package
 * that declares nothing is not a finding at all and produces no message, while a package
 * that declares `configSchema` and ships an empty schema is the RHDHBUGS-1157 defect —
 * the export's schema collection resolves dependencies inside an empty `catch {}`, so a
 * declaration it fails to resolve is dropped with no error anywhere.
 */
function inspectConfigSchema(
  pluginPath: string,
  rhdhSchema: string,
): {
  configSchema: ConfigSchemaInfo;
  error: string | null;
} {
  let declared = false;
  let readError: string | null = null;
  try {
    const pkg = JSON.parse(
      readFileSync(join(pluginPath, "package.json"), "utf8"),
    );
    declared = pkg !== null && typeof pkg === "object" && "configSchema" in pkg;
  } catch (err) {
    // Same class as readNfsFeatures': a failure to look must never be recorded as a fact
    // about the artifact, so `declaredError` carries it and no verdict is derived from
    // `declared: false`. Unlike that one this does NOT warn, because the message is always
    // returned and becomes the bundle's ERROR, which is louder than a warning; on a dual
    // bundle readNfsFeatures additionally warns for the identical cause on the identical
    // file, and a second line there would be noise rather than loudness.
    readError = `could not read package.json for configSchema (${errorMessage(err)})`;
  }

  // RHDH's file is NOT gated on its directory existing. That gate mirrored the export CLI
  // and left the failure this check exists for wide open: an NFS-only bundle ships no
  // dist-scalprum/ at all, so the gate skipped the very file RHDH looks for, and a package
  // declaring configSchema passed while RHDH dropped its config in silence — RHDHBUGS-1157
  // on the NFS lane. Absence of RHDH's file IS the fault, so it is always read.
  const files: ConfigSchemaFile[] = [
    readConfigSchemaFile(pluginPath, rhdhSchema, "rhdh"),
  ];
  // The upstream default is only meaningful when a dist/ exists to hold it, and is
  // reported rather than failed — see ConfigSchemaConsumer. For a backend package that
  // dist/ is the same directory RHDH's own file lives in, so both entries are present
  // and differ only by filename.
  if (existsSync(join(pluginPath, "dist"))) {
    files.push(
      readConfigSchemaFile(
        pluginPath,
        UPSTREAM_DEFAULT_SCHEMA,
        "upstream-default",
      ),
    );
  }
  const configSchema: ConfigSchemaInfo = {
    declared,
    declaredError: readError,
    files,
  };
  if (readError) return { configSchema, error: readError };
  // Not declaring configuration is a legitimate state, not a shortfall: 43 of the 76
  // published frontend packages are in it, and the backend half is no different. Only a
  // declaration with nothing behind it is a defect, so the check is gated on `declared`
  // rather than on the schema alone.
  if (!declared) return { configSchema, error: null };

  // Only RHDH's own path can fail. Failing the upstream-default copy would reject an
  // artifact over a file this platform never reads.
  const problems = files.flatMap((file) =>
    file.consumer !== "rhdh" || file.state === "ok"
      ? []
      : [`${file.path} ${CONFIG_SCHEMA_FAULTS[file.state]}`],
  );
  return {
    configSchema,
    error: problems.length
      ? `package.json declares \`configSchema\` but ${problems.join("; ")} — ` +
        `Backstage has no schema to match this plugin's app-config keys against, so ` +
        `they are dropped silently and the plugin runs on its defaults`
      : null,
  };
}

/**
 * Check a backend plugin's bundle for the one fault a successful boot cannot reveal.
 *
 * A backend plugin whose `configSchema` declaration lost its schema on the way out still
 * `require()`s, still exposes its BackendFeature and still starts — RHDH just drops every
 * app-config key the plugin declares, so it runs on its defaults while the operator's
 * settings look applied. That is RHDHBUGS-1157, and nothing about it is frontend-specific:
 * `export-dynamic-plugin` writes the schema for backend roles too, and RHDH's
 * `schemaLocator` reads `dist/configSchema.json` for them.
 *
 * The bundle is not loaded here. This runs over every DISCOVERED backend plugin, including
 * ones a boot exclusion keeps out of {@link loadBackendPlugins} — the exclusion is about
 * booting, and the files are on disk regardless.
 */
export function validateBackendBundle(
  plugin: PluginEntry,
): BackendBundleResult {
  return inspectConfigSchema(plugin.path, RHDH_BACKEND_SCHEMA);
}

/**
 * Check a frontend plugin's bundle artifacts for at least one frontend system:
 * - legacy frontend system: `dist-scalprum/` + `plugin-manifest.json` (Scalprum)
 * - new frontend system: `dist/mf-manifest.json` (a module-federation remote, loaded by
 *   @backstage/frontend-dynamic-feature-loader). The manifest alone is the marker — the
 *   router serves it as the entry, so the asset it names need not be `remoteEntry.js`.
 *
 * Dual-system plugins (e.g. tech-radar) ship both layouts; new-system-only plugins
 * (e.g. app-auth) ship only the module-federation one. A present-but-incomplete
 * layout is an error even when the other system's layout is valid — the artifact
 * advertises a system it can't deliver.
 *
 * Both halves validate the manifest's SHAPE, not just its presence, because presence is
 * what let two silent customer bugs through — RHDHBUGS-2180 and RHDHBUGS-1157: the
 * remotes router skips a malformed
 * mf-manifest.json with a log line and still answers `200 []`, and the Scalprum host
 * fetches whatever `loadScripts` names, so an absent asset 404s and the plugin's
 * registration callback never runs. Either reaches the browser as an app that boots
 * cleanly with the plugin simply not there. See {@link MfRemoteInfo} for why servability
 * and NFS feature types are reported apart, and {@link ScalprumInfo} for why an empty
 * `extensions` array is reported but never failed on.
 *
 * Independently of the layouts, a bundle whose package.json declares `configSchema` must
 * ship the schema the export writes for it — see {@link ConfigSchemaInfo}. The bundle
 * itself is never loaded or evaluated.
 */
export function validateFrontendBundle(
  plugin: PluginEntry,
): FrontendBundleResult {
  const has = (rel: string) => existsSync(join(plugin.path, rel));
  const noBundle: ConfigSchemaInfo = {
    declared: false,
    declaredError: null,
    files: [],
  };
  if (!has("package.json")) {
    return {
      systems: [],
      mf: null,
      scalprum: null,
      configSchema: noBundle,
      error: "missing package.json",
    };
  }

  // Probe BOTH layouts before returning. Bailing out on the first broken one left
  // `systems` empty, so a dual-shipping bundle with a broken Scalprum manifest was
  // reported as shipping neither system — corrupting the migration panel the sweep
  // exists to keep fresh, on top of the (correct) error.
  const systems: FrontendSystem[] = [];
  const problems: string[] = [];
  let mf: MfRemoteInfo | null = null;
  let scalprum: ScalprumInfo | null = null;

  if (has("dist-scalprum")) {
    if (has("dist-scalprum/plugin-manifest.json")) {
      systems.push("legacy");
      // Presence is not enough here either, for the same reason it was not enough for
      // mf-manifest.json: an unusable manifest boots the app clean with the plugin
      // simply absent. See ScalprumInfo.
      const inspected = inspectScalprum(plugin.path);
      scalprum = inspected.scalprum;
      if (inspected.error) problems.push(inspected.error);
    } else {
      problems.push("dist-scalprum/ found but missing plugin-manifest.json");
    }
  }
  // Gate on the manifest, not on a file literally named remoteEntry.js: the router's
  // default `getRemoteEntryType()` is "manifest", so it serves mf-manifest.json as the
  // entry and the actual asset can be named anything the manifest declares.
  if (has("dist/mf-manifest.json")) {
    systems.push("new-frontend-system");
    const inspected = inspectMfRemote(plugin.path);
    mf = inspected.mf;
    if (inspected.error) problems.push(inspected.error);
  } else if (has("dist/remoteEntry.js")) {
    problems.push(
      "dist/remoteEntry.js found but missing dist/mf-manifest.json",
    );
  }

  // Runs regardless of which layouts validated: a bundle that declares configuration and
  // ships no schema for it is a defect on its own, and the app-config keys it silently
  // drops are dropped whether or not anything else about the bundle is wrong.
  const schema = inspectConfigSchema(plugin.path, RHDH_FRONTEND_SCHEMA);
  if (schema.error) problems.push(schema.error);
  const result = { systems, mf, scalprum, configSchema: schema.configSchema };

  // Shipping no recognised layout is its own fault and is reported ALONGSIDE any others,
  // not instead of them. Returning early on `problems` swallowed it whenever a
  // configSchema fault was present — and that fault is layout-independent, so the pair
  // occurs together, leaving `systems: []` in results.json with nothing explaining it.
  const allProblems = [
    ...(systems.length === 0
      ? [
          "no frontend bundle found — needs dist-scalprum/ (legacy frontend system) " +
            "and/or dist/mf-manifest.json (new frontend system)",
        ]
      : []),
    ...problems,
  ];
  return {
    ...result,
    error: allProblems.length ? allProblems.join("; ") : null,
  };
}
