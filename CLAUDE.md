# CLAUDE.md

This file provides guidance to Agentic AI coding tools when working with code in this repository.

## Repository Purpose

This is the **rhdh-plugin-export-overlays** repository — a metadata and automation hub for managing dynamic plugins for Red Hat Developer Hub (RHDH). It does NOT contain plugin source code. Instead, it references upstream plugin repositories and defines how to package them as OCI container images for RHDH.

Key versions are tracked in `versions.json` ( Backstage version, Node version, redhat-developer-hub CLI version).

## Architecture

### Two-Layer Structure

The repo has two distinct metadata systems that serve different purposes:

1. **Workspaces** (`workspaces/*/`) — Define *how to build* dynamic plugin OCI images. Each workspace maps to an upstream source repo (monorepo or standalone). Key files:
   - `source.json` — Source repo URL, git ref, and Backstage version
   - `plugins-list.yaml` — Which plugins to export, with optional CLI args
   - `metadata/*.yaml` — `kind: Package` entities describing each built artifact (version, OCI reference, `appConfigExamples`)
   - `plugins/<plugin>/overlay/` — Files that replace/add source files during packaging
   - `patches/*.patch` — Unified diffs applied to the workspace source before build

2. **Catalog entities** (`catalog-entities/extensions/`) — Define *how plugins appear* in the RHDH Extensions UI. These are separate from workspace metadata:
   - `plugins/*.yaml` — `kind: Plugin` entities with descriptions, icons, categories, highlights (user-facing display)
   - `collections/*.yaml` — Groupings (featured, recommended, cicd, openshift, redhat)
   - `plugins/all.yaml` — Index file; every plugin YAML must be listed here

**Package entities live in `workspaces/*/metadata/`**, not in `catalog-entities/extensions/`. They are merged at build time into the plugin catalog index image.

### Branching Strategy

- **`main`** — Development branch for next RHDH release. All new workspaces go here.
- **`release-x.y`** — Long-running release branches. Only receive updates to existing workspaces, never new workspaces.

### Support Tiers

Plugins fall into three support levels, tracked in text files at the repo root:
- `rhdh-supported-packages.txt` — GA (Generally Available), Red Hat supported
- `rhdh-techpreview-packages.txt` — Tech Preview, heading toward GA
- `rhdh-community-packages.txt` — Community supported

### Plugin Scopes

Auto-discovery covers three npm scopes (defined in `plugins-regexps`):
- `@backstage-community/` (github.com/backstage/community-plugins)
- `@red-hat-developer-hub/` (github.com/redhat-developer/rhdh-plugins)
- `@roadiehq/` (github.com/RoadieHQ/roadie-backstage-plugins)

## Key Workflows

There is no local build system — all building, testing, and publishing happens via GitHub Actions.

### PR Commands

On a PR, comment:
- `/publish` — Build and publish test OCI images (tagged `pr_<number>__<version>`)
- `/smoketest` — Run smoke tests against last published artifacts (requires prior `/publish`)
- `/test` or `/test e2e-tests` — Run e2e tests. Only relevant for PRs that modify workspaces containing an `e2e-tests/` directory (e.g., the `backstage` workspace)

### Important Workflows (`.github/workflows/`)

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `update-plugins-repo-refs.yaml` | Daily + manual | Auto-generates PRs for plugin version updates |
| `publish-workspace-plugins.yaml` | Push to release branches | Publishes final OCI images |
| `pr-actions.yaml` | PR comments | Handles `/publish` and `/smoketest` commands |
| `run-workspace-smoke-tests.yaml` | After publish | Verifies plugins load in RHDH container |
| `check-backstage-compatibility.yaml` | Push + PRs | Gates release branch creation on compatibility |
| `sync-user-guide-to-wiki.yaml` | Weekly + manual | Syncs `user-guide/` to GitHub Wiki with placeholder injection |

### Triggering Workflows Manually

```bash
# Update plugin refs (e.g., for RBAC plugins on main)
gh workflow run update-plugins-repo-refs.yaml -f regexps="@backstage-community/plugin-rbac" -f single-branch=main

# Sync docs to wiki (dry run)
gh workflow run sync-user-guide-to-wiki.yaml -f dry_run=true
```

## Working with Workspaces

### Adding a New Workspace

1. Create `workspaces/<name>/source.json`:
   ```json
   {"repo":"https://github.com/org/repo","repo-ref":"<tag-or-sha>","repo-flat":false,"repo-backstage-version":"1.45.1"}
   ```
   - `repo-flat`: `true` if plugins are at repo root, `false` if inside a workspace subdirectory
2. Create `workspaces/<name>/plugins-list.yaml` listing plugin paths
3. Create `workspaces/<name>/metadata/<package-name>.yaml` for each plugin (kind: Package)

### Overlay vs Patch

- **Overlay** (`plugins/<plugin>/overlay/`): Replaces or adds entire files during packaging. Used for plugin-specific changes.
- **Patch** (`patches/*.patch`): Applies line-by-line changes to workspace source before build. Used for workspace-wide fixes. Numbered prefix controls application order (e.g., `1-fix-something.patch`).

## Working with Catalog Entities

### Plugin YAML (`catalog-entities/extensions/plugins/*.yaml`)

Uses `kind: Plugin` with schema: `https://raw.githubusercontent.com/redhat-developer/rhdh-plugins/refs/heads/main/workspaces/extensions/json-schema/plugins.json`

Key fields: `spec.categories`, `spec.highlights`, `spec.icon` (base64 SVG), `spec.packages` (links to Package entities), `spec.description` (markdown, no images).

After creating/editing, add the file to `plugins/all.yaml`.

### Package YAML (`workspaces/*/metadata/*.yaml`)

Uses `kind: Package`. Key fields: `spec.packageName`, `spec.dynamicArtifact` (OCI reference), `spec.version`, `spec.backstage.role` (frontend-plugin/backend-plugin), `spec.support` (community/production/tech-preview), `spec.appConfigExamples`.

## E2E Testing

E2E tests live in `workspaces/<name>/e2e-tests/` and use `@red-hat-developer-hub/e2e-test-utils` — a shared package that handles RHDH deployment, Playwright fixtures, helpers, and plugin configuration. For the latest and most complete documentation, see: https://github.com/redhat-developer/rhdh-e2e-test-utils/tree/main/docs

### Workspace E2E Structure

```
workspaces/<plugin>/
├── metadata/                    # Plugin metadata (Package CRD) — consumed by deploy()
│   └── backstage-*.yaml         # spec.dynamicArtifact, spec.appConfigExamples
└── e2e-tests/
    ├── package.json             # Dependencies (e2e-test-utils, @playwright/test)
    ├── playwright.config.ts     # Extends base config, defines project(s)
    ├── .env                     # Local env vars (optional)
    └── tests/
        ├── config/              # All files optional — auto-generated from metadata
        │   ├── app-config-rhdh.yaml
        │   ├── rhdh-secrets.yaml
        │   └── dynamic-plugins.yaml
        └── specs/
            └── <plugin>.spec.ts # Test specification
```

### How Tests Work

Each Playwright project creates a **separate Kubernetes namespace** (project name = namespace name). The test framework:

1. **Global setup** (once per run) — checks binaries (`oc`, `kubectl`, `helm`), detects cluster domain, deploys Keycloak
2. **Worker fixture** (once per worker) — creates `RHDHDeployment(projectName)`, sets CWD to the workspace's `e2e-tests/` directory
3. **Test execution** — `beforeAll` configures + deploys RHDH, `beforeEach` handles login, tests use `uiHelper`/`page` for assertions
4. **Teardown** (CI only) — per-project namespace deletion via a custom Playwright reporter as soon as all tests in that project finish

### Standard Test Pattern

```typescript
import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";

test.describe("My Plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "keycloak" });
    // Optional: deploy external services before RHDH
    await $`bash scripts/setup.sh ${rhdh.deploymentConfig.namespace}`;
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("verify feature", async ({ uiHelper }) => {
    await uiHelper.openSidebar("My Plugin");
    await uiHelper.verifyHeading("Expected Title");
  });
});
```

### test.runOnce — Protecting Expensive Setup from Worker Restarts

Playwright's `beforeAll` runs once **per worker**, not once per test run. When a test fails, Playwright kills the worker and creates a new one for remaining tests — causing `beforeAll` to run again. `rhdh.deploy()` has built-in protection (it skips if the deployment already exists), but other expensive operations in your `beforeAll` do not.

**When to use:** Wrap `beforeAll` in `test.runOnce()` when you have pre-deployment setup (external services, scripts, env var extraction) that shouldn't repeat on worker restart.

**When NOT needed:** If your `beforeAll` only calls `rhdh.configure()` + `rhdh.deploy()`, you don't need `runOnce` — `deploy()` is already protected internally.

```typescript
test.beforeAll(async ({ rhdh }) => {
  await test.runOnce("tech-radar-setup", async () => {
    await rhdh.configure({ auth: "keycloak" });

    // Expensive: deploys an external service to the cluster
    await $`bash ${setupScript} ${rhdh.deploymentConfig.namespace}`;

    // Extract a route URL and set as env var for RHDH config
    process.env.DATA_URL = await rhdh.k8sClient.getRouteLocation(
      rhdh.deploymentConfig.namespace, "data-provider"
    );

    await rhdh.deploy(); // safe to nest — has its own internal runOnce
  });
});
```

**How env vars survive worker restarts:** Environment variables set inside `runOnce` (like `process.env.DATA_URL` above) are set in the worker process. When the worker restarts, `runOnce` skips the callback entirely — so the env var is never set in the new worker. This is fine because:
- `rhdh.deploy()` already ran and set `RHDH_BASE_URL` (which the fixture re-reads from the route)
- Secrets were already applied to the cluster as ConfigMaps/Secrets during the first run
- The env vars were only needed during the deployment phase, not during test execution

If a test **does** need an env var that was set inside `runOnce`, extract it from the cluster in a separate step outside `runOnce`:

```typescript
test.beforeAll(async ({ rhdh }) => {
  await test.runOnce("my-setup", async () => {
    await rhdh.configure({ auth: "keycloak" });
    await $`bash deploy-service.sh ${rhdh.deploymentConfig.namespace}`;
    await rhdh.deploy();
  });

  // Always runs — even after worker restart. Re-derives the value from cluster state.
  process.env.MY_SERVICE_URL = await rhdh.k8sClient.getRouteLocation(
    rhdh.deploymentConfig.namespace, "my-service"
  );
});
```

**Key rules:**
- The `key` (first argument) must be **globally unique** across all spec files and projects. Prefix with workspace name: `"tech-radar-setup"`, `"argocd-deploy"`.
- Nesting is safe — `deploy()` uses `runOnce` internally, wrapping it in an outer `runOnce` is harmless.
- Uses file-based flags in `/tmp/` scoped to the Playwright runner process. Flags reset automatically between test runs.

### RHDH Deployment Flow

`rhdh.deploy()` performs these steps:

1. **Merges config files** — package defaults + auth config (keycloak/guest) + your `tests/config/` overrides (deep merge, later wins)
2. **Processes dynamic plugins** — auto-generates from `metadata/*.yaml` if no `dynamic-plugins.yaml` exists; injects metadata configs; resolves OCI URLs based on mode
3. **Applies to cluster** — creates ConfigMaps (app-config, dynamic-plugins) and Secrets (with `envsubst` for env var substitution)
4. **Installs RHDH** — via Helm chart or Operator based on `INSTALLATION_METHOD`
5. **Waits for readiness** — two-phase: pod `Ready=True` (with early failure detection for CrashLoopBackOff, ImagePullBackOff) + HTTP health check against the route
6. **Sets `RHDH_BASE_URL`** — so Playwright navigates to the correct URL

Helm upgrades perform a scale-down-and-restart to avoid `MigrationLocked` errors; fresh installs skip this.

### Plugin Metadata Resolution

Plugin metadata at `workspaces/*/metadata/*.yaml` is actively consumed during deployment. The system operates in three modes:

| Mode | Detection | Plugin Packages | Config Injection |
|------|-----------|----------------|-----------------|
| **PR check** | `GIT_PR_NUMBER` set | PR-built OCI images (`pr_{number}__{version}`) | Yes — metadata `appConfigExamples` injected |
| **Nightly** | `E2E_NIGHTLY_MODE=true` | Released OCI refs from `spec.dynamicArtifact` | No — uses whatever config is in the file |
| **Local dev** | Neither set | Local paths as-is (bundled in container) | Yes — metadata `appConfigExamples` injected |

Priority: `GIT_PR_NUMBER` (forces PR mode) > `E2E_NIGHTLY_MODE` > `JOB_NAME` containing `periodic-`

**PR mode** requires:
- `GIT_PR_NUMBER` set (CI exports it automatically; locally: `export GIT_PR_NUMBER=1845`)
- OCI images published via `/publish` PR comment before running tests
- `source.json` and `plugins-list.yaml` in the workspace root (used to fetch plugin versions from the source repo and build OCI URLs like `oci://ghcr.io/.../plugin-name:pr_1845__1.2.3`)

**Without `GIT_PR_NUMBER` (local dev):** Plugins use local paths (`./dynamic-plugins/dist/...`) bundled inside the RHDH container image. Metadata configs are still injected from `spec.appConfigExamples`. This is the default mode for `yarn test` from a workspace.

**Nightly mode** uses released OCI refs directly from each plugin's `spec.dynamicArtifact` in metadata (e.g., `oci://ghcr.io/.../plugin:bs_1.45.3__1.13.0`). No config injection — plugins use their baked-in defaults. Enabled via `E2E_NIGHTLY_MODE=true` or when `JOB_NAME` contains `periodic-`.

When no `dynamic-plugins.yaml` exists, ALL metadata files are read to auto-generate the complete plugin configuration. This is the recommended approach — most workspaces don't need a `dynamic-plugins.yaml`.

### Configuration Files

All files in `tests/config/` are **optional** — only create them when you need to override defaults:

- `app-config-rhdh.yaml` — RHDH app configuration (plugin settings, backend config)
- `rhdh-secrets.yaml` — Kubernetes Secret manifest for injecting env vars into RHDH
- `dynamic-plugins.yaml` — Plugin overrides (usually NOT needed — auto-generated from metadata)
- `value_file.yaml` — Helm chart value overrides
- `subscription.yaml` — Operator subscription overrides

**Environment variables in RHDH config:** To use an env var in `app-config-rhdh.yaml`, it must first be defined in `rhdh-secrets.yaml`. The flow is:

```
Environment (CI Vault / .env)     rhdh-secrets.yaml              app-config-rhdh.yaml
MY_TOKEN=abc123              →    MY_TOKEN: $MY_TOKEN        →   token: ${MY_TOKEN}
                                  (envsubst replaces $VAR)       (references the K8s Secret)
```

`envsubst` runs **only** on `rhdh-secrets.yaml`. Other config files reference the Secret values with `${VAR}` syntax — they are not substituted directly.

### WorkspacePaths

Config file paths are resolved from `test.info().project.testDir` (Playwright-provided absolute path), NOT from `process.cwd()`. This enables the same test code to work from both:
- **Workspace level**: `cd workspaces/tech-radar/e2e-tests && yarn test`
- **Repo root**: `./run-e2e.sh -w tech-radar`

The worker fixture also does `process.chdir(e2eRoot)` as a complementary safety net for shell scripts and `fs` calls.

### Namespace Teardown

In CI (`CI=true`), namespaces are automatically deleted by a custom Playwright **reporter** — not `afterAll` hooks or worker fixture cleanup. This design is intentional:

- **`afterAll` hook**: Fires when a worker dies. When a test fails and Playwright restarts the worker for retries, the old worker's `afterAll` deletes the namespace before the retry can use it.
- **Worker fixture teardown**: Same problem — runs on worker exit, not on suite completion.
- **`globalTeardown`**: Runs after all tests but has no visibility into which projects ran or which namespaces were created.

The reporter runs in the main Playwright process (survives worker restarts), tracks per-project test completion including retries, and deletes each project's namespace as soon as its last test finishes.

### Playwright Fixtures

| Fixture | Scope | Purpose |
|---------|-------|---------|
| `rhdh` | worker | `RHDHDeployment` instance — `configure()`, `deploy()`, `k8sClient`, `deploymentConfig` |
| `uiHelper` | test | UI interactions — `verifyHeading()`, `openSidebar()`, `clickButton()`, `verifyRowsInTable()` |
| `loginHelper` | test | Authentication — `loginAsKeycloakUser()`, `loginAsGuest()` |
| `baseURL` | test | Auto-set to the deployed RHDH URL |

### Best Practices

**One project per spec file.** Each Playwright project creates a separate RHDH deployment in its own namespace. A workspace should have one project targeting one spec file. This keeps deployments isolated and avoids namespace conflicts. If a workspace needs multiple test configurations (different auth, different plugins), use multiple projects with `testMatch`:

```typescript
// playwright.config.ts
export default defineConfig({
  projects: [
    { name: "my-plugin", testMatch: "my-plugin.spec.ts" },
    { name: "my-plugin-guest", testMatch: "my-plugin-guest.spec.ts" },
  ],
});
```

**Don't create config files unless needed.** The package auto-generates plugin config from metadata. Most workspaces work with zero config files.

### Unified Test Runner (run-e2e.sh)

`run-e2e.sh` runs E2E tests from ALL workspaces (or a subset) in a single Playwright process from the repo root. Used by CI nightly jobs and for cross-workspace validation.

```bash
./run-e2e.sh                          # All workspaces
./run-e2e.sh -w tech-radar            # Single workspace
./run-e2e.sh -w backstage -w keycloak # Multiple workspaces
./run-e2e.sh --list                   # Dry run — list discovered projects
./run-e2e.sh --workers=4              # Control parallelism
```

**Why a single root Playwright instead of per-workspace parallel?**
- Workers auto-balance across all projects (no idle resources when workspaces differ in size)
- Keycloak `globalSetup` runs once (no race conditions)
- Single HTML report with traces/screenshots/videos (no merge step)
- Standard Playwright CLI works (`--project`, `--grep`, `--shard`)
- Yarn resolutions validates dependency upgrades across all workspaces in one run

**Why yarn workspaces is required (not optional):** Playwright errors out if `@playwright/test` is loaded from more than one file path in a process. With separate `node_modules` per workspace, each resolves from a different path. Yarn workspaces hoists to a single root `node_modules`.

Nothing is committed — `package.json`, `playwright.config.ts`, `.yarnrc.yml` are generated at runtime.

### Running Tests

**From a workspace (development):**
```bash
cd workspaces/tech-radar/e2e-tests
cp .env.sample .env  # if exists, fill in secrets
yarn install
yarn test            # or: npx playwright test
yarn test --headed   # watch in browser
yarn test --ui       # Playwright UI mode
yarn report          # open last HTML report
```

**From repo root (CI / cross-workspace):**
```bash
./run-e2e.sh -w tech-radar
# or with local e2e-test-utils build:
E2E_TEST_UTILS_PATH=/path/to/rhdh-e2e-test-utils ./run-e2e.sh -w tech-radar
```

**Test locally with PR-built OCI images:**
```bash
export GIT_PR_NUMBER=1845
yarn test  # uses OCI images published by that PR's /publish command
```

### Local Development Gotchas

**Namespaces are NOT auto-deleted locally.** The teardown reporter only runs when `CI=true`. After local test runs, namespaces persist on the cluster. Clean up manually:
```bash
oc delete project <namespace>
```

**Keycloak is reused automatically.** If Keycloak is already deployed from a previous run, global setup detects it and skips re-deployment. Use `SKIP_KEYCLOAK_DEPLOYMENT=true` only if you don't want Keycloak at all (e.g., guest-auth tests).

### Key Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `RHDH_VERSION` | RHDH version to deploy | `"next"` |
| `INSTALLATION_METHOD` | `"helm"` or `"operator"` | `"helm"` |
| `GIT_PR_NUMBER` | PR number — enables PR mode with PR-built OCI images | - |
| `E2E_NIGHTLY_MODE` | `"true"` or `"1"` — enables nightly mode with released OCI refs | - |
| `JOB_NAME` | CI job name; `periodic-` prefix triggers nightly mode | - |
| `SKIP_KEYCLOAK_DEPLOYMENT` | Skip Keycloak in global setup | - |
| `CI` | Enables `forbidOnly`, teardown reporter, namespace cleanup | - |
| `E2E_TEST_UTILS_PATH` | Local e2e-test-utils build path (takes precedence over version) | - |
| `E2E_TEST_UTILS_VERSION` | Pin e2e-test-utils npm version | `latest` (nightly) |
| `CATALOG_INDEX_IMAGE` | Override the catalog index image in the RHDH chart | - |

### CI Jobs

| Job | When | Workspaces | OCI Images |
|-----|------|-----------|------------|
| PR check (`e2e-ocp-helm`) | PR with e2e changes | Changed workspace only | PR-built (`pr_` tags) |
| Nightly (`e2e-ocp-helm-nightly`) | Daily cron / manual | All workspaces | Released (metadata refs) |

Trigger nightly manually: comment `/test e2e-ocp-helm-nightly` on a PR.

## Documentation

- `README.md` — Repo overview, PR workflow, testing procedures
- `user-guide/` — 6-part contributor guide (getting started, export tools, ownership, metadata sync, versions, patches)
- `catalog-entities/extensions/README.md` — Extensions catalog metadata format
- GitHub Wiki — Auto-synced from `user-guide/` with dynamic content injection (`{{AUTO:*}}` placeholders replaced from `versions.json`)
- **E2E test utils docs** — https://github.com/redhat-developer/rhdh-e2e-test-utils/tree/main/docs — latest API docs, changelogs, tutorials, and configuration reference for `@red-hat-developer-hub/e2e-test-utils`
