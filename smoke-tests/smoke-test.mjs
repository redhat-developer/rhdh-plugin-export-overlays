#!/usr/bin/env node

import { spawnSync, execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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
    port: 7007,
    timeout: 120,
    pluginsRoot: resolve(__dirname, "dynamic-plugins-root"),
    resultsFile: resolve(__dirname, "results.json"),
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
      case "--port":
        args.port = Number.parseInt(argv[++i], 10);
        break;
      case "--timeout":
        args.timeout = Number.parseInt(argv[++i], 10);
        break;
    }
  }
  if (!args.pluginsYaml) {
    console.error(
      "Usage: node smoke-test.mjs --plugins-yaml <path> [--config <path>...] [--env-file <path>]",
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

// ---------------------------------------------------------------------------
// OCI Download  (mirrors install-dynamic-plugins.py §663-715)
// ---------------------------------------------------------------------------

function pullOciImage(imageRef, tmpDir) {
  const hash = createHash("sha256").update(imageRef).digest("hex").slice(0, 16);
  const localDir = join(tmpDir, hash);
  mkdirSync(localDir, { recursive: true });

  const result = spawnSync(
    "skopeo",
    [
      "copy",
      "--override-os=linux",
      "--override-arch=amd64",
      `docker://${imageRef}`,
      `dir:${localDir}`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(`skopeo copy failed for ${imageRef}`);

  const manifest = JSON.parse(
    readFileSync(join(localDir, "manifest.json"), "utf8"),
  );
  const [, filename] = manifest.layers[0].digest.split(":");
  return join(localDir, filename);
}

function extractPlugin(tarFile, pluginPath, dest) {
  mkdirSync(join(dest, pluginPath), { recursive: true });
  execSync(`tar xf "${tarFile}" -C "${dest}" "${pluginPath}/"`, {
    stdio: "pipe",
  });
}

async function downloadPlugins(plugins, dest) {
  mkdirSync(dest, { recursive: true });
  const tmpDir = resolve(__dirname, ".tmp-oci");
  mkdirSync(tmpDir, { recursive: true });

  const imageCache = new Map();
  for (const plugin of plugins) {
    const { imageRef, pluginPath } = parseOciRef(plugin.package);
    if (!imageRef || !pluginPath) {
      console.warn(`  Skip (invalid ref): ${plugin.package}`);
      continue;
    }
    console.log(`  ${pluginPath}`);
    let tarFile = imageCache.get(imageRef);
    if (!tarFile) {
      tarFile = pullOciImage(imageRef, tmpDir);
      imageCache.set(imageRef, tarFile);
    }
    extractPlugin(tarFile, pluginPath, dest);
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Config generation
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

function generateMergedConfig(plugins, pluginsRoot) {
  const cfg = { dynamicPlugins: { rootDirectory: pluginsRoot } };
  for (const p of plugins) if (p.pluginConfig) deepMerge(p.pluginConfig, cfg);
  const outPath = join(pluginsRoot, "app-config.dynamic-plugins.yaml");
  writeFileSync(outPath, yaml.dump(cfg));
  return outPath;
}

// ---------------------------------------------------------------------------
// Backend boot
// ---------------------------------------------------------------------------

async function bootBackend(configPaths) {
  process.argv = ["node", "smoke-test.mjs"];
  for (const p of configPaths) {
    if (existsSync(p)) process.argv.push("--config", p);
  }

  const { createBackend } = await import("@backstage/backend-defaults");
  const {
    dynamicPluginsFeatureLoader,
    CommonJSModuleLoader,
    dynamicPluginsFrontendServiceRef,
  } = await import("@backstage/backend-dynamic-feature-service");
  const { PackageRoles } = await import("@backstage/cli-node");
  const { createServiceFactory } =
    await import("@backstage/backend-plugin-api");
  const path = await import("node:path");

  const backend = createBackend();

  backend.add(
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
  );

  backend.add(
    createServiceFactory({
      service: dynamicPluginsFrontendServiceRef,
      deps: {},
      factory: () => ({ setResolverProvider() {} }),
    }),
  );

  backend.add(import("@backstage/plugin-catalog-backend"));
  backend.add(
    import("@backstage/plugin-catalog-backend-module-scaffolder-entity-model"),
  );
  backend.add(import("@backstage/plugin-catalog-backend-module-logs"));
  backend.add(import("@backstage/plugin-auth-backend"));
  backend.add(import("@backstage/plugin-auth-backend-module-guest-provider"));
  backend.add(import("@backstage/plugin-permission-backend"));
  backend.add(
    import("@backstage/plugin-permission-backend-module-allow-all-policy"),
  );
  backend.add(import("@backstage/plugin-scaffolder-backend"));
  backend.add(import("@backstage/plugin-events-backend"));
  backend.add(import("@backstage/plugin-search-backend"));
  backend.add(import("@backstage/plugin-search-backend-module-catalog"));
  backend.add(import("@backstage/plugin-proxy-backend"));

  await backend.start();
  return backend;
}

// ---------------------------------------------------------------------------
// Health & route probing
// ---------------------------------------------------------------------------

async function waitForReady(port, timeoutSec) {
  const url = `http://localhost:${port}/.backstage/health/v1/readiness`;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Backend not ready within ${timeoutSec}s`);
}

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
        console.log(`  PASS  ${r.pkgName}  → /api/${r.pluginId}  (${r.http})`);
        break;
      case "warn":
        console.log(
          `  WARN  ${r.pkgName}  → /api/${r.pluginId}  (404 — pluginId guess may be wrong)`,
        );
        break;
      default:
        console.log(`  FAIL  ${r.pkgName}  ${r.error}`);
        failedPlugins.push(r.pkgName);
    }
  }

  const counts = { pass: 0, warn: 0, skip: 0, fail: 0 };
  for (const r of results) counts[r.status]++;
  console.log(
    `\n  Total: ${results.length}  Pass: ${counts.pass}  Warn: ${counts.warn}  Skip: ${counts.skip}  Fail: ${counts.fail}\n`,
  );

  const success = counts.fail === 0;
  writeFileSync(
    resultsFile,
    JSON.stringify({ success, failedPlugins, results }, null, 2),
  );
  return success;
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

  console.log("\n2. Downloading OCI plugin images");
  await downloadPlugins(plugins, args.pluginsRoot);

  console.log("\n3. Generating merged plugin config");
  const generatedCfg = generateMergedConfig(plugins, args.pluginsRoot);

  console.log("\n4. Booting Backstage backend");
  const allConfigs = [...args.configs, generatedCfg];
  const backend = await bootBackend(allConfigs);

  let success = false;
  try {
    console.log("\n5. Waiting for readiness");
    await waitForReady(args.port, args.timeout);

    console.log("\n6. Probing plugin routes");
    const results = await probePluginRoutes(
      plugins,
      args.port,
      args.pluginsRoot,
    );
    success = reportAndWrite(results, args.resultsFile);
  } finally {
    console.log("Shutting down backend...");
    await backend.stop();
  }

  process.exit(success ? 0 : 1);
}

await main().catch((err) => {
  console.error("\nSmoke test failed:", err.message || err);
  process.exit(1);
});
