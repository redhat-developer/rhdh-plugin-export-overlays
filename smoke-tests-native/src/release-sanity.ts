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
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import { partitionResolvable, readIndexEntries } from "./catalog-index";
import { excluderFor, loadExclusions } from "./exclusions";
import { requireContained, resolveContained } from "./paths";
import { probeRegistry } from "./registry-probe";
import { buildDummyConfig } from "./plugin-config";
import { collectPackages } from "./support";
import { discoverSmokeTestConfig, type PackageEntry } from "./workspace";
import {
  DUMMY_ENV_VALUE,
  buildDynamicPluginsConfig,
  chartStream,
  backendStartupFailed,
  failedPluginIds,
  failureLines,
  imageBaseName,
  imagesFromChartValues,
  installDirName,
  normalizeChartVersion,
  isImageRef,
  mergeAppConfig,
  newestCiChart,
  notInstalled,
  notLoaded,
  parseEnvFile,
  parseLoadedPlugins,
  passed,
  renderError,
  renderSummary,
  unsetEnvVars,
  type CommunityPlugin,
  type DynamicPluginsConfig,
  type InstalledPlugin,
  type SanityReport,
} from "./release-sanity-logic";
import { compareStrings, isRecord } from "./util";

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
    out: { type: "string", default: "release-sanity-out" },
    "run-url": { type: "string" },
    keep: { type: "boolean", default: false },
    // The community metadata here is main's, which builds the newest stream; checking
    // another stream's chart against it would mix versions.
    "only-newest-stream": { type: "boolean", default: false },
  },
});

/**
 * The absolute path of a tool on PATH, so commands are never resolved by the shell's
 * PATH lookup at spawn time (Sonar S4036), the way native-smoke.ts runs its CLI.
 */
function tool(name: "docker" | "helm" | "skopeo"): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${name} not found on PATH`);
}

function run(cmd: string, argv: string[]): string {
  return execFileSync(cmd, argv, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveTarget(): {
  chartVersion: string;
  image: string;
  catalogIndex: string;
} {
  if (args.stream && args["chart-version"]) {
    throw new Error("--stream and --chart-version are mutually exclusive");
  }
  const tags = (): string[] =>
    JSON.parse(
      run(tool("skopeo"), ["list-tags", "--no-creds", `docker://${CHART}`]),
    ).Tags as string[];
  // Rebuilt from its numbers, so only a well-formed version reaches helm.
  const chartVersion = args["chart-version"]
    ? normalizeChartVersion(args["chart-version"])
    : newestCiChart(tags(), args.stream);
  if (args["only-newest-stream"]) {
    const newest = chartStream(newestCiChart(tags()));
    if (chartStream(chartVersion) !== newest) {
      throw new Error(
        `only the ${newest} stream is supported for now, got ${chartVersion}`,
      );
    }
  }
  const { image, catalogIndex } = imagesFromChartValues(
    run(tool("helm"), [
      "show",
      "values",
      `oci://${CHART}`,
      "--version",
      chartVersion,
    ]),
  );
  // Chart values become docker and skopeo arguments; hold them to one shape.
  for (const ref of [image, catalogIndex]) {
    if (!isImageRef(ref)) throw new Error(`chart values: bad image '${ref}'`);
  }
  return { chartVersion, image, catalogIndex };
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
    tool("docker"),
    ["inspect", "-f", "{{.State.Running}}", CONTAINER],
    {
      encoding: "utf8",
    },
  );
  return state.stdout.trim() === "true";
}

function containerLog(tail?: number): string {
  const argv = ["logs", ...(tail ? ["--tail", String(tail)] : []), CONTAINER];
  const log = spawnSync(tool("docker"), argv, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return `${log.stdout}${log.stderr}`;
}

async function waitForBackend(): Promise<string | undefined> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!containerRunning())
      return "the container exited before the backend was ready";
    if (backendStartupFailed(containerLog(500)))
      return "a plugin failed startup and the backend gave up";
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

// Inside the working directory, like every path flag in this harness (Sonar S8707).
const outArg = resolveContained(args.out);

function removeContainer(): void {
  spawnSync(tool("docker"), ["rm", "-f", CONTAINER], { stdio: "ignore" });
}

type PluginPlan = {
  indexFile: string;
  dynamicPlugins: DynamicPluginsConfig;
  requested: DynamicPluginsConfig["plugins"];
  skipped: string[];
  unresolved: Array<{ ref: string; error: string }>;
  communityEntries: PackageEntry[];
};

/** Every index and community package, probed, with the ones that cannot run left off. */
async function planPlugins(
  out: string,
  catalogIndex: string,
): Promise<PluginPlan> {
  const indexFile = join(out, "dynamic-plugins.default.yaml");
  run(join(REPO_ROOT, "scripts", "extractCatalogIndex.sh"), [
    catalogIndex,
    indexFile,
  ]);
  const fromIndex = readIndexEntries(indexFile)
    .map((entry) => entry.package)
    .filter((pkg): pkg is string => typeof pkg === "string");

  const exclusions = loadExclusions(
    join(HARNESS_ROOT, "release-sanity-excludes.txt"),
  );
  const installExcluder = excluderFor(exclusions, "install");
  const isExcluded = (ref: string) =>
    installExcluder(imageBaseName(ref)) !== undefined;

  const communityEntries = collectPackages(REPO_ROOT).filter(
    (p) => p.support === "community" && p.artifact.startsWith("oci://"),
  );
  const community: CommunityPlugin[] = communityEntries
    .filter((p) => installExcluder(p.packageName) === undefined)
    .map((p) => ({ packageName: p.packageName, artifact: p.artifact }));

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
  return {
    indexFile,
    dynamicPlugins,
    requested,
    skipped,
    unresolved,
    communityEntries,
  };
}

/** Writes the config layers and env file the container starts with; returns the layers. */
function writeConfigAndEnv(
  out: string,
  { indexFile, dynamicPlugins, requested, communityEntries }: PluginPlan,
): string[] {
  // Config layers, merged by the backend in this order: the shared smoke base, every
  // installed community plugin's first appConfigExample, the harness dummies, each
  // workspace's own smoke config, then guest sign-in for the loaded-plugins call.
  // Env: each workspace's test.env, then dummies for the rest.
  const configDir = join(out, "config");
  mkdirSync(configDir, { recursive: true });
  const enabledRefs = new Set(requested.map((p) => p.package));
  writeFileSync(
    join(configDir, "community-examples.yaml"),
    stringify(
      mergeAppConfig(
        communityEntries
          .filter((p) => enabledRefs.has(p.artifact))
          .map((p) => firstAppConfigExample(p.workspace, p.file) ?? {}),
      ),
    ),
  );
  const layers = ["community-examples.yaml", "dummies.yaml"];
  writeFileSync(
    join(configDir, "dummies.yaml"),
    stringify(
      buildDummyConfig(requested.map((p) => installDirName(p.package))),
    ),
  );
  const env: Record<string, string> = {};
  for (const ws of new Set(communityEntries.map((p) => p.workspace))) {
    const { appConfig, testEnv } = discoverSmokeTestConfig(REPO_ROOT, ws);
    if (appConfig) {
      layers.push(`workspace-${ws}.yaml`);
      writeFileSync(
        join(configDir, `workspace-${ws}.yaml`),
        readFileSync(appConfig),
      );
    }
    if (testEnv) {
      // A variable already set in the environment (a real token) wins over the
      // committed placeholder, as in the Docker smoke.
      for (const [key, value] of Object.entries(
        parseEnvFile(readFileSync(testEnv, "utf8")),
      )) {
        env[key] = process.env[key] ?? value;
      }
    }
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
  return layers;
}

/** Starts the image: install every plugin (retried), then boot with the config layers. */
function startContainer(
  out: string,
  target: { image: string; catalogIndex: string },
  layers: string[],
): void {
  const pluginsRoot = join(out, "dynamic-plugins-root");
  removeContainer();
  // The install CLI does not retry, so one registry hiccup among ~170 pulls would fail
  // the run. It is idempotent and keeps what it already installed, so retry it.
  const install = `./install-dynamic-plugins.sh ${APP_ROOT}/dynamic-plugins-root`;
  const backendCmd = [
    `{ ${install} || { sleep 15; ${install}; } || { sleep 30; ${install}; }; }`,
    [
      "exec node packages/backend --config app-config.yaml",
      `--config ${APP_ROOT}/dynamic-plugins-root/app-config.dynamic-plugins.yaml`,
      ...layers.map((l) => `--config ${APP_ROOT}/release-sanity-config/${l}`),
    ].join(" "),
  ].join(" && ");
  run(tool("docker"), [
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
    `${join(out, "config")}:${APP_ROOT}/release-sanity-config:ro`,
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
}

async function main(): Promise<number> {
  const out = requireContained("--out", args.out);
  const pluginsRoot = join(out, "dynamic-plugins-root");
  // A previous run's plugins would be reported as "already installed" rather than
  // installed, and counted again by the directory scan.
  rmSync(pluginsRoot, { recursive: true, force: true });
  mkdirSync(pluginsRoot, { recursive: true });
  // The image runs as a non-root user that has to write into the bind mount.
  chmodSync(pluginsRoot, 0o777);

  const target = resolveTarget();
  console.log(
    `Chart: ${target.chartVersion}\nImage: ${target.image}\nCatalog index: ${target.catalogIndex}`,
  );

  const plan = await planPlugins(out, target.catalogIndex);
  const { requested, skipped, unresolved } = plan;
  const layers = writeConfigAndEnv(out, plan);

  startContainer(out, target, layers);

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
  const fullLog = containerLog();
  writeFileSync(join(out, "container.log"), fullLog);

  const installed = scanInstalled(pluginsRoot);
  const report: SanityReport = {
    chartVersion: target.chartVersion,
    image: target.image,
    catalogIndex: target.catalogIndex,
    requested: requested.length,
    installed: installed.length,
    loaded: loaded.size,
    notLoaded: startupError || apiError ? [] : notLoaded(installed, loaded),
    skipped: [...new Set(skipped)].sort(compareStrings),
    unresolved,
    notInstalled: notInstalled(
      requested.map((p) => p.package),
      fullLog,
    ),
    failures: failureLines(fullLog),
    failedPlugins: failedPluginIds(fullLog),
    startupError: startupError ?? apiError,
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  const summary = renderSummary(report, args["run-url"]);
  writeFileSync(join(out, "summary.md"), summary + "\n");
  console.log(`\n${summary}`);
  return passed(report) ? 0 : 1;
}

const code = await main().catch((err: unknown) => {
  // Still leave a summary, so the issue says why instead of "no report".
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  if (outArg) {
    mkdirSync(outArg, { recursive: true });
    writeFileSync(
      join(outArg, "summary.md"),
      renderError(message, args["run-url"]) + "\n",
    );
  }
  return 2;
});
if (!args.keep) removeContainer();
process.exit(code);
