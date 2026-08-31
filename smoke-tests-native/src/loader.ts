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

import { readFileSync, existsSync, readdirSync } from "node:fs";
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
 * cannot load anything. Both bugs this exists for are silent at runtime — the app boots,
 * nothing errors, and every configured frontend surface is simply absent:
 *
 * - a `loadScripts` entry with no matching asset: the host fetches a 404 and the plugin's
 *   registration callback never runs, so it contributes nothing. Configured routes 404.
 * - `name` missing: RHDH matches `dynamicPlugins.frontend.<key>` in app-config against
 *   this name, so without it no mount point can ever be addressed.
 *
 * `extensions` and `registrationMethod` are RECORDED but never failed on — see
 * {@link ScalprumInfo.extensions}.
 */
export type ScalprumInfo = {
  /** `name` from plugin-manifest.json. */
  name: string | null;
  /**
   * How many extensions the manifest declares statically. Null when `extensions` is not
   * an array at all, which the SDK's own schema rejects.
   *
   * Zero is NOT a defect and must never fail the harness. `@red-hat-developer-hub/cli`
   * constructs its `DynamicRemotePlugin` with a literal `extensions: []`
   * (lib/bundler/scalprumConfig.cjs.js), so every bundle this repo publishes reports 0 —
   * 76 of 76 across the catalog at bs_1.52.0. The SDK agrees: its `RemotePluginManifest`
   * schema is `z.array(extensionSchema)` with no `.nonempty()`, while `loadScripts` is
   * `.nonempty()`. With `registrationMethod: "callback"` the plugin registers at runtime
   * through the Scalprum callback and RHDH drives its surfaces from app-config mount
   * points, so a static extension list is not where anything is declared. Failing on the
   * empty array would fail the entire catalogue and could never go green.
   */
  extensions: number | null;
  /** `callback` for everything RHDH publishes; `custom` is the SDK's other mode. */
  registrationMethod: string | null;
  /** Assets the host loads to initialise the plugin. */
  loadScripts: string[];
  /**
   * `loadScripts` entries with no matching file in dist-scalprum/. Non-empty means the
   * bundle is broken: this is the check, the array is the evidence.
   */
  missingScripts: string[];
};

/** What became of one schema file the export writes beside a shipped bundle. */
export type ConfigSchemaState = "ok" | "missing" | "unreadable" | "empty";

export type ConfigSchemaFile = {
  /** Bundle-relative path, e.g. `dist-scalprum/configSchema.json`. */
  path: string;
  state: ConfigSchemaState;
  /** Top-level `properties` keys the schema declares; null unless it was read. */
  properties: number | null;
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
 * lost" for the ones that do declare — 33 of 76 in the catalogue declare, 31 ship an
 * empty schema, and only the intersection is a finding. Reporting an empty schema as a
 * defect without `declared` would accuse 31 packages of a bug they do not have.
 */
export type ConfigSchemaInfo = {
  /** `configSchema` present in the shipped package.json — Backstage's own signal. */
  declared: boolean;
  /** One entry per path the export CLI writes for the layouts this bundle ships. */
  files: ConfigSchemaFile[];
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
  const blank: ScalprumInfo = {
    name: null,
    extensions: null,
    registrationMethod: null,
    loadScripts: [],
    missingScripts: [],
  };

  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(join(scalprumDir, "plugin-manifest.json"), "utf8"),
    );
  } catch (err) {
    // The old check only asked whether this file existed, so a truncated or
    // half-written one passed as a valid legacy bundle.
    return {
      scalprum: blank,
      error: `dist-scalprum/plugin-manifest.json is not valid JSON (${errorMessage(err)})`,
    };
  }

  const parsed = (manifest ?? {}) as {
    name?: unknown;
    extensions?: unknown;
    registrationMethod?: unknown;
    loadScripts?: unknown;
  };
  const loadScripts = Array.isArray(parsed.loadScripts)
    ? parsed.loadScripts.filter((s): s is string => typeof s === "string")
    : [];
  const scalprum: ScalprumInfo = {
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : null,
    extensions: Array.isArray(parsed.extensions)
      ? parsed.extensions.length
      : null,
    registrationMethod:
      typeof parsed.registrationMethod === "string"
        ? parsed.registrationMethod
        : null,
    loadScripts,
    // Each entry is untrusted JSON from inside a published OCI artifact, so contain it
    // before touching the filesystem — the rule src/paths.ts documents, applied here for
    // the same reason findBundleAssetProblems applies it to metaData.remoteEntry.path.
    missingScripts: loadScripts.filter((script) => {
      const resolved = resolveContained(script, scalprumDir);
      return !resolved || !existsSync(resolved);
    }),
  };

  const problems: string[] = [];
  if (!scalprum.name) {
    problems.push(
      "`name` missing — RHDH matches app-config `dynamicPlugins.frontend.<key>` " +
        "against it, so no mount point can be addressed",
    );
  }
  if (scalprum.extensions === null)
    problems.push("`extensions` is not an array");
  if (loadScripts.length === 0) {
    problems.push(
      "`loadScripts` is empty — the host has nothing to fetch, so the plugin's " +
        "registration callback never runs",
    );
  } else if (scalprum.missingScripts.length > 0) {
    problems.push(
      `loadScripts asset(s) not present in dist-scalprum/: ` +
        `${scalprum.missingScripts.join(", ")} — the host fetches a 404 and the plugin ` +
        `registers nothing, so every configured route answers 404`,
    );
  }
  return {
    scalprum,
    error: problems.length
      ? `dist-scalprum/plugin-manifest.json is unusable: ${problems.join("; ")}`
      : null,
  };
}

/** Read one schema file the export wrote, classifying why it cannot be used. */
function readConfigSchemaFile(
  pluginPath: string,
  rel: string,
): ConfigSchemaFile {
  const full = join(pluginPath, rel);
  if (!existsSync(full))
    return { path: rel, state: "missing", properties: null };
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(full, "utf8"));
  } catch {
    return { path: rel, state: "unreadable", properties: null };
  }
  const properties = (schema as { properties?: unknown })?.properties;
  const count =
    typeof properties === "object" && properties !== null
      ? Object.keys(properties).length
      : 0;
  return { path: rel, state: count > 0 ? "ok" : "empty", properties: count };
}

/**
 * Check that a bundle declaring configuration actually ships a schema for it.
 *
 * The two paths mirror `export-dynamic-plugin`'s own: it writes
 * `dist-scalprum/configSchema.json` when dist-scalprum/ exists and
 * `dist/.config-schema.json` when dist/ does (note the different filename), so a bundle
 * is checked on exactly the layouts it ships.
 *
 * The messages are worded so a reader cannot mistake one case for the other: a package
 * that declares nothing is not a finding at all and produces no message, while a package
 * that declares `configSchema` and ships an empty schema is the RHDHBUGS-1157 defect —
 * the export's schema collection resolves dependencies inside an empty `catch {}`, so a
 * declaration it fails to resolve is dropped with no error anywhere.
 */
function inspectConfigSchema(pluginPath: string): {
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
    // about the artifact, so nothing is claimed about its configuration. Unlike that one
    // this does NOT warn — the message is always returned and becomes the bundle's error,
    // and readNfsFeatures already warns for the identical root cause on the same file.
    // Two console lines for one unreadable package.json is noise, not loudness.
    readError = `could not read package.json for configSchema (${errorMessage(err)})`;
  }

  const files: ConfigSchemaFile[] = [];
  if (existsSync(join(pluginPath, "dist-scalprum"))) {
    files.push(
      readConfigSchemaFile(pluginPath, "dist-scalprum/configSchema.json"),
    );
  }
  if (existsSync(join(pluginPath, "dist"))) {
    files.push(readConfigSchemaFile(pluginPath, "dist/.config-schema.json"));
  }
  const configSchema: ConfigSchemaInfo = { declared, files };
  if (readError) return { configSchema, error: readError };
  // Not declaring configuration is a legitimate state, not a shortfall: 43 of the 76
  // published frontend packages are in it. Only a declaration with nothing behind it is
  // a defect, so the check is gated on `declared` rather than on the schema alone.
  if (!declared) return { configSchema, error: null };

  const problems = files
    .filter((file) => file.state !== "ok")
    .map((file) => `${file.path} ${CONFIG_SCHEMA_FAULTS[file.state]}`);
  return {
    configSchema,
    error: problems.length
      ? `package.json declares \`configSchema\` but ${problems.join("; ")} — ` +
        `Backstage has no schema to match this plugin's app-config keys against, so ` +
        `they are dropped silently and the plugin runs on its defaults`
      : null,
  };
}

const CONFIG_SCHEMA_FAULTS: Record<ConfigSchemaState, string> = {
  ok: "is valid",
  missing: "is not in the bundle",
  unreadable: "is not valid JSON",
  empty: "declares no properties (the export collected an empty schema)",
};

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
 * what let two silent customer bugs through: the remotes router skips a malformed
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
  const noBundle: ConfigSchemaInfo = { declared: false, files: [] };
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
  const schema = inspectConfigSchema(plugin.path);
  if (schema.error) problems.push(schema.error);
  const result = { systems, mf, scalprum, configSchema: schema.configSchema };

  if (problems.length) return { ...result, error: problems.join("; ") };
  if (systems.length === 0) {
    return {
      ...result,
      error:
        "no frontend bundle found — needs dist-scalprum/ (legacy frontend system) " +
        "and/or dist/mf-manifest.json (new frontend system)",
    };
  }
  return { ...result, error: null };
}
