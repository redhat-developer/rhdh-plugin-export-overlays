#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    pluginsYaml: null,
    configs: [],
    envFile: null,
    pluginsRoot: resolve(__dirname, "dynamic-plugins-root"),
    resultsFile: resolve(__dirname, "results.json"),
    skipDownload: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--plugins-yaml":
        args.pluginsYaml = resolve(argv[++i]);
        break;
      case "--config":
        args.configs.push(resolve(argv[++i]));
        break;
      case "--env-file":
        args.envFile = resolve(argv[++i]);
        break;
      case "--skip-download":
        args.skipDownload = true;
        break;
    }
  }
  if (!args.pluginsYaml) {
    console.error(
      "Usage: node smoke-test.mjs --plugins-yaml <path> [--config <path>...] [--env-file <path>] [--skip-download]",
    );
    process.exit(1);
  }
  return args;
}

function loadEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

// ---------------------------------------------------------------------------
// Plugins YAML
// ---------------------------------------------------------------------------

function parsePluginsYaml(filePath) {
  const doc = yaml.load(readFileSync(filePath, "utf8"));
  return (doc?.plugins ?? []).filter((p) => !p.disabled);
}

function parseOciRef(packageStr) {
  const cleaned = packageStr.replace(/^"/, "").replace(/"$/, "");
  const withoutOci = cleaned.replace(/^oci:\/\//, "");
  const bangIdx = withoutOci.indexOf("!");
  if (bangIdx === -1) return { imageRef: withoutOci, pluginPath: null };
  return {
    imageRef: withoutOci.slice(0, bangIdx),
    pluginPath: withoutOci.slice(bangIdx + 1),
  };
}

const FRONTEND_ROLES = new Set(["frontend-plugin", "frontend-plugin-module"]);

function isFrontendRole(role) {
  return FRONTEND_ROLES.has(role);
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function deepMerge(src, dst) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      dst[k] = dst[k] ?? {};
      deepMerge(v, dst[k]);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

function loadConfigs(configPaths) {
  const merged = {};
  for (const p of configPaths) {
    if (!existsSync(p)) continue;
    const doc = yaml.load(readFileSync(p, "utf8"));
    if (doc && typeof doc === "object") deepMerge(doc, merged);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Frontend bundle validation (Layer 1)
// ---------------------------------------------------------------------------

function findJsFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (findJsFiles(full)) return true;
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}

function validateFrontendBundles(plugins, pluginsRoot) {
  const results = [];
  for (const plugin of plugins) {
    const { pluginPath } = parseOciRef(plugin.package);
    if (!pluginPath) continue;

    const { pkgName, role } = readPluginMeta(pluginsRoot, pluginPath);
    if (!isFrontendRole(role)) continue;

    const scalprumDir = join(pluginsRoot, pluginPath, "dist-scalprum");

    if (!existsSync(scalprumDir)) {
      results.push({
        pkgName,
        role,
        pluginPath,
        status: "fail-bundle",
        detail: "dist-scalprum/ directory missing",
      });
      continue;
    }

    if (!findJsFiles(scalprumDir)) {
      results.push({
        pkgName,
        role,
        pluginPath,
        status: "fail-bundle",
        detail: "dist-scalprum/ contains no .js/.mjs/.cjs files",
      });
      continue;
    }

    results.push({ pkgName, role, pluginPath, status: "pass" });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Backend boot (startTestBackend + probe plugin)
// ---------------------------------------------------------------------------

async function bootBackend(configData) {
  const { startTestBackend, mockServices } =
    await import("@backstage/backend-test-utils");
  const {
    dynamicPluginsFeatureLoader,
    CommonJSModuleLoader,
    dynamicPluginsFrontendServiceRef,
    dynamicPluginsServiceRef,
  } = await import("@backstage/backend-dynamic-feature-service");
  const { PackageRoles } = await import("@backstage/cli-node");
  const { createServiceFactory, createBackendPlugin, coreServices } =
    await import("@backstage/backend-plugin-api");
  const path = await import("node:path");

  const smokeTestProbePlugin = createBackendPlugin({
    pluginId: "smoke-test-probe",
    register(env) {
      env.registerInit({
        deps: {
          http: coreServices.httpRouter,
          dynamicPlugins: dynamicPluginsServiceRef,
        },
        async init({ http, dynamicPlugins }) {
          const { Router } = await import("express");
          const router = Router();
          router.get("/loaded-plugins", (_, res) => {
            res.json(dynamicPlugins.plugins({ includeFailed: true }));
          });
          http.use(router);
          try {
            http.addAuthPolicy({
              path: "/loaded-plugins",
              allow: "unauthenticated",
            });
          } catch {
            /* API may not exist on this version */
          }
        },
      });
    },
  });

  const { server } = await startTestBackend({
    features: [
      mockServices.rootConfig.factory({ data: configData }),
      dynamicPluginsFeatureLoader({
        schemaLocator(pluginPackage) {
          const platform = PackageRoles.getRoleInfo(
            pluginPackage.manifest.backstage.role,
          ).platform;
          return path.join(
            platform === "node" ? "dist" : "dist-scalprum",
            "configSchema.json",
          );
        },
        moduleLoader: (logger) => new CommonJSModuleLoader({ logger }),
      }),
      createServiceFactory({
        service: dynamicPluginsFrontendServiceRef,
        deps: {},
        factory: () => ({ setResolverProvider() {} }),
      }),
      smokeTestProbePlugin,
    ],
  });

  const addr = server.address();
  const port = typeof addr === "object" ? addr.port : 7007;
  return { server, port };
}

// ---------------------------------------------------------------------------
// Plugin metadata & route probing
// ---------------------------------------------------------------------------

function readPluginMeta(pluginsRoot, pluginPath) {
  try {
    const pkg = JSON.parse(
      readFileSync(join(pluginsRoot, pluginPath, "package.json"), "utf8"),
    );
    return {
      pkgName: pkg.name ?? pluginPath,
      role: pkg.backstage?.role ?? "unknown",
      pluginId: pkg.backstage?.pluginId ?? null,
    };
  } catch {
    return { pkgName: pluginPath, role: "unknown", pluginId: null };
  }
}

async function probePluginRoutes(plugins, port, pluginsRoot) {
  const results = [];
  for (const plugin of plugins) {
    const { pluginPath } = parseOciRef(plugin.package);
    if (!pluginPath) continue;

    const { pkgName, role, pluginId } = readPluginMeta(pluginsRoot, pluginPath);

    if (isFrontendRole(role)) continue;

    if (role !== "backend-plugin") {
      results.push({ pkgName, role, pluginPath, status: "skip" });
      continue;
    }

    if (!pluginId) {
      results.push({
        pkgName,
        role,
        pluginPath,
        status: "warn",
        http: 0,
        pluginId: "(unknown)",
      });
      continue;
    }

    try {
      const res = await fetch(`http://localhost:${port}/api/${pluginId}`);
      results.push({
        pkgName,
        role,
        pluginPath,
        pluginId,
        status: res.status === 404 ? "warn" : "pass",
        http: res.status,
      });
    } catch (err) {
      results.push({
        pkgName,
        role,
        pluginPath,
        pluginId,
        status: "fail",
        error: err.message,
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Frontend plugin probing (Layer 2)
// ---------------------------------------------------------------------------

async function probeFrontendPlugins(plugins, port, pluginsRoot) {
  const frontendPlugins = [];
  for (const plugin of plugins) {
    const { pluginPath } = parseOciRef(plugin.package);
    if (!pluginPath) continue;
    const meta = readPluginMeta(pluginsRoot, pluginPath);
    if (isFrontendRole(meta.role)) {
      frontendPlugins.push({ ...meta, pluginPath });
    }
  }

  if (frontendPlugins.length === 0) return [];

  const failAll = (detail) =>
    frontendPlugins.map((fp) => ({
      pkgName: fp.pkgName,
      role: fp.role,
      pluginPath: fp.pluginPath,
      status: "fail-load",
      detail,
    }));

  let res;
  try {
    res = await fetch(
      `http://localhost:${port}/api/smoke-test-probe/loaded-plugins`,
    );
  } catch (err) {
    return failAll(`probe endpoint unreachable: ${err.message}`);
  }

  if (!res.ok) {
    return failAll(`probe returned HTTP ${res.status}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return failAll("invalid probe response");
  }

  if (!Array.isArray(body)) {
    return failAll("invalid probe response");
  }

  const results = [];
  for (const fp of frontendPlugins) {
    const loaded = body.find(
      (lp) => lp && typeof lp === "object" && lp.name === fp.pkgName,
    );

    if (!loaded) {
      results.push({
        pkgName: fp.pkgName,
        role: fp.role,
        pluginPath: fp.pluginPath,
        status: "fail-load",
        detail: "not found in loaded plugins list",
      });
    } else if (loaded.platform !== "web") {
      results.push({
        pkgName: fp.pkgName,
        role: fp.role,
        pluginPath: fp.pluginPath,
        status: "fail-load",
        detail: `unexpected platform: ${loaded.platform}`,
      });
    } else if (loaded.failure) {
      results.push({
        pkgName: fp.pkgName,
        role: fp.role,
        pluginPath: fp.pluginPath,
        status: "fail-load",
        detail: `plugin loaded with failure: ${loaded.failure}`,
      });
    } else {
      results.push({
        pkgName: fp.pkgName,
        role: fp.role,
        pluginPath: fp.pluginPath,
        status: "pass",
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportAndWrite(results, resultsFile) {
  console.log("\n========== Smoke Test Results ==========\n");
  const failedPlugins = [];

  for (const r of results) {
    switch (r.status) {
      case "skip":
        console.log(`  SKIP  ${r.pkgName}  (${r.role})`);
        break;
      case "pass":
        if (r.pluginId) {
          console.log(
            `  PASS  ${r.pkgName}  → /api/${r.pluginId}  (${r.http})`,
          );
        } else if (isFrontendRole(r.role)) {
          console.log(`  PASS  ${r.pkgName}  (${r.role})`);
        }
        break;
      case "warn":
        console.log(
          `  WARN  ${r.pkgName}  → /api/${r.pluginId}  (404 — pluginId guess may be wrong)`,
        );
        break;
      case "fail-bundle":
        console.log(`  FAIL  ${r.pkgName}  [bundle] ${r.detail}`);
        failedPlugins.push(r.pkgName);
        break;
      case "fail-load":
        console.log(`  FAIL  ${r.pkgName}  [load] ${r.detail}`);
        failedPlugins.push(r.pkgName);
        break;
      default:
        console.log(`  FAIL  ${r.pkgName}  ${r.error}`);
        failedPlugins.push(r.pkgName);
    }
  }

  const be = { pass: 0, warn: 0, skip: 0, fail: 0 };
  const fe = { pass: 0, fail: 0 };
  for (const r of results) {
    const isFe = isFrontendRole(r.role);
    if (r.status === "fail-bundle" || r.status === "fail-load") {
      if (isFe) fe.fail++;
      else be.fail++;
    } else if (isFe) {
      fe[r.status] = (fe[r.status] ?? 0) + 1;
    } else {
      be[r.status] = (be[r.status] ?? 0) + 1;
    }
  }
  const total = results.length;
  const totalFail = be.fail + fe.fail;
  console.log(
    `\n  Total: ${total}  Backend: ${be.pass} pass / ${be.warn} warn / ${be.fail} fail / ${be.skip} skip  Frontend: ${fe.pass} pass / ${fe.fail} fail\n`,
  );

  const success = totalFail === 0;
  writeFileSync(
    resultsFile,
    JSON.stringify({ success, failedPlugins, results }, null, 2),
  );
  return success;
}

// ---------------------------------------------------------------------------
// Result merging
// ---------------------------------------------------------------------------

function mergeFrontendResults(bundleResults, loadResults) {
  const loadMap = new Map();
  for (const r of loadResults) {
    if (!loadMap.has(r.pkgName)) loadMap.set(r.pkgName, r);
  }

  return bundleResults.map((br) => {
    if (br.status === "fail-bundle") return br;

    const lr = loadMap.get(br.pkgName);
    if (!lr) {
      return {
        ...br,
        status: "fail-load",
        detail: "missing load probe result",
      };
    }
    if (lr.status === "fail-load") return lr;
    return { ...br, status: "pass" };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("\n=== RHDH Smoke Test (Docker-free) ===\n");

  console.log("1. Loading plugin configuration");
  const plugins = parsePluginsYaml(args.pluginsYaml);
  if (!plugins.length) {
    console.log("  No enabled plugins found.");
    process.exit(0);
  }
  console.log(`  ${plugins.length} plugin(s) enabled`);

  loadEnvFile(args.envFile);

  if (!args.skipDownload) {
    console.log(
      "\n2. Plugin download expected via install-dynamic-plugins.py pre-step",
    );
  } else {
    console.log("\n2. Skipping download (--skip-download)");
  }

  if (!existsSync(args.pluginsRoot)) {
    console.error(
      `  ERROR: plugins root directory not found: ${args.pluginsRoot}`,
    );
    console.error(
      "  Run install-dynamic-plugins.py first, or use --skip-download with a pre-populated directory.",
    );
    process.exit(1);
  }

  const generatedCfg = join(
    args.pluginsRoot,
    "app-config.dynamic-plugins.yaml",
  );
  if (!existsSync(generatedCfg)) {
    console.warn(
      `  WARN: ${generatedCfg} not found — install-dynamic-plugins.py may not have been run`,
    );
  }

  console.log("\n2b. Validating frontend bundles");
  const bundleResults = validateFrontendBundles(plugins, args.pluginsRoot);
  const bundleFailCount = bundleResults.filter(
    (r) => r.status === "fail-bundle",
  ).length;
  console.log(
    `  ${bundleResults.length} frontend plugin(s) checked, ${bundleFailCount} failed`,
  );

  console.log("\n3. Booting Backstage backend (startTestBackend)");
  const allConfigPaths = [...args.configs];
  if (existsSync(generatedCfg)) allConfigPaths.push(generatedCfg);
  const configData = loadConfigs(allConfigPaths);
  const { server, port } = await bootBackend(configData);

  let success = false;
  try {
    console.log("\n4a. Probing backend plugin routes");
    const backendResults = await probePluginRoutes(
      plugins,
      port,
      args.pluginsRoot,
    );

    console.log("\n4b. Probing frontend loaded plugins");
    const frontendLoadResults = await probeFrontendPlugins(
      plugins,
      port,
      args.pluginsRoot,
    );

    const frontendResults = mergeFrontendResults(
      bundleResults,
      frontendLoadResults,
    );

    const allResults = [...backendResults, ...frontendResults];
    success = reportAndWrite(allResults, args.resultsFile);
  } finally {
    console.log("Shutting down backend...");
    server.close();
  }

  process.exit(success ? 0 : 1);
}

await main().catch((err) => {
  console.error("\nSmoke test failed:", err.message || err);
  process.exit(1);
});
