/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Pure logic for the release plugin sanity check (release-sanity.ts): resolving what
 * to test from a CI chart, building the plugin set, and judging the result. No I/O
 * here, so every decision is unit-tested; the CLI only runs the tools.
 */

import { parse } from "yaml";
import type { UnresolvedRef } from "./report";
import { compareStrings, isRecord } from "./util";

/** A CI chart version as quay.io/rhdh/chart tags it, e.g. `2.1-158-CI`. */
const CHART_VERSION_RE = /^(\d+\.\d+)-(\d+)-CI$/;

/** `2.1-158-CI` → `2.1`. */
export function chartStream(chartVersion: string): string {
  const match = CHART_VERSION_RE.exec(chartVersion);
  if (!match) throw new Error(`not a CI chart version: '${chartVersion}'`);
  return match[1];
}

/** `2.1-158-CI`, rebuilt from its numbers; throws on anything else. */
export function normalizeChartVersion(value: string): string {
  const match = CHART_VERSION_RE.exec(value);
  if (!match) {
    throw new Error(
      `--chart-version must look like 2.1-158-CI, got '${value}'`,
    );
  }
  const [major, minor] = match[1].split(".").map(Number);
  return `${major}.${minor}-${Number(match[2])}-CI`;
}

function compareStreams(a: string, b: string): number {
  const [aMajor, aMinor] = a.split(".").map(Number);
  const [bMajor, bMinor] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/**
 * The newest CI chart among `tags`, in `stream` when given, else in the newest stream
 * that has one (main builds the next, unreleased stream).
 */
export function newestCiChart(tags: string[], stream?: string): string {
  const builds = tags
    .map((tag) => ({ tag, match: CHART_VERSION_RE.exec(tag) }))
    .filter(
      (t): t is { tag: string; match: RegExpExecArray } => t.match !== null,
    )
    .map(({ tag, match }) => ({
      tag,
      stream: match[1],
      build: Number(match[2]),
    }));
  const streams = builds.map((b) => b.stream);
  streams.sort(compareStreams);
  const target = stream ?? streams.at(-1);
  const inStream = builds.filter((b) => b.stream === target);
  if (inStream.length === 0) {
    throw new Error(`no CI chart found for stream '${target ?? "<none>"}'`);
  }
  inStream.sort((a, b) => a.build - b.build);
  return inStream.at(-1)!.tag;
}

/**
 * `registry[:port]/path[:tag][@sha256:digest]`: the only shape an image argument may
 * take before it reaches docker or skopeo.
 */
const IMAGE_REF_RE =
  /^[a-z0-9][a-z0-9.-]*(?::\d+)?(?:\/[a-z0-9._-]+)+(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/;

export function isImageRef(value: string): boolean {
  return IMAGE_REF_RE.test(value);
}

export type ChartImages = { image: string; catalogIndex: string };

function imageRef(node: unknown, path: string): string {
  if (!isRecord(node)) throw new TypeError(`chart values: ${path} is missing`);
  const { registry, repository, digest, tag } = node;
  if (typeof registry !== "string" || typeof repository !== "string") {
    throw new TypeError(
      `chart values: ${path}.registry/repository are missing`,
    );
  }
  if (typeof digest === "string" && digest !== "") {
    return `${registry}/${repository}@${digest}`;
  }
  if (typeof tag === "string" && tag !== "") {
    return `${registry}/${repository}:${tag}`;
  }
  throw new Error(`chart values: ${path} has neither a digest nor a tag`);
}

/**
 * The hub image and catalog index a chart deploys, read from its values.yaml
 * (`helm show values`). CI charts pin both by digest.
 */
export function imagesFromChartValues(valuesYaml: string): ChartImages {
  const values: unknown = parse(valuesYaml);
  if (!isRecord(values)) throw new TypeError("chart values are not a mapping");
  const catalogIndex = isRecord(values.catalogIndex)
    ? values.catalogIndex.image
    : undefined;
  return {
    image: imageRef(values.image, "image"),
    catalogIndex: imageRef(catalogIndex, "catalogIndex.image"),
  };
}

export type CommunityPlugin = { packageName: string; artifact: string };

export type DynamicPluginsConfig = {
  includes: string[];
  plugins: Array<{ package: string; enabled: boolean }>;
};

/**
 * The dynamic-plugins.yaml the container installs: the index's own list (through
 * `includes`, so its pluginConfig applies), with every index package switched on, plus
 * every community plugin. Index packages win a duplicate: they are what ships.
 */
export function buildDynamicPluginsConfig(
  indexPackages: string[],
  community: CommunityPlugin[],
  isExcluded: (pkg: string) => boolean,
): DynamicPluginsConfig {
  const plugins: DynamicPluginsConfig["plugins"] = [];
  const seen = new Set<string>();
  for (const pkg of [...indexPackages].sort(compareStrings)) {
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    plugins.push({ package: pkg, enabled: !isExcluded(pkg) });
  }
  const indexImages = new Set(indexPackages.map(imageBaseName));
  for (const plugin of [...community].sort((a, b) =>
    compareStrings(a.artifact, b.artifact),
  )) {
    if (seen.has(plugin.artifact)) continue;
    if (indexImages.has(imageBaseName(plugin.artifact))) continue;
    seen.add(plugin.artifact);
    plugins.push({ package: plugin.artifact, enabled: true });
  }
  return { includes: ["dynamic-plugins.default.yaml"], plugins };
}

/**
 * Merge app-config layers, later ones winning. Unlike pluginConfig, which the install
 * CLI refuses when two plugins set one key differently, app-config layers may
 * disagree, so every community example can apply at once.
 */
export function mergeAppConfig(
  layers: Record<string, unknown>[],
): Record<string, unknown> {
  const merge = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> => {
    for (const [key, value] of Object.entries(source)) {
      const current = target[key];
      // Arrays replace rather than concatenate (unlike plugin-config's deepMerge):
      // two examples listing the same instance must not configure it twice.
      target[key] =
        isRecord(current) && isRecord(value)
          ? merge({ ...current }, value)
          : structuredClone(value);
    }
    return target;
  };
  return layers.reduce<Record<string, unknown>>((acc, l) => merge(acc, l), {});
}

/**
 * The directory a ref installs into, which the harness dummies are keyed by: the
 * `!plugin-path` selector when present (an image can hold a differently named
 * plugin), else the image name.
 */
export function installDirName(ref: string): string {
  return ref.split("!")[1] || imageBaseName(ref);
}

/** `oci://reg/ns/name:tag!path` / `…@sha256:…` → `name`. */
export function imageBaseName(ref: string): string {
  const withoutPath = ref.split("!")[0];
  const withoutVersion = withoutPath.split("@")[0].replace(/:[^/:]+$/, "");
  return withoutVersion.split("/").at(-1) ?? withoutVersion;
}

/** Every `${VAR}` (not the `$${VAR}` escape) in `texts` that `provided` does not set. */
export function unsetEnvVars(texts: string[], provided: Set<string>): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/(?<!\$)\$\{([A-Za-z_]\w*)\}/g)) {
      if (!provided.has(match[1])) names.add(match[1]);
    }
  }
  return [...names].sort(compareStrings);
}

/**
 * A placeholder for a variable nothing sets. A URL on the reserved .invalid TLD
 * satisfies both string and URL config validation and never resolves.
 */
export const DUMMY_ENV_VALUE = "https://release-sanity.invalid";

/** The config with every unresolved ref switched off: one would abort the install. */
export function applyProbeResult(
  config: DynamicPluginsConfig,
  unresolvedRefs: Set<string>,
): DynamicPluginsConfig {
  return {
    ...config,
    plugins: config.plugins.map((p) =>
      unresolvedRefs.has(p.package) ? { ...p, enabled: false } : p,
    ),
  };
}

/**
 * Image names left out by an exclusion: index packages switched off for any reason
 * but an unresolved ref, plus community artifacts dropped before the config was built.
 */
export function skippedImages(
  config: DynamicPluginsConfig,
  unresolvedRefs: Set<string>,
  communityArtifacts: string[],
  keptArtifacts: string[],
): string[] {
  const kept = new Set(keptArtifacts);
  const names = [
    ...config.plugins
      .filter((p) => !p.enabled && !unresolvedRefs.has(p.package))
      .map((p) => imageBaseName(p.package)),
    ...communityArtifacts
      .filter((ref) => !kept.has(ref))
      .map((ref) => imageBaseName(ref)),
  ];
  return [...new Set(names)].sort(compareStrings);
}

/**
 * The container's env: each test.env value, unless the environment already sets the
 * variable (a real token wins over the committed placeholder), then a dummy for every
 * variable the config still references.
 */
export function buildEnv(
  fileEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
  referencedTexts: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(fileEnv)) {
    env[key] = processEnv[key] ?? value;
  }
  for (const name of unsetEnvVars(referencedTexts, new Set(Object.keys(env)))) {
    env[name] = DUMMY_ENV_VALUE;
  }
  return env;
}

/** The `name` of every loaded plugin in a /loaded-plugins response. */
export function parseLoadedPlugins(body: unknown): Set<string> {
  if (!Array.isArray(body)) {
    throw new TypeError(
      `loaded-plugins: expected an array, got ${typeof body}`,
    );
  }
  const names = new Set<string>();
  for (const item of body) {
    if (!isRecord(item) || typeof item.name !== "string") {
      throw new TypeError(
        `loaded-plugins: item without a name: ${JSON.stringify(item)}`,
      );
    }
    names.add(item.name);
  }
  return names;
}

export type InstalledPlugin = { name: string; dirName: string };

/** Installed plugins the backend did not load. */
export function findNotLoaded(
  installed: InstalledPlugin[],
  loaded: Set<string>,
): InstalledPlugin[] {
  return installed
    .filter((plugin) => !loaded.has(plugin.name))
    .sort((a, b) => compareStrings(a.name, b.name));
}

/**
 * Requested refs the install CLI never reported as installed. Counted from its log,
 * not from directories: one package does not always make one directory.
 */
export function findNotInstalled(requested: string[], log: string): string[] {
  const base = (ref: string) => ref.split("!")[0];
  const installed = new Set(
    [
      ...log.matchAll(/==> (?:Installed\s+(\S+)|(\S+): already installed)/g),
    ].map((m) => base(m[1] ?? m[2])),
  );
  return requested
    .filter((ref) => !installed.has(base(ref)))
    .sort(compareStrings);
}

/** Log lines that name a plugin install or startup failure. */
const FAILURE_LINE =
  /InstallException|Error while adding OCI plugin|Failed to load dynamic plugin|threw an error during startup|Backend startup failed|Missing required config value|defined differently|plugin\(s\) failed/;

// eslint-disable-next-line no-control-regex -- matching terminal escapes is the point
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/** Failure lines, each message once: a provider retrying every few seconds repeats. */
export function failureLines(log: string): string[] {
  const seen = new Set<string>();
  return log
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .filter((line) => FAILURE_LINE.test(line))
    .filter((line) => {
      const message = line.replace(/^\S*\d{4}-\d{2}-\d{2}T\S+\s*/, "");
      if (seen.has(message)) return false;
      seen.add(message);
      return true;
    });
}

/** Plugin ids the backend named as failing startup, e.g. `mta`. */
export function failedPluginIds(log: string): string[] {
  const ids = new Set<string>();
  for (const match of log
    .replace(ANSI_ESCAPE, "")
    .matchAll(
      /Plugin '([^']+)' (?:threw an error during startup|startup failed)/g,
    )) {
    ids.add(match[1]);
  }
  return [...ids].sort(compareStrings);
}

/** The backend gave up starting; it may linger, so this ends the wait early. */
export function backendStartupFailed(log: string): boolean {
  return log.includes("Backend startup failed");
}

export type SanityReport = {
  chartVersion: string;
  image: string;
  catalogIndex: string;
  /** Packages requested: index (enabled) + community. */
  requested: number;
  installed: number;
  loaded: number;
  notLoaded: InstalledPlugin[];
  /** Image names left out by release-sanity-excludes.txt. */
  skipped: string[];
  /** Requested packages the install CLI did not report as installed. */
  notInstalled: string[];
  /** Requested packages the registry could not serve; not installed. */
  unresolved: UnresolvedRef[];
  failures: string[];
  /** Plugin ids the backend reported as failing startup. */
  failedPlugins: string[];
  /** Set when the backend never became ready. */
  startupError?: string;
  /** Set when the backend was up but the check could not read its plugins. */
  checkError?: string;
};

export function passed(report: SanityReport): boolean {
  return (
    report.startupError === undefined &&
    report.checkError === undefined &&
    report.unresolved.length === 0 &&
    report.notInstalled.length === 0 &&
    report.notLoaded.length === 0 &&
    report.installed > 0
  );
}

/** The cause at the end of a skopeo error, e.g. `manifest unknown`. */
export function shortError(error: string): string {
  let cause = error.split(": ").at(-1) ?? "";
  while (cause.endsWith('"') || cause.endsWith("\\"))
    cause = cause.slice(0, -1);
  return cause.trim() || error;
}

// Bounded so a summary stays far below GitHub's 65536-character comment limit.
const LIST_MAX = 30;
const LOG_LINE_MAX = 300;

function cappedList(items: string[]): string[] {
  const shown = items.slice(0, LIST_MAX).map((item) => `- ${item}`);
  if (items.length > LIST_MAX) {
    shown.push(
      `- … and ${items.length - LIST_MAX} more (see the report artifact)`,
    );
  }
  return shown;
}

/** A log line made safe inside a fenced block: bounded, no fence, no mentions. */
function quoteLogLine(line: string): string {
  const safe = line.replaceAll("```", "'''").replaceAll("@", "@\u200b");
  return safe.length > LOG_LINE_MAX ? `${safe.slice(0, LOG_LINE_MAX)}…` : safe;
}

/** The markdown block posted to the job summary and the issue. */
export function renderSummary(report: SanityReport, runUrl?: string): string {
  const lines = [
    `### Release plugin sanity: ${passed(report) ? "passed" : "failed"}`,
    "",
    `- Chart: \`${report.chartVersion}\``,
    `- Image: \`${report.image}\``,
    `- Catalog index: \`${report.catalogIndex}\``,
    `- Plugins: ${report.requested} requested, ${report.installed} installed, ${report.loaded} loaded`,
    report.skipped.length
      ? "- Excluded: " + report.skipped.map((e) => `\`${e}\``).join(", ")
      : undefined,
    runUrl ? `- Run: ${runUrl}` : undefined,
  ].filter((line): line is string => line !== undefined);
  if (report.startupError) {
    lines.push("", `**The backend did not start:** ${report.startupError}`);
  }
  if (report.checkError) {
    lines.push("", `**The check could not finish:** ${report.checkError}`);
  }
  if (report.failedPlugins.length) {
    const ids = report.failedPlugins.map((p) => `\`${p}\``).join(", ");
    lines.push("", `**Plugins that failed startup:** ${ids}`);
  }
  if (report.unresolved.length) {
    lines.push(
      "",
      "**Cannot be pulled (not installed):**",
      ...cappedList(
        report.unresolved.map((u) => `\`${u.ref}\`: ${shortError(u.error)}`),
      ),
    );
  }
  if (report.notInstalled.length) {
    lines.push(
      "",
      "**Requested but not installed:**",
      ...cappedList(report.notInstalled.map((ref) => `\`${ref}\``)),
    );
  }
  if (report.notLoaded.length) {
    lines.push(
      "",
      "**Installed but not loaded:**",
      ...cappedList(
        report.notLoaded.map((p) => `\`${p.name}\` (${p.dirName})`),
      ),
    );
  }
  if (report.failures.length) {
    lines.push(
      "",
      "<details><summary>Failure lines from the log</summary>",
      "",
      "```",
      ...report.failures.slice(0, 50).map(quoteLogLine),
      "```",
      "</details>",
    );
  }
  return lines.join("\n");
}

/** Summary for a run that ended before it could produce a report. */
export function renderError(message: string, runUrl?: string): string {
  return [
    "### Release plugin sanity: error",
    "",
    `The check stopped before producing a report: ${message}`,
    ...(runUrl ? ["", `- Run: ${runUrl}`] : []),
  ].join("\n");
}
