# E2E Testing

Reference for the workspace E2E suite: where the tests live, how the framework deploys RHDH, how to run them locally and in CI, and the runtime details behind `rhdh.deploy()` that explain why a test behaved as it did. Fixing a failure is [e2e-fix-workflow.md](./e2e-fix-workflow.md); writing or reviewing a test is [playwright-test-authoring.md](./playwright-test-authoring.md).

E2E tests live in `workspaces/<name>/e2e-tests/` and use `@red-hat-developer-hub/e2e-test-utils` — a shared package that handles RHDH deployment, Playwright fixtures, helpers, and plugin configuration. For the latest and most complete documentation, see https://github.com/redhat-developer/rhdh-e2e-test-utils/tree/main/docs.

## Workspace E2E structure

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

## How tests work

Each Playwright project creates a **separate Kubernetes namespace** (project name = namespace name). The test framework:

1. **Global setup** (once per run) — checks binaries (`oc`, `kubectl`, `helm`), detects cluster domain, deploys Keycloak
2. **Worker fixture** (once per worker) — creates `RHDHDeployment(projectName)`, sets CWD to the workspace's `e2e-tests/` directory
3. **Test execution** — `beforeAll` configures + deploys RHDH, `beforeEach` handles login, tests use `uiHelper`/`page` for assertions
4. **Reporting and teardown** — collects failure diagnostics in both local and automated runs; deletes each project's namespaces only with `CI=true`, after its tests and retries finish

## Standard test pattern

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

## `test.runOnce` — protecting expensive setup from worker restarts

Playwright's `beforeAll` runs once **per worker**, not once per test run. When a test fails, Playwright kills the worker and creates a new one for the remaining tests, so `beforeAll` runs again. `rhdh.deploy()` has built-in protection; other expensive setup does not.

**Use it** when `beforeAll` does pre-deployment work — external services, scripts, env var extraction — that must not repeat on a worker restart. **Not needed** when `beforeAll` only calls `rhdh.configure()` + `rhdh.deploy()`.

```typescript
test.beforeAll(async ({ rhdh }) => {
  await test.runOnce(`tech-radar-setup-${rhdh.deploymentConfig.namespace}`, async () => {
    await rhdh.configure({ auth: "keycloak" });
    await $`bash ${setupScript} ${rhdh.deploymentConfig.namespace}`;
    await rhdh.deploy(); // safe to nest — has its own internal runOnce
  });
});
```

**Key rules:**

- The `key` must be **globally unique** across all spec files **and projects**. Scope it with the namespace whenever the setup belongs to one project, which is what `deploy()` does internally (`deploy-${namespace}`):

  ```typescript
  await test.runOnce(`my-plugin-setup-${rhdh.deploymentConfig.namespace}`, async () => { ... });
  ```

  A literal key is correct only when the setup really is shared — an operator installed once into a fixed namespace every project uses. Nesting does not rescue a per-project block under a shared key: the outer key skips before `deploy()` is reached.
- Env vars set inside `runOnce` are **not** set after a worker restart, because the callback is skipped. `deploy()` already set `RHDH_BASE_URL`, and secrets are already in the cluster, so most blocks are unaffected. When a test does need such a value, re-derive it from cluster state **outside** `runOnce`:

  ```typescript
  test.beforeAll(async ({ rhdh }) => {
    await test.runOnce(`my-setup-${rhdh.deploymentConfig.namespace}`, async () => {
      await rhdh.configure({ auth: "keycloak" });
      await $`bash deploy-service.sh ${rhdh.deploymentConfig.namespace}`;
      await rhdh.deploy();
    });

    // Always runs — even after a worker restart. Re-derives from cluster state.
    process.env.MY_SERVICE_URL = await rhdh.k8sClient.getRouteLocation(
      rhdh.deploymentConfig.namespace, "my-service"
    );
  });
  ```

### `runOnce` mechanics

`test.runOnce` writes a flag file keyed by the key string alone, into a directory keyed only on the Playwright runner PID:

```ts
const flagDir = path.join(os.tmpdir(), `playwright-once-${process.ppid}`);
const flagFile = path.join(flagDir, `${key}.done`);
```

Nothing in that path comes from the project. When one spec runs in two projects — which is what adding an `-app-next` lane does — the first project's setup satisfies the second, and the second skips its own. For a block that deploys, that means no deployment at all, then a failure much later on a missing element with nothing pointing at the cause ([#3318](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/3318)).

That is why the key needs the namespace:

```typescript
// ✅ Scoped to the project's namespace
await test.runOnce(`my-workspace-setup-${rhdh.deploymentConfig.namespace}`, async () => {
  await rhdh.configure({ auth: "keycloak" });
  await rhdh.deploy();
});

// ❌ Collides across projects sharing this spec
await test.runOnce("my-workspace-setup", async () => {
  await rhdh.configure({ auth: "keycloak" });
  await rhdh.deploy();
});
```

This mirrors `deploy()`, which uses `deploy-${namespace}` internally. `bulk-import` deliberately carries one of each: a namespaced key for per-project setup and a literal key for an operator installed once into a fixed namespace. The key is where you say which you mean.

Flags live in `/tmp` scoped to the runner process, so they reset between test runs.

## Configuration files

All files in `tests/config/` are optional; create one only to override a default.

- `app-config-rhdh.yaml` — RHDH app configuration (plugin settings, backend config)
- `rhdh-secrets.yaml` — Kubernetes Secret manifest injecting env vars into RHDH
- `dynamic-plugins.yaml` — plugin overrides (usually unnecessary — auto-generated from metadata)
- `value_file.yaml` — Helm chart value overrides
- `subscription.yaml` — Operator subscription overrides

`dynamic-plugins.yaml` is the usual exception — required when the workspace depends on plugins from other workspaces. See [dynamic-plugins.md](./dynamic-plugins.md#cross-workspace-dependencies).

**Environment variables in RHDH config** must first be declared in `rhdh-secrets.yaml`:

```
Environment (CI secrets / .env)  rhdh-secrets.yaml              app-config-rhdh.yaml
MY_TOKEN=abc123              →    MY_TOKEN: $MY_TOKEN        →   token: ${MY_TOKEN}
                                  (envsubst replaces $VAR)       (references the K8s Secret)
```

`envsubst` runs **only** on `rhdh-secrets.yaml`. Every other config file references the Secret with `${VAR}` and is not substituted directly.

### Search sibling workspaces first

Before writing E2E config keys into `app-config-rhdh.yaml`, `dynamic-plugins.yaml`, `value_file.yaml`, or `rhdh-secrets.yaml`, look at how other workspaces do it. They are reference implementations.

```bash
grep -r '<config-key>' workspaces/*/e2e-tests/tests/config/
```

Follow the most common pattern unless the workspace has a reason to differ, and note that reason in the commit message. Where several workspaces configure a feature identically, that consensus is the baseline.

**Permissions and RBAC especially:** a bare `permission.enabled: true` is almost never enough. Check whether other workspaces pair it with a full policy setup — CSV policy files, admin user entries, policy source config — and adapt accordingly.

### Check every sibling variant of a config file

Some workspaces keep several YAML variants in `tests/config/` sharing the same plugin entries — `dynamic-plugins.yaml` alongside `dynamic-plugins-with-orchestrator.yaml`, or `app-config-rhdh.yaml` alongside `app-config-rhdh-orchestrator-mode.yaml`. When editing any file there, list the directory and check whether sibling files carry the same sections needing the same change. A change to one variant usually belongs in all of them.

Check the workspace's `metadata/*.yaml` too: `spec.appConfigExamples` entries that mirror the E2E config should stay consistent with it.

## Local E2E quick start

Read the [local E2E documentation](#local-e2e-documentation) for prerequisites, cluster login, and Bitwarden setup. Use the Node.js version in `versions.json`; this checkout's runner rejects lower versions and warns on newer ones.

From the **repository root**:

```bash
# List tests without cluster setup or test execution
./run-e2e.sh -w tech-radar --list

# Run one workspace with the repository secret profile; retain namespaces
CI=false ./run-e2e.sh --secrets -w tech-radar
```

Omit `--secrets` when the required environment variables are already supplied. With `--secrets`, use `-w` to narrow secret selection; `--project` filters tests only. Selection rules live in the Repository E2E secrets guide below.

`--list` still installs dependencies and generates configuration. Before executing tests, choose the [CI behaviour](#ci-behaviour-that-leaks-into-local-runs): the root runner defaults to `CI=true` and automatic namespace cleanup.

### Local E2E documentation

Read the relevant document before setting up or changing a local run. Local links are relative to this repository; upstream links point directly to Markdown source. These sources cover dependency/browser installation, workspace commands, reporting, and cleanup. Use `versions.json`, `run-e2e.sh`, and the selected workspace's configuration as the authority for checkout-specific versions and defaults.

| Read when… | Documentation |
|------------|---------------|
| Setting up and running workspace tests locally | [Local-running guide](https://raw.githubusercontent.com/redhat-developer/rhdh-e2e-test-utils/main/docs/overlay/tutorials/running-locally.md) |
| Selecting workspaces, forwarding test options, or using local test-utils builds | [Unified runner reference](https://raw.githubusercontent.com/redhat-developer/rhdh-e2e-test-utils/main/docs/overlay/reference/run-e2e.md) |
| Running tests with this repository's secret profile | [Repository E2E secrets guide](../../../user-guide/09-managing-e2e-secrets.md#running-tests-with-secrets) |
| Setting up Bitwarden authentication or understanding local secret execution | [Secrets API](https://raw.githubusercontent.com/redhat-developer/rhdh-e2e-test-utils/main/docs/api/secrets.md#local-command) |

### Running tests from a workspace

```bash
cd workspaces/tech-radar/e2e-tests
unset CI                     # clear inherited CI mode for this shell
yarn install
npx playwright install chromium

yarn test                    # required secrets already supplied
yarn test:secrets            # load secrets from the repository profile
yarn test --headed           # watch in browser
yarn test --ui               # Playwright UI mode
yarn report                  # open last HTML report
```

Use `test:secrets` when secrets must be loaded; it accepts the same Playwright options, such as `yarn test:secrets --headed`.

### CI behaviour that leaks into local runs

The current checkout and `e2e-test-utils` 2.2.1 carry these caveats:

- The root runner sets an unset or empty `CI` to `"true"`. Use `CI=true` for automatic namespace cleanup, `CI=false` to retain deployments for debugging.
- `CI=false` is a nonempty string. It still enables `forbidOnly` and ignores `RHDH_SKIP_PLUGIN_METADATA_INJECTION=true`; it does not fully disable CI behaviour.
- In `backstage`, GitHub-discovery and TechDocs projects use one retry with either string and zero with `CI` unset. GitLab scaffolder resource cleanup defaults to enabled only for `CI=true`; override with `GITLAB_SCAFFOLDER_CLEANUP=true` or `false`.
- For nightly reproduction with `CI=false`, also set `E2E_NIGHTLY_MODE=true` and `RELEASE_BRANCH_NAME=main` (or the target branch). The shared metadata resolver still requires the branch even though the shell preflight accepts its absence.
- Set `CI` in the launching shell, not in workspace `.env` files: those load after Playwright configuration evaluation and can leave configuration and cleanup using different values.

Direct workspace runs normally need no `CI` setting. `unset CI` clears an inherited value for the rest of that shell; `env -u CI yarn test:secrets --headed` does it for a single command. The root runner restores `CI=true` when `CI` is unset, so clearing it does not enable local mode through `run-e2e.sh`.

### Cleanup and Keycloak

**Retained namespaces need manual cleanup.** With `CI=false`, inspect the deployments, then delete them:

```bash
oc delete project <namespace>
```

**Keycloak is reused automatically.** If it is already deployed from a previous run, global setup detects it and skips redeployment. Set `SKIP_KEYCLOAK_DEPLOYMENT=true` only when you do not want Keycloak at all, such as guest-auth tests.

## Unified test runner (`run-e2e.sh`)

`run-e2e.sh` runs E2E tests from ALL workspaces (or a subset) in a single Playwright process from the repo root. Used by CI nightly jobs and for cross-workspace validation.

```bash
./run-e2e.sh                          # All workspaces
./run-e2e.sh -w tech-radar            # Single workspace
./run-e2e.sh -w backstage -w keycloak # Multiple workspaces
./run-e2e.sh --list                   # Dry run — list discovered projects
./run-e2e.sh --workers=4              # Control parallelism
```

**Test locally with PR-built OCI images:** publish the PR's images with `/publish` first, then from the repository root:

```bash
CI=false GIT_PR_NUMBER=1845 ./run-e2e.sh --secrets -w tech-radar
```

`GIT_PR_NUMBER` selects PR-built images.

### Why the unified runner exists

One root Playwright process, not per-workspace parallelism, and that shape is not arbitrary:

- Workers auto-balance across all projects, so no resources idle when workspaces differ in size.
- Keycloak `globalSetup` runs once, removing a race.
- One HTML report with traces, screenshots, and videos — no merge step.
- The standard Playwright CLI works: `--project`, `--grep`, `--shard`.
- Yarn resolutions validates dependency upgrades across all workspaces in one run.

**Yarn workspaces is required, not optional.** Playwright errors if `@playwright/test` resolves from more than one path in a process, which is what separate per-workspace `node_modules` produce. Yarn workspaces hoists to a single root `node_modules`. Nothing is committed — `package.json`, `playwright.config.ts`, and `.yarnrc.yml` are generated at runtime.

## Playwright project names and app-next lanes

### Project names differ from workspace directories

Project names come from each workspace's `e2e-tests/playwright.config.ts` and may differ from the directory name. Some are abbreviated to stay under the 63-character OpenShift Route hostname limit — the `scaffolder-backend-module-kubernetes` workspace uses the project name `scaffolder-k8s-app-next`. When resolving a failure from CI output, map the project name back to the workspace:

```bash
find workspaces -name 'playwright.config.ts' -exec grep -l '<project-name>' {} +
```

Do not assume the project name matches the directory path, and verify file paths exist before citing them in issues or tracking metadata.

### One project per spec file

Each Playwright project creates its own RHDH deployment in its own namespace, so a workspace should have one project targeting one spec file. When a workspace genuinely needs several configurations — different auth, different plugins — use multiple projects with `testMatch`:

```typescript
export default defineConfig({
  projects: [
    { name: "my-plugin", testMatch: "my-plugin.spec.ts" },
    { name: "my-plugin-guest", testMatch: "my-plugin-guest.spec.ts" },
  ],
});
```

### Adding an `-app-next` project

When a PR adds an `-app-next` project to a workspace that already has a legacy project:

1. Check `docs/nfs-e2e-triage.md` for whether the workspace's NFS migration is complete.
2. If it is listed as complete — all tests green on the app-next lane — flag that the legacy project should be **removed** rather than kept beside the new one. Keeping both doubles CI cost and invites cross-project races (shared Loki installs, Knative CRDs) that then need serialisation workarounds.
3. If the status is unclear, ask the author whether the legacy lane is still needed.

An `-app-next` lane is also where `runOnce` key collisions surface: two projects, one spec, one flag file. See [`runOnce` mechanics](#runonce-mechanics).

## Key environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `RHDH_VERSION` | RHDH version to deploy; the root runner sets it, and workspace configuration may override it | Entry-point/config dependent |
| `INSTALLATION_METHOD` | `"helm"` or `"operator"` | `"helm"` |
| `GIT_PR_NUMBER` | PR number — enables PR mode with PR-built OCI images | - |
| `E2E_NIGHTLY_MODE` | `"true"` or `"1"` — enables nightly mode with released OCI refs | - |
| `RELEASE_BRANCH_NAME` | Branch for nightly default-package resolution; required when `CI` is nonempty, including `"false"` | `main` only when `CI` is unset or empty |
| `JOB_NAME` | CI job name; `periodic-` prefix triggers nightly mode | - |
| `SKIP_KEYCLOAK_DEPLOYMENT` | Skip Keycloak in global setup | - |
| `CI` | See [CI behaviour that leaks into local runs](#ci-behaviour-that-leaks-into-local-runs) for cleanup and focused-test behaviour | `true` in root runner |
| `E2E_TEST_UTILS_PATH` | Local e2e-test-utils build path (takes precedence over version) | - |
| `E2E_TEST_UTILS_VERSION` | Pin e2e-test-utils npm version | `latest` (nightly) |
| `CATALOG_INDEX_IMAGE` | Override the catalog index image in the RHDH chart | - |

## CI jobs

| Job | When | Workspaces | OCI Images |
|-----|------|-----------|------------|
| PR check (`e2e-ocp-helm`) | PR with e2e changes | Changed workspace only | PR-built (`pr_` tags) |
| Nightly (`e2e-ocp-helm-nightly`) | Daily cron / manual | All workspaces | Released (metadata refs) |

Trigger nightly manually: comment `/test e2e-ocp-helm-nightly` on a PR.

## Runtime reference

### `rhdh.deploy()` in order

1. **Merges config** — package defaults, auth config (keycloak or guest), and the workspace's `tests/config/` overrides, deep-merged with later winning.
2. **Processes dynamic plugins** — auto-generates from `metadata/*.yaml` when no `dynamic-plugins.yaml` exists, injects metadata config, resolves OCI URLs per mode.
3. **Applies to the cluster** — ConfigMaps for app-config and dynamic-plugins, Secrets with `envsubst` substitution.
4. **Installs RHDH** — Helm chart or Operator, per `INSTALLATION_METHOD`.
5. **Waits for readiness** — pod `Ready=True` with early detection of CrashLoopBackOff and ImagePullBackOff, then an HTTP health check against the route.
6. **Sets `RHDH_BASE_URL`** so Playwright navigates to the right place.

Helm upgrades scale down and restart first to avoid `MigrationLocked`; fresh installs skip that.

### Plugin metadata resolution

| Mode | Detection | Plugin packages | Config injection |
| --- | --- | --- | --- |
| **PR check** | `GIT_PR_NUMBER` set | PR-built OCI images (`pr_{number}__{version}`) | Yes — metadata `appConfigExamples` injected |
| **Nightly** | `E2E_NIGHTLY_MODE=true` | Released OCI refs from `spec.dynamicArtifact` | No — whatever the file contains |
| **Local dev** | Neither set | Local paths as-is, bundled in the container | Yes — metadata `appConfigExamples` injected |

Priority: `GIT_PR_NUMBER` forces PR mode, then `E2E_NIGHTLY_MODE`, then `JOB_NAME` containing `periodic-`.

**PR mode** needs `source.json` and `plugins-list.yaml` in the workspace root, which the framework uses to read plugin versions from the source repo and build OCI URLs such as `oci://ghcr.io/.../plugin-name:pr_1845__1.2.3`. It also needs images published by `/publish` first.

**Local dev** uses local paths (`./dynamic-plugins/dist/...`) bundled inside the RHDH container image; metadata configs are still injected. This is the default for `yarn test` from a workspace.

**Nightly** uses released OCI refs straight from `spec.dynamicArtifact` with no config injection, so plugins run on their baked-in defaults.

**Path resolution.** Config paths come from `test.info().project.testDir`, not `process.cwd()`, which lets the same code run from `workspaces/<name>/e2e-tests` and from the repo root via `./run-e2e.sh`. The worker fixture also runs `process.chdir(e2eRoot)` as a safety net for shell scripts and `fs` calls.

### Namespace teardown

The custom Playwright reporter handles namespace deletion, in local and automated runs alike, and only when `CI` is exactly `"true"`. It uses the reporter rather than `afterAll` hooks or worker-fixture cleanup, deliberately:

- **`afterAll`** fires when a worker dies. When a test fails and Playwright restarts the worker for a retry, the old worker's `afterAll` deletes the namespace before the retry can use it.
- **Worker fixture teardown** has the same problem — it runs on worker exit, not suite completion.
- **`globalTeardown`** runs after everything but cannot tell which projects ran or which namespaces were created.

The reporter lives in the main Playwright process, survives worker restarts, and tracks per-project completion including retries. With `CI=true` it deletes each project's namespaces as its last test finishes, including failed projects after collecting diagnostics, and attempts cleanup of unfinished projects at the end of the run.

### Fixtures

| Fixture | Scope | Purpose |
| --- | --- | --- |
| `rhdh` | worker | `RHDHDeployment` — `configure()`, `deploy()`, `k8sClient`, `deploymentConfig` |
| `uiHelper` | test | UI interaction — `verifyHeading()`, `openSidebar()`, `clickButton()`, `verifyRowsInTable()` |
| `loginHelper` | test | Authentication — `loginAsKeycloakUser()`, `loginAsGuest()` |
| `baseURL` | test | Auto-set to the deployed RHDH URL |

## Failure analysis

The `e2e-failure-analysis` skill, symlinked into `.agents/skills/` from `.fullsend/skills/`, covers E2E failure investigation: artifact download, diagnostics, grouping by error signature, trace correlation including the Playwright trace CLI, cluster log search, and config comparison.
