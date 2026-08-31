# NFS e2e triage: what each workspace needs, and what no longer needs a cluster

**Epic**: [RHIDP-15286](https://redhat.atlassian.net/browse/RHIDP-15286) — Migrate e2e-tests in the overlay repository to NFS
**Verified against `main`**: 2026-08-17
**Status**: reference material for the epic's per-workspace tickets

This is the input sheet for the tickets under [RHIDP-15286](https://redhat.atlassian.net/browse/RHIDP-15286). It answers three questions per
workspace: what the NFS migration actually requires, whether the suite still needs an
OpenShift cluster once it is migrated, and what its assertions are really about.

**What this is not.** It proposes no spec deletion. E2E stays required, and the workspaces
whose subject *is* OpenShift stay on Prow. Where it says a suite "does not need a cluster",
that is a statement about where the suite can run, not about whether it should exist.

This sheet deliberately does not classify by test layer. The layer vocabulary
(L1/L2/L3/L4a/L4b) lives in
[`rhdh:docs/e2e-tests/layer-migration-matrix.md`](https://github.com/redhat-developer/rhdh/blob/main/docs/e2e-tests/layer-migration-matrix.md),
and the per-support-level requirements in
[`rhdh:docs/testing-requirements-matrix.md`](https://github.com/redhat-developer/rhdh/blob/main/docs/testing-requirements-matrix.md).
Every suite here is L4b today; what the tickets need to know is not which layer it is but
**what pins it there**, which is why the classification below is by blocker.

---

## 1. The scope of the epic, measured

The unit of cluster cost is the **Playwright project**, not the workspace: the project name
is the Kubernetes namespace. A name ending in `-app-next` switches
`@red-hat-developer-hub/e2e-test-utils` into NFS mode, but it is not the only thing that
does: `configure({ useNewFrontendSystem: true })` and `USE_NEW_FRONTEND_SYSTEM=true` do the
same without touching the name, so counting NFS lanes by suffix alone undercounts them.

All figures below measured 2026-08-26 on `origin/main`; they move as lanes migrate, so
regenerate rather than quote them — §6 has the commands.

| | Count |
|---|---|
| Workspaces with `e2e-tests/` | 24 |
| **Playwright projects** (= namespaces = cluster claims) | **48** |
| — running NFS | 27 |
| — — by the `-app-next` name | 11 |
| — — by `configure({ useNewFrontendSystem: true })`, name unchanged | 16 |
| — running the legacy shell | 21 |
| NFS lanes skipped in nightly | 2 (`tech-radar-app-next`, `app-defaults-app-next`) |
| Spec files / static `test()` declarations | 43 / 261 |
| Workspaces using the per-workspace `value_file-app-next.yaml` hook | 0 |

`backstage` alone declares 13 projects, and all thirteen are NFS under their legacy names —
which is why the suffix count and the NFS count differ by more than a rounding error.
Reproduce any of these with the commands in §6.

---

## 2. What has been verified about NFS itself

Three findings, each checked against installed code rather than inferred, because they
change what the remaining tickets have to do.

### 2.1 A plain Backstage backend serves module-federation remotes by default

`dynamicPluginsFeatureLoader` yields `frontendRemotesServerService` whenever a
`dynamicPlugins` config key exists — with no environment variable involved
(`@backstage/backend-dynamic-feature-service`, `dist/features/features.cjs.js`). It mounts
a router at **`/.backstage/dynamic-features`** that serves each plugin's `dist/` using
`mf-manifest.json` (`dist/server/frontendRemotesServer.cjs.js`, path from
`dist/schema/openapi/generated/router.cjs.js`).

`ENABLE_STANDARD_MODULE_FEDERATION` exists only to *undo RHDH's own override* of that
service (`rhdh:packages/backend/src/index.ts`, whose comment says exactly this). RHDH
disables it because the legacy frontend does not use module federation; anything booting
upstream Backstage never installs the override and so needs no flag. RHDH already has a
green, flag-free test of the endpoint at
`rhdh:packages/backend/src/modules/nfsModuleFilter.test.ts`.

### 2.2 The published artifacts carry servable remotes

Checked by pulling every frontend artifact of every e2e workspace and validating the
manifest against what that router requires:

| Verdict | Packages | Who |
|---|---|---|
| **servable MF remote with an NFS entry point** | **35** | everything not listed below |
| servable remote, **no NFS entry point** | 9 | `argocd`, `@backstage/plugin-techdocs-module-addons-contrib`, all 6 `@roadiehq/*`, `qe-theme` |
| not published as OCI, so unreachable for this check | 1 | `extensions` |

Every artifact checked ships **both** layouts (`dist-scalprum/` *and* `dist/remoteEntry.js`
+ `dist/mf-manifest.json`), and every `mf-manifest.json` satisfies the router's guards: a
string `name`, a string `metaData.remoteEntry.name`, and an `exposes` array whose every
entry carries a `name`. Note the router does **not** require `exposes` to be non-empty —
`[]` passes its check and the remote is still served, it just exposes nothing.

**What "no NFS entry point" does and does not mean.** It means the artifact carries no
`backstage.features`, so the readiness report cannot classify it. It does **not** mean the
plugin fails to load under NFS: RHDH's `nfsModuleFilter` returns no resolver at all when
`backstage.features` is absent or empty (`rhdh:packages/backend/src/modules/nfsModuleFilter.ts`),
so the router then advertises **every** exposed module and
`@backstage/frontend-dynamic-feature-loader` decides at runtime by the `$$type` of each
module's default export. Whether these 9 mount anything cannot be told from metadata — only
by executing the bundle. `@roadiehq/backstage-plugin-{argo-cd,datadog,github-insights}` do
expose an `alpha` module, so they are the likeliest of the nine to mount already.

The practical consequence for a ticket: do not assume a lane for these workspaces will show
an empty page, and do not assume it will work either. Run it and look.

### 2.3 What is still genuinely blocked

| Blocker | State |
|---|---|
| `rhdh:packages/app-next` ships only catalog, scaffolder, search, user-settings + the dynamic loader | **open** — no home page, global header, theme, notifications, techdocs, signals or auth-provider UI. A `createFrontendModule({pluginId: 'home'})` plugin attached to a host that lacks `plugin-home` is silently orphaned, not an error. |
| [RHIDP-15482](https://redhat.atlassian.net/browse/RHIDP-15482) — `app-auth`/`app-integrations` are not in the RHDH image | **open** — this is why `app-defaults-app-next` is skipped in nightly. |
| The wrapper overlap | **open** — RHDH bakes ~43 plugins into its image. Several suites load the baked-in copy rather than this repo's OCI artifact (see the `artifact` column in §3). `tech-radar`'s app-next skip reason is literally "once the tech-radar wrapper is removed". |
| Scalprum-only config surfaces with no `app.extensions` equivalent | **open** — notably `themes:`/`appIcons:`/`importName:` (`theme`) and the 22 header config keys in `global-header`. |

---

## 3. Per-workspace triage

**Blocker class** — the heaviest thing the suite needs, which is what decides where it can run:

- **`none`** — self-contained. Needs the app and nothing else.
- **`svc`** — a real external SaaS (GitHub, Quay, ACR, Jira). Never needed a cluster.
- **`ctr`** — a companion that is an ordinary process: a Keycloak, an SMTP sink, an HTTP
  server. Replaceable with a container.
- **`ocp`** — OpenShift is the subject: an operator, a CRD, the Kubernetes API, or a
  ConfigMap-patch-and-restart cycle. Stays on Prow.

**`artifact`** — whether the suite exercises the artifact this repo publishes (`oci`), the
copy baked into the RHDH image (`baked-in`), or both (`mixed`). This is about which copy the
e2e suite loads and is **not** the readiness report's classification — that report dropped
its own `baked-in` status in #3284 and now infers such plugins' features from upstream
source instead. `scalprum` counts config
keys NFS does not read (`mountPoints`, `dynamicRoutes`, `menuItems`, `appIcons`, `themes`,
`entityTabs`, `importName`) — each one needs an `app.extensions` equivalent before an NFS
lane means anything.

| Workspace | Prj | Tests | NFS lane | Auth | Class | External dependency | artifact | scalprum | NFS readiness |
|---|---|---|---|---|---|---|---|---|---|
| `analytics` | 2 | 1 | ✅ | guest | **none** | none — Segment is fully mocked with `page.route` | mixed | 0 | ready |
| `theme` | 1 | 5 | — | guest | **none** | none | baked-in | 9 | `theme` ready, **`qe-theme` no NFS entry point** |
| `acr` | 2 | 1 | ✅ | guest | **svc** | real ACR (`rhdhqetest.azurecr.io`) + a GitHub-hosted entity | oci | 0 | ready |
| `quay` | 1 | 3 | — | guest | **svc** | real quay.io repo + security scan | oci | 0 | ready |
| `github` | 2 | 2 | — | github | **svc** | real GitHub Actions runs + issues | baked-in | 0 | ready (5 pkgs) |
| `roadie-backstage-plugins` | 2 | 6 | — | github, guest | **svc** | real GitHub PR data; outbound HTTP | oci | 0 | **all 6 no NFS entry point** (3 do expose `alpha`) |
| `bulk-import` | 3 | 9 | ✅ | github | **svc** | real GitHub repos + generated PRs | baked-in | 17 | ready |
| `quickstart` | 1 | 2 | ✅ (NFS-only) | keycloak | **ctr** | Keycloak (test 1 is guest-only) | oci | 0 | ready |
| `global-header` | 2 | 10 | — | keycloak | **ctr** | Keycloak | mixed | 22 | ready |
| `extensions` | 1 | 11 | — | keycloak | **ctr** | Keycloak + the catalog index image | baked-in | 6 | **no OCI artifact**; the readiness report infers `nfs-ready` from upstream source since #3284 |
| `adoption-insights` | 1 | 7 | — | keycloak | **ctr** | Keycloak users + the analytics DB | oci | 0 | ready (+1 module) |
| `tech-radar` | 2 | 1 | ✅ (skipped) | keycloak | **ctr** | an in-cluster HTTP customization-provider | oci | 0 | ready, ships dual |
| `keycloak` | 1 | 2 | — | keycloak | **ctr** | a real Keycloak; metrics via port-forward | n/a | 0 | backend-only |
| `rbac` | 2 | 27 | — | keycloak | **ctr** | Keycloak users/groups + a ConfigMap | mixed | 6 | ready |
| `scorecard` | 2 | 16 | — | keycloak | **ctr** + svc | Keycloak + real GitHub and Jira data | mixed | 25 | ready |
| `homepage` | 1 | 18 | — | keycloak | **ctr** | Keycloak groups + `oc apply` of an RBAC ConfigMap + DB persistence | oci | 10 | ready |
| `app-defaults` | 1 | 3 | ✅ (NFS-only, skipped) | keycloak | **ctr** | Keycloak; the GitHub test only asserts a redirect URL | oci | 0 | ready (3 pkgs) |
| `argocd` | 1 | 7 | — | keycloak | **ocp** | in-cluster ArgoCD via an operator subscription | mixed | 5 | **no NFS entry point** |
| `tekton` | 2 | 3 | ✅ | keycloak | **ocp** | OpenShift Pipelines operator + real `PipelineRun`s | mixed | 5 | ready |
| `topology` | 2 | 4 | ✅ | keycloak | **ocp** | real pods/deployments + RBAC-gated pod logs | mixed | 4 | ready |
| `orchestrator` | 1 | 26 | — | keycloak | **ocp** | SonataFlow / OpenShift Serverless Logic | n/a | 0 | ready (2 pkgs) |
| `scaffolder-backend-module-kubernetes` | 1 | 1 | — | keycloak | **ocp** | creates and deletes a real namespace — the API call *is* the assertion | n/a | 0 | backend-only |
| `intelligent-assistant` | 1 | 34 | — | keycloak | **ocp** | a `lightspeed-core` sidecar with EmptyDir vector stores; ConfigMap patch + `oc rollout restart` | oci | 2 | ready |
| `backstage` | **13** | 47 | ✅ (`configure`, names unchanged) | guest, keycloak | **split** | 8 projects on GitHub/GitLab APIs (`svc`), notifications-email on Mailpit (`ctr`), `-kubernetes` and part of `-auth` (`ocp`); `-microsoft-auth` not yet classified | mixed | 2 | ready (6 pkgs) |

### Tally

| Class | Projects | Meaning |
|---|---|---|
| `none` | 3 | needs nothing but the app |
| `svc` | 10 + 8 of `backstage` | needs the internet, not a cluster |
| `ctr` | 13 + 2 of `backstage` | needs a container, not a cluster |
| `ocp` | 8 + 2 of `backstage` | OpenShift is the subject; stays on Prow |

**About 30 of the 48 projects do not need OpenShift.** Three need no external dependency at
all. That is the ceiling on what a cluster-free lane could ever cover — not a plan, a bound.

The classes above account for 47 projects, not 48: `backstage-microsoft-auth` arrived with
#3163 and is not classified yet. It needs a real Azure tenant, which is `svc`, but it also
patches a ConfigMap and waits on `oc rollout status`, so it is not obviously cluster-free —
whoever owns that suite should place it rather than have it inferred here.

---

## 4. The NFS migration recipe, as the merged tickets actually did it

Derived from the four merged workspace migrations (`acr`, `analytics`, `tekton`,
`topology`). Steps 2-6 are conditional; step 1 is not.

1. **Add an `<workspace>-app-next` Playwright project.** This is the whole switch: the
   project name is the namespace, and `e2e-test-utils` keys NFS mode off the `-app-next`
   suffix, then merges its own bundled layer setting `APP_CONFIG_app_packageName: app-next`
   and `ENABLE_STANDARD_MODULE_FEDERATION: "true"`, plus the `app-auth` /
   `app-integrations` plugins. Workspaces author none of that. For `analytics` this was the
   entire change — three lines.

2. **Branch entity-page tab locators on the project name.** Legacy uses Scalprum's shared
   mount-point label; NFS uses the plugin's own `EntityContentBlueprint` title. Both merged
   examples needed it:

   ```ts
   const tabName =
     testInfo.project.name === "acr-app-next" ? "ACR IMAGES" : "Image Registry";
   ```

   `tekton` did the same for `"Tekton"` vs `"CI"`. This is the clearest signal in the epic
   that these assertions are about extension wiring rather than about the external service.

3. **Add the extension-point config NFS needs in `dynamic-plugins.yaml`.** Scalprum derived
   placement from the mount point; NFS does not. `tekton` and `topology` both had to add an
   explicit `entity.page.<plugin>/cards` entry with an `importName` and an `if:`/`anyOf:`
   visibility guard, and to swap `backstage-plugin-kubernetes` from a local dist path to an
   OCI ref.

4. **Add an `app.extensions` block to `app-config-rhdh.yaml`** for plugins that register
   pages or APIs through NFS's own mechanism rather than `dynamicRoutes`/`mountPoints`.
   `homepage` needed this. Legacy ignores the block, so one file serves both lanes.

5. **Make companion-infra scripts idempotent.** The NFS lane is a *second parallel project
   against the same cluster*, so operator installs race. `tekton` and `topology` both had to
   tolerate `AlreadyExists` and look for the webhook in either namespace.

6. **Raise install-container limits if both bundles are installed together.** `topology`
   needed a `value_file.yaml` `initContainers` override lifting `MAX_ENTRY_SIZE`, because
   legacy + NFS bundles together exceed the chart default.

**Before starting, check two things** that make the difference between an NFS lane that
means something and one that does not:

- the `artifact` column above — if it says `baked-in`, the suite is testing RHDH's bundled
  copy, not the artifact this repo publishes, and an NFS lane inherits that;
- the `scalprum` column — every one of those keys needs an `app.extensions` equivalent, or
  the plugin loads and contributes nothing.

---

## 5. Two failure modes to assert against, because both are silent

Neither produces an error. A suite that only checks "the page loaded" passes through both.

1. **The remote is never served.** The remotes router logs the reason and `continue`s past a
   malformed manifest, so `GET /.backstage/dynamic-features/remotes` answers `200 []` and
   the app boots clean with no plugins. `smoke-tests-native` now validates the manifest
   shape rather than its presence and reports it as `frontend.bundles[].mf` in
   `results.json`.

2. **The remote is served but contributes nothing.** Its extensions attach to a host plugin
   the app does not have — orphaned extensions are collected and never reported — or it
   declares NFS entry points the manifest never exposes, in which case `nfsModuleFilter`
   keeps no modules. `mf.servable: true` with a non-empty `mf.nfsFeatures` and an empty
   `mf.nfsFeaturesExposed` is that second state.

So assert a positive DOM fact, not the absence of errors.

---

## 6. Reproducing the numbers

```bash
# Playwright projects (48) and the lanes named -app-next among them (11)
grep -h 'name: "' workspaces/*/e2e-tests/playwright.config.ts | wc -l
grep -h 'name: ".*-app-next"' workspaces/*/e2e-tests/playwright.config.ts

# The other NFS lanes, which the line above misses because they keep their legacy names
grep -rl 'useNewFrontendSystem: true' workspaces/*/e2e-tests --include='*.ts' \
  | grep -v node_modules | cut -d/ -f2 | sort -u

# Spec files (43)
ls workspaces/*/e2e-tests/tests/**/*.spec.ts | wc -l

# Static tests (261). Counting only *.spec.ts undercounts: orchestrator registers 26 of
# its tests from tests/specs/*.tests.ts modules imported by one spec. The lookbehind
# drops method calls such as `.test(` that are not test declarations. Needs GNU grep -P
# (`ggrep` on macOS).
grep -rhoP '(?<![\w.])test\s*\(' workspaces/*/e2e-tests --include='*.ts' \
  | grep -v node_modules | wc -l

# NFS readiness across the whole catalog (needs oras + a GHCR login)
./scripts/nfs-readiness-report.sh --markdown --oci

# Manifest shape for one workspace's artifacts, plus the backend boot
yarn --cwd smoke-tests-native smoke --workspace <workspace>
```

The readiness report has two caveats, now documented in its own output: `mixed` and
`legacy-only` are structurally unreachable buckets — read `no-features` as "not migrated" —
and it cannot tell a package with no MF bundle from one whose served remote merely exposes
no NFS entry point. `smoke-tests-native` reports the latter distinction per package.
