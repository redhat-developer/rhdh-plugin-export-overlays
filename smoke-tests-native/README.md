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

Requires Node 22+ (overlay `versions.json` pins 24) and registry access to pull the OCI
plugin images.

```bash
yarn install   # or npm install

# A) explicit OCI refs for one workspace
cat > dp.yaml <<'YAML'
plugins:
  - package: oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/<plugin>:<tag>!<name>
YAML
yarn smoke --dynamic-plugins dp.yaml

# B) a whole catalog index image
CATALOG_INDEX_IMAGE=<image> yarn smoke:catalog-index
```

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
- ⏳ End-to-end run against live OCI images should execute in CI (Node 24 + `packages:read`),
  producing the wall-clock comparison vs the Docker smoke job to attach to RHIDP-15075.

## Known gap before a real run

RHDH's `plugin-dynamic-loading.spec.ts` calls a `patchModuleResolution()` step so that the
extracted plugins — which live under a temp dir — resolve their bare `@backstage/*` imports
against **this** harness's `node_modules`. Node's default resolution walks up from the
plugin's temp path, not from here, so without that patch `require()` of a real plugin can
fail with `Cannot find module '@backstage/...'`. Porting that patch (or installing the
plugins into a path that resolves the shared deps) is the next step to close before the CI
run. This is why the POC is marked "transpiles + interface-confirmed", not "end-to-end green".
