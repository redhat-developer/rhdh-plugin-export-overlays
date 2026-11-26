/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Pure logic for the frontend render check of the release sanity run
 * (frontend-render.ts): which community frontend packages the app was expected to load,
 * what the browser reported for each, and the verdict. No I/O here.
 *
 * The signal comes from @backstage/frontend-dynamic-feature-loader, which the RHDH app
 * (packages/app, the New Frontend System) uses to load every dynamic frontend plugin. It
 * logs one attributable console line per exposed module: `Remote module '…' of dynamic
 * plugin '<package>' loaded from …` on success, `Failed loading remote module '…' of
 * dynamic plugin '<package>': <error>` when evaluating the module throws. Those lines,
 * plus failed requests under the remotes route, are what this module judges. It is a
 * load/render sanity check — the community tier's ceiling — not functional testing.
 */

import { compareStrings, isRecord } from "./util";

/** One entry of `GET /.backstage/dynamic-features/remotes`. */
export type FrontendRemote = {
  /** The installed package name, which the loader logs as the plugin name. */
  packageName: string;
  /** The module federation container name from the package's mf-manifest.json. */
  remoteName: string;
  exposedModules: string[];
};

/** A console message the page emitted, as Playwright reports it. */
export type BrowserMessage = { type: string; text: string };

/** A request under the remotes route that failed or answered with an error status. */
export type FailedRequest = { url: string; failure: string };

export type RenderOutcome =
  /** Every exposed module was evaluated, at least one loaded. */
  | "rendered"
  /**
   * A module threw while loading, one of its assets could not be fetched, or the
   * package ships `dist/mf-manifest.json` that the backend refused to serve.
   */
  | "failed"
  /** Installed without a module federation build, so the backend has nothing to serve. */
  | "not-served"
  /** Served, but the loader did not report on every exposed module (the app did not get as far as loading them). */
  | "not-reported"
  /** Loaded, but no module exports a frontend feature, so it contributes nothing. */
  | "no-feature";

export type FrontendRenderResult = {
  packageName: string;
  outcome: RenderOutcome;
  /** Load errors and failed asset requests, for "failed". */
  errors: string[];
};

export type FrontendRenderReport = {
  /** Community frontend packages the check covered, after render exclusions. */
  checked: number;
  /** Packages left out by a `render` exclusion, with the ticket that tracks them. */
  excluded: { packageName: string; ticket: string }[];
  /** Set when the app never showed its signed-in shell. */
  shellError?: string;
  /** Loader errors not tied to one package: the remotes list or the federation runtime. */
  globalErrors: string[];
  /**
   * Load errors of packages this check does not judge (catalog index, render-excluded):
   * listed for whoever reads the report, never failing the run.
   */
  unjudgedErrors: string[];
  results: FrontendRenderResult[];
};

const LOADED_RE =
  /^Remote module '(.+?)' of dynamic plugin '(.+?)' loaded from /;
const FAILED_RE =
  /^Failed loading remote module '(.+?)' of dynamic plugin '(.+?)': ([\s\S]*)$/;
const NOT_A_FEATURE_RE =
  /^Skipping dynamic plugin remote module '(.+?)' since it doesn't export/;
const EMPTY_RE = /^Skipping empty dynamic plugin remote module '(.+?)'/;
const GLOBAL_ERROR_RE =
  /^Failed (?:fetching module federation configuration of dynamic frontend plugins|initializing module federation)/;

/** The route prefix the backend serves every remote's assets under. */
export const REMOTES_PATH = "/.backstage/dynamic-features/remotes";

/** The package name without the `-dynamic` suffix the export appends. */
function baseName(packageName: string): string {
  return packageName.replace(/-dynamic$/, "");
}

export function parseRemotes(body: unknown): FrontendRemote[] {
  if (!Array.isArray(body)) {
    throw new TypeError(`remotes: expected an array, got ${typeof body}`);
  }
  return body.map((item) => {
    const info = isRecord(item) ? item.remoteInfo : undefined;
    const exposed = isRecord(item) ? item.exposedModules : undefined;
    if (
      !isRecord(item) ||
      typeof item.packageName !== "string" ||
      !isRecord(info) ||
      typeof info.name !== "string" ||
      !Array.isArray(exposed) ||
      !exposed.every((m) => typeof m === "string")
    ) {
      throw new TypeError(`remotes: malformed entry: ${JSON.stringify(item)}`);
    }
    return {
      packageName: item.packageName,
      remoteName: info.name,
      exposedModules: exposed,
    };
  });
}

/** The installed package a remote asset URL belongs to, if any. */
export function packageForAssetUrl(
  url: string,
  remotes: FrontendRemote[],
): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return undefined;
  }
  const marker = `${REMOTES_PATH}/`;
  const start = path.indexOf(marker);
  if (start === -1) return undefined;
  const rest = path.slice(start + marker.length);
  // The trailing slash keeps `@x/plugin-a` from claiming `@x/plugin-a-foo`'s assets.
  return remotes
    .map((r) => r.packageName)
    .find((name) => rest.startsWith(`${name}/`));
}

type LoaderEvents = {
  /** Modules evaluated, per package. */
  loaded: Map<string, number>;
  /** Evaluated modules whose default export is not a frontend feature. */
  notAFeature: Map<string, number>;
  /** Modules that resolved to nothing; the loader logs no "loaded" line for these. */
  empty: Map<string, number>;
  failed: Map<string, string[]>;
  globalErrors: string[];
};

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Records one console line in `events`; lines the loader did not write are ignored. */
function recordLoaderMessage(
  events: LoaderEvents,
  text: string,
  packageOf: (module: string) => string | undefined,
): void {
  const loaded = LOADED_RE.exec(text);
  if (loaded) {
    bump(events.loaded, loaded[2]);
    return;
  }
  const failed = FAILED_RE.exec(text);
  if (failed) {
    const errors = events.failed.get(failed[2]) ?? [];
    errors.push(`${failed[1]}: ${failed[3].trim()}`);
    events.failed.set(failed[2], errors);
    return;
  }
  // A skip line names only the module, so it is counted against its package.
  const skips: [RegExp, Map<string, number>][] = [
    [NOT_A_FEATURE_RE, events.notAFeature],
    [EMPTY_RE, events.empty],
  ];
  for (const [pattern, counts] of skips) {
    const skip = pattern.exec(text);
    if (skip) {
      const pkg = packageOf(skip[1]);
      if (pkg) bump(counts, pkg);
      return;
    }
  }
  if (GLOBAL_ERROR_RE.test(text)) events.globalErrors.push(text);
}

/** Groups the loader's console lines by package. */
function readLoaderMessages(
  messages: BrowserMessage[],
  remotes: FrontendRemote[],
): LoaderEvents {
  const events: LoaderEvents = {
    loaded: new Map(),
    notAFeature: new Map(),
    empty: new Map(),
    failed: new Map(),
    globalErrors: [],
  };
  // A module is `<container>` or `<container>/<expose>`; the container leads to the package.
  const byRemoteName = new Map(remotes.map((r) => [r.remoteName, r]));
  const packageOf = (module: string) =>
    byRemoteName.get(module.split("/")[0])?.packageName;
  for (const { text } of messages) recordLoaderMessage(events, text, packageOf);
  return events;
}

/** The router logs why it skipped a manifest and answers without it; the log names the cause. */
const UNSERVED_MANIFEST_ERROR =
  "ships dist/mf-manifest.json, but the backend does not serve it as a remote; the container log says why";

function outcomeFor(
  remote: FrontendRemote,
  events: LoaderEvents,
  assetErrors: string[],
): FrontendRenderResult["outcome"] {
  const name = remote.packageName;
  if (events.failed.has(name) || assetErrors.length) return "failed";
  const loaded = events.loaded.get(name) ?? 0;
  // The loader logs one line per exposed module, so a shortfall means it stopped early.
  // A remote exposing nothing gives it nothing to log, and contributes nothing.
  if (loaded + (events.empty.get(name) ?? 0) < remote.exposedModules.length) {
    return "not-reported";
  }
  const features = loaded - (events.notAFeature.get(name) ?? 0);
  return features > 0 ? "rendered" : "no-feature";
}

/** The verdict for one expected package. */
function resultFor(
  packageName: string,
  remote: FrontendRemote | undefined,
  hasManifest: boolean,
  events: LoaderEvents,
  assetErrors: Map<string, string[]>,
): FrontendRenderResult {
  if (!remote) {
    return hasManifest
      ? { packageName, outcome: "failed", errors: [UNSERVED_MANIFEST_ERROR] }
      : { packageName, outcome: "not-served", errors: [] };
  }
  const assets = assetErrors.get(remote.packageName) ?? [];
  const outcome = outcomeFor(remote, events, assets);
  const loadErrors = events.failed.get(remote.packageName) ?? [];
  return {
    packageName,
    outcome,
    errors: outcome === "failed" ? [...loadErrors, ...assets] : [],
  };
}

/**
 * The verdict for every expected package. `expected` holds the installed community
 * frontend package names that are not render-excluded; they are matched to remotes
 * with and without the `-dynamic` suffix, the way the exclusions match. `withManifest`
 * holds the installed packages that ship `dist/mf-manifest.json`, which tells a
 * package with no federation build apart from one the backend refused to serve.
 */
export function evaluateFrontendRender(input: {
  expected: string[];
  excluded: { packageName: string; ticket: string }[];
  remotes: FrontendRemote[];
  messages: BrowserMessage[];
  failedRequests: FailedRequest[];
  withManifest?: string[];
  shellError?: string;
}): FrontendRenderReport {
  const events = readLoaderMessages(input.messages, input.remotes);
  const remoteByBase = new Map(
    input.remotes.map((r) => [baseName(r.packageName), r]),
  );
  const assetErrors = new Map<string, string[]>();
  for (const req of input.failedRequests) {
    const pkg = packageForAssetUrl(req.url, input.remotes);
    if (!pkg) continue;
    const list = assetErrors.get(pkg) ?? [];
    list.push(`${new URL(req.url).pathname}: ${req.failure}`);
    assetErrors.set(pkg, list);
  }
  const withManifest = new Set((input.withManifest ?? []).map(baseName));
  const expected = [...new Set(input.expected)].sort(compareStrings);
  const results = expected.map((packageName) =>
    resultFor(
      packageName,
      remoteByBase.get(baseName(packageName)),
      withManifest.has(baseName(packageName)),
      events,
      assetErrors,
    ),
  );
  const judged = new Set(expected.map(baseName));
  const unjudgedErrors = [...events.failed]
    .filter(([pkg]) => !judged.has(baseName(pkg)))
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([pkg, errors]) => `${pkg}: ${errors.join("; ")}`);
  return {
    checked: results.length,
    excluded: input.excluded,
    shellError: input.shellError,
    globalErrors: events.globalErrors,
    unjudgedErrors,
    results,
  };
}

/**
 * What fails the run: the shell never rendered, the loader could not start, or a
 * package's module threw, its assets were not served, or its manifest was refused.
 * "not-served" and "no-feature"
 * are reported but do not fail it: a community package still on the legacy frontend
 * system, or one that ships only translations, is a migration state the community
 * sweep's bundle check already tracks, not a crash. "not-reported" fails, because a
 * served remote the loader did not finish reporting on means the app did not finish
 * loading.
 */
export function frontendRenderFailed(report: FrontendRenderReport): boolean {
  return (
    report.shellError !== undefined ||
    report.globalErrors.length > 0 ||
    report.results.some(
      (r) => r.outcome === "failed" || r.outcome === "not-reported",
    )
  );
}

/** Results with a given outcome, for reporting. */
export function withOutcome(
  report: FrontendRenderReport,
  outcome: RenderOutcome,
): FrontendRenderResult[] {
  return report.results.filter((r) => r.outcome === outcome);
}

/** Whether a metadata role is a frontend one the app loads. */
export function isFrontendRole(role: string): boolean {
  return role === "frontend-plugin" || role === "frontend-plugin-module";
}
