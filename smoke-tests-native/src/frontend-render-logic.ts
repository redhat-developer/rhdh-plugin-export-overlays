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
  /** A module threw while loading, or one of its assets could not be fetched. */
  | "failed"
  /** Installed, but the backend does not serve it as a remote (no module federation build, or a malformed manifest). */
  | "not-served"
  /** Served, but the loader never reported on it (the app did not get as far as loading it). */
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
  // A skip line names only the module (`<container>` or `<container>/<expose>`); the
  // container name leads to the package.
  const byRemoteName = new Map(remotes.map((r) => [r.remoteName, r]));
  const packageOf = (module: string) =>
    byRemoteName.get(module.split("/")[0])?.packageName;
  for (const { text } of messages) {
    const loaded = LOADED_RE.exec(text);
    if (loaded) {
      bump(events.loaded, loaded[2]);
      continue;
    }
    const failed = FAILED_RE.exec(text);
    if (failed) {
      const errors = events.failed.get(failed[2]) ?? [];
      errors.push(`${failed[1]}: ${failed[3].trim()}`);
      events.failed.set(failed[2], errors);
      continue;
    }
    const notAFeature = NOT_A_FEATURE_RE.exec(text);
    if (notAFeature) {
      const pkg = packageOf(notAFeature[1]);
      if (pkg) bump(events.notAFeature, pkg);
      continue;
    }
    const empty = EMPTY_RE.exec(text);
    if (empty) {
      const pkg = packageOf(empty[1]);
      if (pkg) bump(events.empty, pkg);
      continue;
    }
    if (GLOBAL_ERROR_RE.test(text)) events.globalErrors.push(text);
  }
  return events;
}

function outcomeFor(
  remote: FrontendRemote | undefined,
  events: LoaderEvents,
  assetErrors: string[],
): FrontendRenderResult["outcome"] {
  if (!remote) return "not-served";
  const name = remote.packageName;
  if (events.failed.has(name) || assetErrors.length) return "failed";
  const loaded = events.loaded.get(name) ?? 0;
  const empty = events.empty.get(name) ?? 0;
  if (loaded + empty === 0) {
    // A remote exposing nothing gives the loader nothing to log.
    return remote.exposedModules.length === 0 ? "no-feature" : "not-reported";
  }
  const features = loaded - (events.notAFeature.get(name) ?? 0);
  return features > 0 ? "rendered" : "no-feature";
}

/**
 * The verdict for every expected package. `expected` holds the installed community
 * frontend package names that are not render-excluded; they are matched to remotes
 * with and without the `-dynamic` suffix, the way the exclusions match.
 */
export function evaluateFrontendRender(input: {
  expected: string[];
  excluded: { packageName: string; ticket: string }[];
  remotes: FrontendRemote[];
  messages: BrowserMessage[];
  failedRequests: FailedRequest[];
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
  const results = [...new Set(input.expected)]
    .sort(compareStrings)
    .map((packageName): FrontendRenderResult => {
      const remote = remoteByBase.get(baseName(packageName));
      const assets = remote ? (assetErrors.get(remote.packageName) ?? []) : [];
      const outcome = outcomeFor(remote, events, assets);
      const loadErrors = remote
        ? (events.failed.get(remote.packageName) ?? [])
        : [];
      return {
        packageName,
        outcome,
        errors: outcome === "failed" ? [...loadErrors, ...assets] : [],
      };
    });
  return {
    checked: results.length,
    excluded: input.excluded,
    shellError: input.shellError,
    globalErrors: events.globalErrors,
    results,
  };
}

/**
 * What fails the run: the shell never rendered, the loader could not start, or a
 * package's module threw or its assets were not served. "not-served" and "no-feature"
 * are reported but do not fail it: a community package still on the legacy frontend
 * system, or one that ships only translations, is a migration state the community
 * sweep's bundle check already tracks, not a crash. "not-reported" fails, because a
 * served remote the loader never mentioned means the app did not finish loading.
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
