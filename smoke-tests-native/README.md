# Native (Docker-free) smoke harness — POC

**Tickets:** RHIDP-15075 (spike), RHIDP-15076 (identify), RHIDP-13530 (overlay coord)
**Status:** prototype / proof-of-concept

## Why

The overlay repo validates plugins two ways today:

- **32 smoke-tests** boot RHDH in a **Docker container** (`docker run rhdh …`) just to check
  a plugin loads.
- A previous attempt to replace that with a native Node harness — **PR #2231**
  ("replace Docker-based smoke tests with native Node.js harness") — was closed because
  (a) it was **694 lines of bespoke OCI parsing/download**, and (b) David Festal asked to
  wait for NFS for the *frontend-render* part.

Since then, **`install-dynamic-plugins` was published to npm**, and RHDH already uses it
in-process in `plugin-dynamic-loading.spec.ts` (PR #4967). This POC reuses that exact
approach to show the smoke validation can be **in-process, no Docker**.

## What it does

```
install CLI (extract OCI → dynamic-plugins-root)
  → loadManifest()            # manifest.json from the CLI
  → loadBackendPlugins()      # require() each, assert default BackendFeature
  → startTestBackend()        # boot core + loaded features in-process
  → validateFrontendBundle()  # scalprum/remoteEntry present (load-only)
  → results.json + exit code
```

`src/loader.ts` is ported verbatim from RHDH PR #4967.

## What it deliberately does NOT do

It does **not render frontend UI**. `startTestBackend` is backend-only. UI-behaviour tests
(the 24 overlay `e2e-tests`, which are ~all Playwright `uiHelper`-driven) need a real
frontend — that is the **NFS / app-next** path (RHIDP-15082), intentionally out of scope.

## Run

Requires Node 24 and Yarn 4 (matching the repo's `versions.json` and the sibling
`workspaces/*/e2e-tests`), plus registry access to pull the OCI plugin images.

```bash
yarn install

# A) explicit OCI refs for one workspace
cat > dp.yaml <<'YAML'
plugins:
  - package: oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/<plugin>:<tag>!<name>
YAML
yarn smoke --dynamic-plugins dp.yaml

# B) a whole catalog index image
CATALOG_INDEX_IMAGE=<image> yarn smoke:catalog-index
```

`yarn check` runs `tsc --noEmit`. This is a standalone tool dir, not a
`workspaces/*/e2e-tests` one, so it is intentionally outside `e2e-code-quality.yaml`
(which only scans `workspaces/*/e2e-tests/**`); eslint/prettier wiring can be added if
this graduates from POC.

Exit code `0` = pass; non-zero with `results.json` detailing `fail-load` / `fail-start` /
`fail-bundle`.

## Best fit (from the 64-workspace analysis, RHIDP-15076)

- **12 pure-backend workspaces** → fully covered here (load + backend start):
  `3scale, ai-integrations, apiconnect, github-notifications, keycloak,
  mcp-integrations, pingidentity, scaffolder-backend-module-{kubernetes,regex,servicenow,sonarqube},
  scaffolder-relation-processor`.
- **32 smoke-tests** → replace the Docker container with this harness (backend start +
  frontend bundle/registration check).
- **24 UI e2e-tests** → NOT this harness; need the NFS/app-next render harness.

## Status of validation

- ✅ Install CLI interface confirmed: `@red-hat-developer-hub/cli-module-install-dynamic-plugins@0.3.0`
  (`install <dynamic-plugins-root>`), fetchable via `npx`.
- ✅ Harness logic ported from the **already-green** RHDH nightly test (PR #4967).
- ✅ Transpiles clean (esbuild); ESM `require` resolved via `createRequire`.
- ✅ `patchModuleResolution()` ported (`src/module-resolution.ts`) so extracted plugins
  resolve their `@backstage/*` peers against this harness's `node_modules`. Requires a
  node-modules linker — see `.yarnrc.yml`.
- ⏳ End-to-end run against live OCI images should execute in CI (Node 24 + `packages:read`),
  producing the wall-clock comparison vs the Docker smoke job to attach to RHIDP-15075.

## Module resolution

Extracted plugins live under a temp dir with no `node_modules` of their own, so their bare
`@backstage/*` imports must resolve against this harness. `patchModuleResolution()` (ported
from RHDH PR #4967) extends `Module._nodeModulePaths` to append `HARNESS_NODE_MODULES`
before any plugin is `require`d. This is why the package uses `nodeLinker: node-modules`
(`.yarnrc.yml`) rather than Yarn PnP — the patch needs a real `node_modules` directory to
point at.
