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
import { compareStrings, isRecord } from "./util";

/** A CI chart version as quay.io/rhdh/chart tags it, e.g. `2.1-158-CI`. */
const CHART_VERSION_RE = /^(\d+\.\d+)-(\d+)-CI$/;

export function isChartVersion(value: string): boolean {
  return CHART_VERSION_RE.test(value);
}

/** `2.1-158-CI` → `2.1`. */
export function chartStream(chartVersion: string): string {
  const match = CHART_VERSION_RE.exec(chartVersion);
  if (!match) throw new Error(`not a CI chart version: '${chartVersion}'`);
  return match[1];
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
  const target =
    stream ??
    builds
      .map((b) => b.stream)
      .sort(compareStreams)
      .at(-1);
  const inStream = builds.filter((b) => b.stream === target);
  if (inStream.length === 0) {
    throw new Error(`no CI chart found for stream '${target ?? "<none>"}'`);
  }
  return inStream.sort((a, b) => a.build - b.build).at(-1)!.tag;
}

export type ChartImages = { image: string; catalogIndex: string };

function imageRef(node: unknown, path: string): string {
  if (!isRecord(node)) throw new Error(`chart values: ${path} is missing`);
  const { registry, repository, digest, tag } = node;
  if (typeof registry !== "string" || typeof repository !== "string") {
    throw new Error(`chart values: ${path}.registry/repository are missing`);
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
  if (!isRecord(values)) throw new Error("chart values are not a mapping");
  const catalogIndex = isRecord(values.catalogIndex)
    ? values.catalogIndex.image
    : undefined;
  return {
    image: imageRef(values.image, "image"),
    catalogIndex: imageRef(catalogIndex, "catalogIndex.image"),
  };
}

/** `/sanity 2.1-158-CI` → `2.1-158-CI`; anything else → undefined. */
export function parseSanityCommand(body: string): string | undefined {
  const match = /^\/sanity[ \t]+(\S+)[ \t]*$/.exec(body.trim());
  return match && isChartVersion(match[1]) ? match[1] : undefined;
}

export type CommunityPlugin = {
  packageName: string;
  artifact: string;
  pluginConfig?: Record<string, unknown>;
};

export type DynamicPluginsConfig = {
  includes: string[];
  plugins: Array<{
    package: string;
    enabled: boolean;
    pluginConfig?: Record<string, unknown>;
  }>;
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
    plugins.push({
      package: plugin.artifact,
      enabled: true,
      ...(plugin.pluginConfig ? { pluginConfig: plugin.pluginConfig } : {}),
    });
  }
  return { includes: ["dynamic-plugins.default.yaml"], plugins };
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
    for (const match of text.matchAll(
      /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    )) {
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

/** The `name` of every loaded plugin in a /loaded-plugins response. */
export function parseLoadedPlugins(body: unknown): Set<string> {
  if (!Array.isArray(body)) {
    throw new Error(`loaded-plugins: expected an array, got ${typeof body}`);
  }
  const names = new Set<string>();
  for (const item of body) {
    if (!isRecord(item) || typeof item.name !== "string") {
      throw new Error(
        `loaded-plugins: item without a name: ${JSON.stringify(item)}`,
      );
    }
    names.add(item.name);
  }
  return names;
}

export type InstalledPlugin = { name: string; dirName: string };

/** Installed plugins the backend did not load. */
export function notLoaded(
  installed: InstalledPlugin[],
  loaded: Set<string>,
): InstalledPlugin[] {
  return installed
    .filter((plugin) => !loaded.has(plugin.name))
    .sort((a, b) => compareStrings(a.name, b.name));
}

/** Log lines that name a plugin install or startup failure. */
const FAILURE_LINE =
  /InstallException|Error while adding OCI plugin|Failed to load dynamic plugin|threw an error during startup|Backend startup failed|Missing required config value/;

export function failureLines(log: string): string[] {
  return log.split("\n").filter((line) => FAILURE_LINE.test(line));
}

export type SanityReport = {
  chartVersion?: string;
  image: string;
  catalogIndex: string;
  /** Packages requested: index (enabled) + community. */
  requested: number;
  installed: number;
  loaded: number;
  notLoaded: InstalledPlugin[];
  excluded: string[];
  failures: string[];
  /** Set when the backend never became ready. */
  startupError?: string;
};

export function passed(report: SanityReport): boolean {
  return (
    report.startupError === undefined &&
    report.notLoaded.length === 0 &&
    report.installed > 0 &&
    report.installed >= report.requested
  );
}

/** The markdown block posted to the job summary and the issue. */
export function renderSummary(report: SanityReport, runUrl?: string): string {
  const lines = [
    `### Release plugin sanity: ${passed(report) ? "passed" : "failed"}`,
    "",
    report.chartVersion ? `- Chart: \`${report.chartVersion}\`` : undefined,
    `- Image: \`${report.image}\``,
    `- Catalog index: \`${report.catalogIndex}\``,
    `- Plugins: ${report.requested} requested, ${report.installed} installed, ${report.loaded} loaded`,
    report.excluded.length
      ? `- Excluded: ${report.excluded.map((e) => `\`${e}\``).join(", ")}`
      : undefined,
    runUrl ? `- Run: ${runUrl}` : undefined,
  ].filter((line): line is string => line !== undefined);
  if (report.startupError) {
    lines.push("", `**The backend did not start:** ${report.startupError}`);
  }
  if (report.installed < report.requested) {
    lines.push(
      "",
      `**${report.requested - report.installed} requested plugin(s) were not installed.**`,
    );
  }
  if (report.notLoaded.length) {
    lines.push("", "**Installed but not loaded:**");
    for (const p of report.notLoaded)
      lines.push(`- \`${p.name}\` (${p.dirName})`);
  }
  if (report.failures.length) {
    lines.push(
      "",
      "<details><summary>Failure lines from the log</summary>",
      "",
      "```",
    );
    lines.push(...report.failures.slice(0, 50), "```", "</details>");
  }
  return lines.join("\n");
}
