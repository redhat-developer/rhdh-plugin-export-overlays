# Native (Docker-free) smoke harness

Validates RHDH dynamic **backend** plugins in-process — install via the published
`install-dynamic-plugins` CLI, then boot with `startTestBackend` — with **no Docker
container and no cluster**. About **20x faster** than the per-workspace `docker run rhdh`
smoke-test it replaces for that scope.

**Tickets:** RHIDP-15075, RHIDP-15076, RHIDP-13530 (epic RHIDP-13501).

## Why

The repo's container smoke-test boots RHDH in Docker (`docker run rhdh …`) just to check a
plugin loads. An earlier native attempt (PR #2231) was closed because it was 694 lines of
bespoke OCI parsing and predated the npm CLI. Now that `install-dynamic-plugins` is
published — and RHDH already uses it in-process in `plugin-dynamic-loading.spec.ts`
(PR #4967) — that extraction collapses to one CLI call, so the smoke validation runs
in-process with no container.

## What it does

```
install CLI (extract OCI → dynamic-plugins-root, run with cwd=root)
  → discoverPlugins()         # scan install dirs, classify by package.json backstage.role
  → loadBackendPlugins()      # require() each, assert default BackendFeature
  → startTestBackend()        # boot core + loaded features in-process (+ rootConfig)
  → validateFrontendBundle()  # legacy and/or new-FE bundle present (not executed)
  → results.json + exit code
```

### Frontend bundle validation (both frontend systems)

The presence check recognizes both packagings and records which one(s) each plugin
ships in `results.json` (`frontend.bundles[].systems`):

| System | Required artifacts | Example plugin |
|---|---|---|
| Legacy (Scalprum) | `dist-scalprum/` + `plugin-manifest.json` | most current plugins |
| New frontend system (module federation) | `dist/remoteEntry.js` + `dist/mf-manifest.json` | `app-auth` (new-FE only) |
| Dual | both layouts | `tech-radar` |

A present-but-incomplete layout fails even if the other system's layout is valid.

`src/loader.ts` and `src/{module-resolution,plugin-config}.ts` are ported from RHDH
PR #4967; `discoverPlugins()` replaces RHDH's `loadManifest()` because this CLI version
lays out one dir per plugin instead of emitting a `manifest.json`.

## What it deliberately does NOT do

It does **not render frontend UI**. `startTestBackend` is backend-only. UI-behaviour tests
(the 24 overlay `e2e-tests`, which are ~all Playwright `uiHelper`-driven) need a real
frontend — that is the **NFS / app-next** path (RHIDP-15082), intentionally out of scope.

## Run

Requires Node 24 and Yarn 4 (matching the repo's `versions.json` and the sibling
`workspaces/*/e2e-tests`), plus registry access to pull the OCI plugin images.

```bash
yarn install

cat > dp.yaml <<'YAML'
plugins:
  - package: oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/<plugin>:<tag>!<name>
YAML
yarn smoke --dynamic-plugins dp.yaml
```

### Workspace mode

Validate ALL published plugins of a workspace together — the same unit the Docker
smoke covers:

```bash
yarn smoke --workspace mcp-integrations
```

It resolves every `oci://` `spec.dynamicArtifact` from
`workspaces/<name>/metadata/*.yaml` and installs/boots them in one run. Metadata
whose artifact is a local `./dynamic-plugins/dist/…` path (plugin bundled inside the
RHDH image, no published OCI artifact — e.g. `scaffolder-backend-module-kubernetes`)
is skipped with a warning and recorded in `results.json`
(`workspace.skippedMetadata`); a workspace with no `oci://` refs at all reports
`status: error` (nothing to validate). `--workspace` and `--dynamic-plugins` are
mutually exclusive.

Workspace mode also auto-discovers the workspace's Docker-smoke test config —
`workspaces/<name>/smoke-tests/app-config.test.yaml` and `smoke-tests/test.env` —
when present. Explicit `--app-config`/`--test-env` flags win over discovered files.

### Test config (parity with the Docker smoke)

Workspaces that ship `smoke-tests/app-config.test.yaml` and/or `smoke-tests/test.env`
(consumed by the Docker smoke as an extra `--config` mount and `docker run --env-file`)
are supported via two optional flags:

```bash
yarn smoke --dynamic-plugins dp.yaml \
  --app-config ../workspaces/<name>/smoke-tests/app-config.test.yaml \
  --test-env   ../workspaces/<name>/smoke-tests/test.env
```

- `--test-env`: `KEY=VALUE` lines loaded into the process env. Variables already set
  (e.g. real CI secrets) win over the committed placeholders. (Named `--test-env`
  because Node claims `--env-file` for itself even after the script path.)
- `--app-config`: extra app-config layer, deep-merged over the harness's built-in dummy
  config (the file wins). `${VAR}` / `${VAR:-default}` are substituted from the env with
  the Backstage config loader's semantics: `$$` escapes to a literal `$`, and a value
  referencing an unset variable with no default is dropped (with a warning), not
  replaced by an empty string.

`yarn test` runs the unit tests (`node:test` over `src/*.test.ts` — workspace
resolution, name validation, env/app-config substitution, frontend bundle matrix);
`yarn check` runs `tsc --noEmit` + the tests. This is a standalone tool dir, not a
`workspaces/*/e2e-tests` one, so it is outside `e2e-code-quality.yaml` (which only scans
`workspaces/*/e2e-tests/**`).

### CI

`.github/workflows/native-smoke.yaml` runs the harness two ways:

- **`pull_request`** (paths `smoke-tests-native/**`): validates the harness itself on every
  change here, against a known-good pure-backend plugin.
- **`workflow_dispatch`**: Actions → "Native Smoke Harness" → Run workflow, with an optional
  `plugin_ref` (single ref) or `workspace` (all of a workspace's published plugins)
  to validate on demand.

It installs skopeo, builds, runs `yarn smoke`, uploads `results.json`, and fails the job on
a non-passing plugin.

Exit code `0` = pass; non-zero with `results.json` detailing `fail-load` / `fail-start` /
`fail-bundle`.

## Best fit (from the 64-workspace analysis, RHIDP-15076)

Of the 12 pure-backend workspaces, validated empirically:

- **Covered now (4)**: `mcp-integrations` (3 plugins boot together), `github-notifications`,
  `scaffolder-backend-module-{servicenow,sonarqube}` — load + backend start via their
  published OCI refs.
- **Catalog-gated (6)**: `3scale, ai-integrations, apiconnect, keycloak, pingidentity,
  scaffolder-relation-processor` — blocked by the upstream catalog-backend boot issue
  (see the caveat at the bottom); they stay on the Docker smoke for now.
- **No published OCI artifact (2)**: `scaffolder-backend-module-{kubernetes,regex}` —
  their released `dynamicArtifact` is a local `./dynamic-plugins/dist/…` path (plugin
  ships inside the RHDH image), so there is nothing for this harness to pull.

Beyond those:

- **32 smoke-tests** → replace the Docker container with this harness (backend start +
  frontend bundle/registration check).
- **24 UI e2e-tests** → NOT this harness; need the NFS/app-next render harness.

## Status of validation

- ✅ Install CLI interface confirmed: `@red-hat-developer-hub/cli-module-install-dynamic-plugins@0.3.0`
  (`install <dynamic-plugins-root>`), fetchable via `npx`.
- ✅ Harness logic ported from the **already-green** RHDH nightly test (PR #4967).
- ✅ Builds clean (esbuild → `dist/native-smoke.mjs`, run with plain `node`); `tsc --noEmit` passes.
- ✅ `patchModuleResolution()` ported (`src/module-resolution.ts`) so extracted plugins
  resolve their `@backstage/*` peers against this harness's `node_modules`. Requires a
  node-modules linker — see `.yarnrc.yml`.
- ✅ End-to-end run done locally (Node 24) against a real catalog-index plugin: `pass`,
  backend loaded 1/1, `startTestBackend` booted — see the Benchmark section below.

## Module resolution

Extracted plugins live under a temp dir with no `node_modules` of their own, so their bare
`@backstage/*` imports must resolve against this harness. `patchModuleResolution()` (ported
from RHDH PR #4967) extends `Module._nodeModulePaths` to append `HARNESS_NODE_MODULES`
before any plugin is `require`d. This is why the package uses `nodeLinker: node-modules`
(`.yarnrc.yml`) rather than Yarn PnP — the patch needs a real `node_modules` directory to
point at.

## Benchmark: native vs Docker (real run)

Same plugin both ways: `roadiehq-scaffolder-backend-module-http-request`
(`bs_1.49.4__5.6.0`), from the real catalog index
`quay.io/rhdh-community/plugin-catalog-index:1.11-bs_1.49.4`. Same minimal app-config
(sqlite `:memory:` + guest). Node 24. The RHDH base image (`quay.io/rhdh-community/rhdh:next`,
6.55 GB) was pre-pulled and is excluded from the Docker timing (one-time infra, amortized
across all workspaces in a CI run).

| Approach | What it does | Wall-clock |
|----------|--------------|------------|
| **Native (this harness)** | skopeo pull plugin → load → `startTestBackend` boot | **5 s cold, 3–4 s warm** |
| **Docker smoke** (`run-workspace-smoke-tests.yaml`) | container start → in-container `install-dynamic-plugins` (pulls same plugin) → full `node packages/backend` boot → `/healthcheck` 200 | **104 s** |

Roughly **20× faster cold, ~25–35× warm.** Both confirm the plugin loads; the Docker run
additionally boots the entire RHDH backend (that extra work is exactly the overhead the
in-process approach removes). Note the comparison is per-workspace — the Docker smoke boots
one container per workspace, which is the unit this harness replaces.

Caveat: the native harness currently boots a minimal backend scoped to the plugin's needs
(e.g. scaffolder for scaffolder modules). Catalog-extending modules need the catalog core,
which does not yet boot cleanly standalone — see the coreFeatures note in `src/native-smoke.ts`.
