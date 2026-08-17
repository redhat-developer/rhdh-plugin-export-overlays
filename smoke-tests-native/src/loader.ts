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
const NFS_FEATURE_TYPES: readonly string[] = [
  "@backstage/FrontendPlugin",
  "@backstage/FrontendModule",
];

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
   * The subset of `nfsFeatures` the manifest actually exposes. Declaring a feature the
   * remote does not expose leaves nothing for NFS to resolve, and neither `servable`
   * nor `nfsFeatures` shows it on its own — so this is the field to judge "will NFS
   * mount anything" by.
   */
  nfsFeaturesExposed: string[];
  /** Whether the remotes router will serve this remote rather than skipping it. */
  servable: boolean;
};

export type FrontendBundleResult = {
  systems: FrontendSystem[];
  /**
   * Present whenever dist/mf-manifest.json exists. An unparseable one still yields an
   * `mf` — blank, with `servable: false` — so the reason travels with the failure.
   */
  mf: MfRemoteInfo | null;
  error: string | null;
};

/** Read the NFS-recognised entry points a package declares in backstage.features. */
function readNfsFeatures(pluginPath: string): string[] {
  try {
    const pkg = JSON.parse(
      readFileSync(join(pluginPath, "package.json"), "utf8"),
    );
    const features: unknown = pkg?.backstage?.features;
    if (typeof features !== "object" || features === null) return [];
    return Object.entries(features as Record<string, unknown>)
      .filter(
        ([, type]) =>
          typeof type === "string" && NFS_FEATURE_TYPES.includes(type),
      )
      .map(([entryPoint]) => entryPoint);
  } catch {
    return [];
  }
}

/**
 * Validate the module-federation manifest against what the remotes router requires,
 * returning the reason it would be skipped rather than a bare boolean — a skipped
 * remote is invisible at runtime, so the reason is the whole value of this check.
 */
function inspectMfRemote(pluginPath: string): {
  mf: MfRemoteInfo;
  error: string | null;
} {
  const nfsFeatures = readNfsFeatures(pluginPath);
  const blank: MfRemoteInfo = {
    name: null,
    remoteEntry: null,
    exposes: [],
    nfsFeatures,
    nfsFeaturesExposed: [],
    servable: false,
  };

  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(join(pluginPath, "dist/mf-manifest.json"), "utf8"),
    );
  } catch (err) {
    return {
      mf: blank,
      error: `dist/mf-manifest.json is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }

  const parsed = (manifest ?? {}) as {
    name?: unknown;
    metaData?: { remoteEntry?: { name?: unknown; path?: unknown } };
    exposes?: unknown;
  };
  const name =
    typeof parsed.name === "string" && parsed.name ? parsed.name : null;
  const remoteEntryName = parsed.metaData?.remoteEntry?.name;
  const remoteEntry =
    typeof remoteEntryName === "string" && remoteEntryName
      ? remoteEntryName
      : null;
  // Manifests emit `path` alongside `name` — empty for a root-level entry, a subdirectory
  // otherwise. Resolving only `dist/<name>` reports a missing asset for a bundle that
  // loads fine.
  const remoteEntryPath = parsed.metaData?.remoteEntry?.path;
  const remoteEntryDir =
    typeof remoteEntryPath === "string" ? remoteEntryPath : "";
  // Mirror the router's own guard exactly: every entry must be a non-null object with a
  // `name` key. Note it does NOT require the list to be non-empty — `[]` is truthy, is
  // an array, and `[].every()` is vacuously true, so an empty exposes list is served.
  // Requiring non-empty here would fail an artifact that works.
  const exposesRaw = Array.isArray(parsed.exposes) ? parsed.exposes : null;
  const exposesAllNamed =
    exposesRaw?.every(
      (e) => e !== null && typeof e === "object" && "name" in e,
    ) ?? false;
  const exposes = (exposesRaw ?? [])
    .map((e) => (e as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  // Split deliberately. `routerProblems` are the guards in the remotes router itself, and
  // only those may set `servable: false` — that field is documented as the router's
  // verdict, so folding anything else into it puts a false value in the one signal
  // results.json publishes as such.
  const routerProblems: string[] = [];
  if (!name) routerProblems.push("`name` missing");
  if (!remoteEntry) routerProblems.push("`metaData.remoteEntry.name` missing");
  if (!exposesRaw) routerProblems.push("`exposes` is not an array");
  else if (!exposesAllNamed) {
    routerProblems.push("`exposes` has an entry without a `name`");
  }

  // Real faults, but not the router's: on the default path it probes mf-manifest.json
  // itself (getRemoteEntryType() returns "manifest"), so it serves these remotes and the
  // breakage surfaces in the browser's MF runtime instead.
  const bundleProblems: string[] = [];
  // Not something the router checks on the default path: with the default resolver
  // `getRemoteEntryType()` returns "manifest", so the asset it probes for existence is
  // mf-manifest.json itself. This asset is what the Module Federation runtime in the
  // browser fetches after reading the manifest, which is why it still has to be there.
  if (remoteEntry) {
    // `path` is untrusted: it comes from JSON inside a published OCI artifact. Contain it
    // before touching the filesystem, per the rule src/paths.ts documents — otherwise a
    // manifest declaring `../../..` probes outside its own package.
    const distDir = join(pluginPath, "dist");
    const resolved = resolveContained(
      join(remoteEntryDir, remoteEntry),
      distDir,
    );
    if (!resolved) {
      bundleProblems.push(
        `metaData.remoteEntry path '${join(remoteEntryDir, remoteEntry)}' ` +
          `escapes the bundle's dist/ directory`,
      );
    } else if (!existsSync(resolved)) {
      bundleProblems.push(
        `remote entry asset dist/${relative(distDir, resolved)} not present ` +
          `(needed by the MF runtime)`,
      );
    }
  }

  const exposedSet = new Set(exposes.map(canonicalEntryPoint));
  const mf: MfRemoteInfo = {
    name,
    remoteEntry,
    exposes,
    nfsFeatures,
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
      ? `dist/mf-manifest.json is servable but its bundle is broken: ${bundleProblems.join(", ")}`
      : null,
  ].filter((m): m is string => m !== null);
  return { mf, error: messages.length ? messages.join("; ") : null };
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
 * The Scalprum half is a presence check; the bundle is never loaded or evaluated.
 * The module-federation half additionally validates the manifest's SHAPE against
 * what the remotes router requires, because presence is not enough there: the router
 * skips a malformed manifest with a log line and still answers `200 []`, which
 * reaches the browser as an app that boots cleanly with no plugins. See
 * {@link MfRemoteInfo} for why servability and NFS feature types are reported apart.
 */
export function validateFrontendBundle(
  plugin: PluginEntry,
): FrontendBundleResult {
  const has = (rel: string) => existsSync(join(plugin.path, rel));
  if (!has("package.json"))
    return { systems: [], mf: null, error: "missing package.json" };

  // Probe BOTH layouts before returning. Bailing out on the first broken one left
  // `systems` empty, so a dual-shipping bundle with a broken Scalprum manifest was
  // reported as shipping neither system — corrupting the migration panel the sweep
  // exists to keep fresh, on top of the (correct) error.
  const systems: FrontendSystem[] = [];
  const problems: string[] = [];
  let mf: MfRemoteInfo | null = null;

  if (has("dist-scalprum")) {
    if (has("dist-scalprum/plugin-manifest.json")) systems.push("legacy");
    else problems.push("dist-scalprum/ found but missing plugin-manifest.json");
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

  if (problems.length) return { systems, mf, error: problems.join("; ") };
  if (systems.length === 0) {
    return {
      systems,
      mf,
      error:
        "no frontend bundle found — needs dist-scalprum/ (legacy frontend system) " +
        "and/or dist/mf-manifest.json (new frontend system)",
    };
  }
  return { systems, mf, error: null };
}
