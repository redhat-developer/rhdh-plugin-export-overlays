/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Release plugin sanity check: boot the real RHDH image of a release in a container
 * with every catalog index plugin and every community plugin enabled, and fail when
 * one does not load. No plugin version is written anywhere: the image and index come
 * from a CI chart, community builds from each package's spec.dynamicArtifact.
 *
 *   yarn release-sanity                              # newest CI chart of the newest stream
 *   yarn release-sanity --chart-version 2.1-158-CI   # one RC
 *   yarn release-sanity --image <ref> --catalog-index <ref>
 *
 * Needs docker (or podman as docker), helm, skopeo, jq and tar on PATH.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import { partitionResolvable } from "./catalog-index";
import { excluderFor, loadExclusions } from "./exclusions";
import { probeRegistry } from "./registry-probe";
import { buildDummyConfig } from "./plugin-config";
import { collectPackages } from "./support";
import { loadEnvFile } from "./test-config";
import { discoverSmokeTestConfig } from "./workspace";
import {
  DUMMY_ENV_VALUE,
  buildDynamicPluginsConfig,
  chartStream,
  failureLines,
  imageBaseName,
  imagesFromChartValues,
  isChartVersion,
  newestCiChart,
  notLoaded,
  parseLoadedPlugins,
  passed,
  renderSummary,
  unsetEnvVars,
  type CommunityPlugin,
  type InstalledPlugin,
  type SanityReport,
} from "./release-sanity-lib";
import { isRecord } from "./util";

const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(HARNESS_ROOT);
const CHART = "quay.io/rhdh/chart";
const CONTAINER = "rhdh-release-sanity";
const APP_ROOT = "/opt/app-root/src";
const PORT = 7007;
// Installing ~150 OCI plugins dominates; the backend itself starts in about a minute.
const READY_TIMEOUT_MS = 30 * 60 * 1000;

const { values: args } = parseArgs({
  options: {
    "chart-version": { type: "string" },
    stream: { type: "string" },
    image: { type: "string" },
    "catalog-index": { type: "string" },
    out: { type: "string", default: "release-sanity-out" },
    "run-url": { type: "string" },
    keep: { type: "boolean", default: false },
    // The community metadata here is main's, which builds the newest stream; checking
    // another stream's chart against it would mix versions.
    "only-newest-stream": { type: "boolean", default: false },
  },
});

function run(cmd: string, argv: string[]): string {
  return execFileSync(cmd, argv, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveTarget(): {
  chartVersion?: string;
  image: string;
  catalogIndex: string;
} {
  if (args.image && args["catalog-index"]) {
    return { image: args.image, catalogIndex: args["catalog-index"] };
  }
  let chartVersion = args["chart-version"];
  if (chartVersion !== undefined && !isChartVersion(chartVersion)) {
    throw new Error(
      `--chart-version must look like 2.1-158-CI, got '${chartVersion}'`,
    );
  }
  const tags = (): string[] =>
    JSON.parse(run("skopeo", ["list-tags", "--no-creds", `docker://${CHART}`]))
      .Tags as string[];
  if (!chartVersion) chartVersion = newestCiChart(tags(), args.stream);
  if (args["only-newest-stream"]) {
    const newest = chartStream(newestCiChart(tags()));
    if (chartStream(chartVersion) !== newest) {
      throw new Error(
        `only the ${newest} stream is supported for now, got ${chartVersion}`,
      );
    }
  }
  const images = imagesFromChartValues(
    run("helm", [
      "show",
      "values",
      `oci://${CHART}`,
      "--version",
      chartVersion,
    ]),
  );
  return {
    chartVersion,
    image: args.image ?? images.image,
    catalogIndex: args["catalog-index"] ?? images.catalogIndex,
  };
}

function indexPackages(path: string): string[] {
  const doc: unknown = parse(readFileSync(path, "utf8"));
  const plugins =
    isRecord(doc) && Array.isArray(doc.plugins) ? doc.plugins : [];
  return plugins
    .map((entry) => (isRecord(entry) ? entry.package : undefined))
    .filter((pkg): pkg is string => typeof pkg === "string");
}

function firstAppConfigExample(
  workspace: string,
  file: string,
): Record<string, unknown> | undefined {
  const doc: unknown = parse(
    readFileSync(
      join(REPO_ROOT, "workspaces", workspace, "metadata", file),
      "utf8",
    ),
  );
  const spec = isRecord(doc) ? doc.spec : undefined;
  const examples = isRecord(spec) ? spec.appConfigExamples : undefined;
  const first = Array.isArray(examples) ? examples[0] : undefined;
  const content = isRecord(first) ? first.content : undefined;
  return isRecord(content) ? content : undefined;
}

function scanInstalled(root: string): InstalledPlugin[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const pkgPath = join(root, entry.name, "package.json");
      if (!existsSync(pkgPath)) return [];
      const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
      const name =
        isRecord(pkg) && typeof pkg.name === "string" ? pkg.name : entry.name;
      return [{ name, dirName: entry.name }];
    });
}

function containerRunning(): boolean {
  const state = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", CONTAINER],
    {
      encoding: "utf8",
    },
  );
  return state.stdout.trim() === "true";
}

async function waitForBackend(): Promise<string | undefined> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!containerRunning())
      return "the container exited before the backend was ready";
    try {
      const res = await fetch(
        `http://localhost:${PORT}/.backstage/health/v1/readiness`,
      );
      if (res.ok) return undefined;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return `the backend was not ready after ${READY_TIMEOUT_MS / 60_000} minutes`;
}

async function loadedPlugins(): Promise<Set<string>> {
  const session = await fetch(
    `http://localhost:${PORT}/api/auth/guest/refresh`,
    {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    },
  );
  if (!session.ok) throw new Error(`guest sign-in responded ${session.status}`);
  const body: unknown = await session.json();
  const identity = isRecord(body) ? body.backstageIdentity : undefined;
  const token = isRecord(identity) ? identity.token : undefined;
  if (typeof token !== "string")
    throw new Error("guest sign-in returned no token");
  const res = await fetch(
    `http://localhost:${PORT}/api/dynamic-plugins-info/loaded-plugins`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) throw new Error(`loaded-plugins responded ${res.status}`);
  return parseLoadedPlugins(await res.json());
}

async function main(): Promise<number> {
  const out = resolve(args.out);
  const pluginsRoot = join(out, "dynamic-plugins-root");
  mkdirSync(pluginsRoot, { recursive: true });
  // The image runs as a non-root user that has to write into the bind mount.
  chmodSync(pluginsRoot, 0o777);

  const target = resolveTarget();
  console.log(
    `Chart: ${target.chartVersion ?? "-"}\nImage: ${target.image}\nCatalog index: ${target.catalogIndex}`,
  );

  const indexFile = join(out, "dynamic-plugins.default.yaml");
  run(join(REPO_ROOT, "scripts", "extractCatalogIndex.sh"), [
    target.catalogIndex,
    indexFile,
  ]);
  const fromIndex = indexPackages(indexFile);

  const exclusions = loadExclusions(
    join(HARNESS_ROOT, "release-sanity-excludes.txt"),
  );
  const excluded = excluderFor(exclusions, "install");
  const isExcluded = (pkg: string) =>
    excluded(imageBaseName(pkg)) !== undefined;

  const communityEntries = collectPackages(REPO_ROOT).filter(
    (p) => p.support === "community" && p.artifact.startsWith("oci://"),
  );
  const community: CommunityPlugin[] = communityEntries
    .filter(
      (p) => excluded(p.packageName) === undefined && !isExcluded(p.artifact),
    )
    .map((p) => ({
      packageName: p.packageName,
      artifact: p.artifact,
      pluginConfig: firstAppConfigExample(p.workspace, p.file),
    }));

  const dynamicPlugins = buildDynamicPluginsConfig(
    fromIndex,
    community,
    isExcluded,
  );
  // One package the registry cannot serve aborts the whole install, so probe first and
  // report those instead of losing the run to them.
  const { unresolved } = await partitionResolvable(
    dynamicPlugins.plugins
      .filter((p) => p.enabled && p.package.startsWith("oci://"))
      .map((p) => p.package),
    probeRegistry,
  );
  const unresolvedRefs = new Set(unresolved.map((u) => u.ref));
  for (const plugin of dynamicPlugins.plugins) {
    if (unresolvedRefs.has(plugin.package)) plugin.enabled = false;
  }
  const requested = dynamicPlugins.plugins.filter((p) => p.enabled);
  const skipped = [
    ...dynamicPlugins.plugins
      .filter((p) => !p.enabled && !unresolvedRefs.has(p.package))
      .map((p) => imageBaseName(p.package)),
    ...communityEntries
      .filter((p) => !community.some((c) => c.artifact === p.artifact))
      .map((p) => imageBaseName(p.artifact)),
  ];
  writeFileSync(join(out, "dynamic-plugins.yaml"), stringify(dynamicPlugins));

  // Config layers, merged by the backend in this order: the shared smoke base, the
  // harness dummies, each workspace's own smoke config, then guest sign-in for the
  // loaded-plugins call. Env: each workspace's test.env, then dummies for the rest.
  const configDir = join(out, "config");
  mkdirSync(configDir, { recursive: true });
  const layers = ["dummies.yaml"];
  writeFileSync(
    join(configDir, "dummies.yaml"),
    stringify(buildDummyConfig(requested.map((p) => imageBaseName(p.package)))),
  );
  const env: Record<string, string> = {};
  for (const ws of [...new Set(communityEntries.map((p) => p.workspace))]) {
    const { appConfig, testEnv } = discoverSmokeTestConfig(REPO_ROOT, ws);
    if (appConfig) {
      layers.push(`workspace-${ws}.yaml`);
      writeFileSync(
        join(configDir, `workspace-${ws}.yaml`),
        readFileSync(appConfig),
      );
    }
    if (testEnv)
      for (const key of loadEnvFile(testEnv)) env[key] = process.env[key] ?? "";
  }
  layers.push("guest.yaml");
  writeFileSync(
    join(configDir, "guest.yaml"),
    stringify({
      auth: {
        environment: "development",
        providers: { guest: { dangerouslyAllowOutsideDevelopment: true } },
      },
    }),
  );
  const configTexts = layers.map((l) =>
    readFileSync(join(configDir, l), "utf8"),
  );
  for (const name of unsetEnvVars(
    [
      readFileSync(indexFile, "utf8"),
      stringify(dynamicPlugins),
      ...configTexts,
    ],
    new Set(Object.keys(env)),
  )) {
    env[name] = DUMMY_ENV_VALUE;
  }
  writeFileSync(
    join(out, "release-sanity.env"),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  );

  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  const backendCmd = [
    `./install-dynamic-plugins.sh ${APP_ROOT}/dynamic-plugins-root`,
    [
      "exec node packages/backend --config app-config.yaml",
      `--config ${APP_ROOT}/dynamic-plugins-root/app-config.dynamic-plugins.yaml`,
      ...layers.map((l) => `--config ${APP_ROOT}/release-sanity-config/${l}`),
    ].join(" "),
  ].join(" && ");
  run("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER,
    "--platform",
    "linux/amd64",
    "-p",
    `${PORT}:${PORT}`,
    "--env-file",
    join(out, "release-sanity.env"),
    "-e",
    `CATALOG_INDEX_IMAGE=${target.catalogIndex}`,
    "-v",
    `${join(HARNESS_ROOT, "..", "smoke-tests", "app-config.yaml")}:${APP_ROOT}/app-config.yaml:ro`,
    "-v",
    `${configDir}:${APP_ROOT}/release-sanity-config:ro`,
    "-v",
    `${join(out, "dynamic-plugins.yaml")}:${APP_ROOT}/dynamic-plugins.yaml:ro`,
    "-v",
    `${pluginsRoot}:${APP_ROOT}/dynamic-plugins-root`,
    "--entrypoint",
    "/bin/bash",
    target.image,
    "-c",
    backendCmd,
  ]);

  const startupError = await waitForBackend();
  let loaded = new Set<string>();
  let apiError: string | undefined;
  if (!startupError) {
    try {
      loaded = await loadedPlugins();
    } catch (err) {
      apiError = err instanceof Error ? err.message : String(err);
    }
  }
  const log = spawnSync("docker", ["logs", CONTAINER], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const fullLog = `${log.stdout}${log.stderr}`;
  writeFileSync(join(out, "container.log"), fullLog);
  if (!args.keep)
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });

  const installed = scanInstalled(pluginsRoot);
  const report: SanityReport = {
    chartVersion: target.chartVersion,
    image: target.image,
    catalogIndex: target.catalogIndex,
    requested: requested.length,
    installed: installed.length,
    loaded: loaded.size,
    notLoaded: startupError || apiError ? [] : notLoaded(installed, loaded),
    excluded: [...new Set(skipped)].sort(),
    unresolved,
    failures: failureLines(fullLog),
    startupError: startupError ?? apiError,
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  const summary = renderSummary(report, args["run-url"]);
  writeFileSync(join(out, "summary.md"), summary + "\n");
  console.log(`\n${summary}`);
  return passed(report) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
