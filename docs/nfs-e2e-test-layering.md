# What each e2e workspace tests today, and where it belongs

Companion to [`nfs-e2e-triage.md`](./nfs-e2e-triage.md), which measured the epic's *cost* in
Playwright projects, tests and workspaces. That count moves as lanes are added — it was 46
projects when this was written and 48 three days later — so it is not restated here; the
triage doc's §6 gives the one-line commands that regenerate it. This one asks what those
tests assert, at
which layer each assertion belongs, and **exactly how to write it there** — file path, package,
export symbol.

It is governed by two documents that already exist and already decide most of this:

- **[RHDH Test Strategy](https://docs.google.com/document/d/1n7jUaOzFLAGANmsyVrOOnFcwI65dAFESHXTsxY2DXhU)** —
  the 4-layer model, and the rule that new verification goes to the lowest layer that gives
  confidence.
- **[`rhdh:docs/testing-requirements-matrix.md`](https://github.com/redhat-developer/rhdh/blob/main/docs/testing-requirements-matrix.md)** —
  how much of each layer applies to whom, keyed on the package's declared `spec.support`.

Neither is proposed here. What is new is applying them to these 24 workspaces one at a time.

> **Layer numbering.** L1 unit · **L2 integration (`startTestBackend`)** · **L3 component (RTL +
> `@backstage/frontend-test-utils`)** · L4a plugin E2E in a real browser, no cluster · L4b
> platform E2E on a deployed cluster. This is the matrix's numbering. An earlier revision of
> this document had L2 and L3 swapped; the per-ticket comments were re-posted to match.

## 1. Two rules already decided, that most of this epic has not applied yet

### 1.1 "E2E" already means 4a by default

From the matrix, verbatim:

> Where the requirement tables below say "E2E", **Layer 4a is the default**; Layer 4b applies
> only when the test genuinely requires real infrastructure (OAuth providers, Kubernetes API,
> external databases, operators), and that rationale must be documented on the test.

Every suite in this repo is 4b. None of them documents a 4b rationale, because the rule
postdates them. Applying it is not a new proposal — it is bringing the suites up to the
standard already written.

### 1.2 Testing depth scales with `spec.support`, and seven of these workspaces are over-tested by policy

The matrix requires **no E2E at all** for Community, and **nothing at all** for Dev Preview —
Community owes only a load test, which `smoke-tests-native/` already performs off-cluster.
Against `spec.support` in `workspaces/*/metadata/*.yaml`:

| Workspace | `spec.support` | Matrix requires | Has today |
|---|---|---|---|
| `scorecard` | **dev-preview** | nothing — no layer, no load test | 16 cluster tests, 2 projects |
| `theme` | **community** | load test only | 5 cluster tests |
| `quay` | **community** | load test only | 3 cluster tests |
| `argocd` | **community** | load test only | 7 cluster tests |
| `github` | **community** | load test only | 2 cluster tests |
| `acr`, `tekton` | **community** | load test only | migrated to NFS, 2 lanes each |

This is not an argument to delete them. It is an argument that **the epic should not spend
migration effort on them before the GA workspaces**, and that where they do carry value it is
worth recording why, since the tier does not ask for it.

The strategy is equally explicit about upstream code:

> For plugins we do not own and do not contribute to, we should not have goals in terms of
> increasing coverage. Our responsibility is limited to verifying they integrate correctly with
> RHDH (loading, basic routes, auth enforcement).

Which splits the 24 workspaces in two, and the two halves get different advice:

| Origin | Workspaces | Advice |
|---|---|---|
| **`redhat-developer/rhdh-plugins`** — ours | `adoption-insights`, `app-defaults`, `bulk-import`, `extensions`, `global-header`, `homepage`, `intelligent-assistant`, `orchestrator`, `quickstart`, `scorecard`, `theme` | Move assertions down a layer, in the plugin's own repo. The test infrastructure is already there. |
| **`backstage/community-plugins`, `RoadieHQ`, `backstage/backstage`** — not ours | the other 13 | Do **not** rewrite their functional coverage. Verify integration only: does it load, does it mount, is auth enforced. |

## 2. What the merged migrations actually did

Eight workspaces have an `-app-next` lane as of 2026-08-21, up from six when this was
written — `grep -l app-next workspaces/*/e2e-tests/playwright.config.ts` is the current
answer. Five of the first six got there by migration, and those five diffs are the epic's own
evidence of what the work costs, tracking the Scalprum-key count from the triage sheet almost
exactly:

| Workspace | Scalprum keys | Diff | What was needed |
|---|---|---|---|
| `analytics` (#2900) | 0 | **3 lines** | one project entry, nothing else |
| `acr` (#2889) | 0 | ~19 lines | project entry + branch the tab title on `testInfo.project.name` |
| `tech-radar` (#1944) | 0 | ~17 lines | project entry |
| `tekton` (#2761) | 5 | ~90 lines | project entry, tab branch threaded through a page helper's signature, OCI ref for the kubernetes package |
| `topology` (#2760) | 4 | ~96 lines | the above plus a `value_file.yaml` and a deploy-script change |

Two things follow.

**The tab-title branch is the tell.** `acr` had to choose between `"Image Registry"` and
`"ACR IMAGES"`; `tekton` between `"CI"` and `"Tekton"`. Under NFS the suite's Scalprum
`mountPoints` config is inert and the title comes from the plugin's own
`EntityContentBlueprint`. So **any assertion a suite has to rewrite for NFS was, by
construction, testing declarative wiring** — not the external service it claims to test. That
is the single most reusable signal in this epic, and the Scalprum-key column predicts it.

**Adding the lane beside the legacy one increases cluster cost; replacing it does not.**
[measured 2026-08-26] In `acr`, `tekton`, `topology`, `tech-radar`, `analytics` and
`bulk-import` the `-app-next` project was added *beside* the legacy one, so each runs two
projects and claims two namespaces. Eight workspaces did it the other way and have no legacy
lane left: `app-defaults`, `intelligent-assistant`, `keycloak`, `quickstart` and
`scaffolder-backend-module-kubernetes` by renaming the project, and `backstage` (13 projects),
`github` and `homepage` by passing `configure({ useNewFrontendSystem: true })` without
renaming. Ten workspaces are not migrated.

Note what the second mechanism costs a reader: 16 of the 48 projects are NFS while every one
of their names still reads as legacy, so any inventory keyed on the `-app-next` suffix
miscounts them. Deciding between the two mechanisms is
[RHIDP-16461](https://redhat.atlassian.net/browse/RHIDP-16461).

The doubling now has an end date rather than needing one assigned: redhat-developer/rhdh#5232
removes the legacy frontend outright, after which both lanes of an add-beside pair boot the
same shell and the pair is duplication by construction.

## 3. The finding that reorders the whole epic

For each workspace, whether the plugin has an NFS surface upstream (`src/alpha*`), and whether
anything tests it (`createExtensionTester`):

| | Workspaces |
|---|---|
| NFS surface exists, **has a test** | 3 — `github` (7 tests), `tech-radar` (1), `scorecard` (1) |
| NFS surface exists, **no test at all** | **16** |
| No NFS surface upstream yet | 3 — `keycloak` and `scaffolder-backend-module-kubernetes`, both backend-only so NFS does not apply; and `quay`, which is a frontend plugin and *is* due, just blocked until a surface exists |

**Sixteen plugins ship an NFS extension that nothing anywhere tests.** The epic's plan is to
verify them by deploying RHDH to OpenShift and looking for a tab. When one of them fails to
attach, the failure arrives as `heading "X" not found` after a ~20-minute deploy, in a
different repository from the code that broke.

The same fact, tested one layer down, fails in about a second, in the repo that owns the
blueprint, naming the extension. `github` already does this — seven `createExtensionTester`
tests under `plugins/*/src/alpha/`, in `backstage/community-plugins`, the same repo half these
workspaces come from.

**So the first task on most of these tickets is not the e2e migration. It is an
`alpha.test.tsx` upstream.** That test is also the thing that makes the e2e migration safe:
today, if a blueprint does not attach, the NFS lane goes green with an empty page.

## 4. The four recipes

Real code, from the repos these plugins live in.

### Recipe A — does the NFS extension mount? (L3)

The one 16 workspaces are missing. **This was run, not written from the API docs** — against
`community-plugins/workspaces/acr`, whose `acrImagesEntityContent` is exported at `alpha.tsx:60`
and has no test. Final state: **6 tests passing, 5 mutations, each caught by exactly one
assertion** (the `pluginId` mutation by one assertion in two places, since the extension ids
move with it).

First, the prerequisite: `createExtensionTester` lives in `@backstage/frontend-test-utils`, and
several of these plugins carry only `@backstage/test-utils`. It has to be added as a
devDependency.

```tsx
// workspaces/acr/plugins/acr/src/alpha.test.tsx   (community-plugins)
import { screen } from '@testing-library/react';
import { createExtensionTester, renderInTestApp } from '@backstage/frontend-test-utils';
import { coreExtensionData } from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import nfsPlugin, { acrImagesEntityContent } from './alpha';
import { AzureContainerRegistryApiRef } from './api';

const fixtureTags = [{ name: 'latest' }];
const entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'acr-demo', annotations: { 'azure-container-registry/repository-name': 'demo' } },
} as any;

// The wiring assertions. No browser, no DOM, no cluster — these read the extension's
// declared output directly, which is what the e2e suite's "ACR IMAGES" vs "Image
// Registry" tab-title branch is really about.
it('declares the tab title the catalog will render', () => {
  const tester = createExtensionTester(acrImagesEntityContent);
  expect(tester.get(EntityContentBlueprint.dataRefs.title)).toBe('ACR images');
});

it('declares the route path the tab mounts at', () => {
  const tester = createExtensionTester(acrImagesEntityContent);
  expect(tester.get(coreExtensionData.routePath)).toBe('acr-images');
});

// NOT optional. createExtensionTester instantiates the extension in ISOLATION, so it
// cannot see whether the plugin registers it: removing acrImagesEntityContent from the
// plugin's extensions[] leaves both assertions above green. "The plugin forgot the
// extension" is one of the two silent NFS failure modes, so it needs its own assertion.
it('is registered by the plugin, and the plugin is an NFS feature', () => {
  // getExtension, $$type and pluginId are all public API — no cast needed.
  expect(nfsPlugin.getExtension('entity-content:acr/acrImagesEntityContent'))
    .toBeDefined();
  expect(nfsPlugin.$$type).toBe('@backstage/FrontendPlugin');
  expect(nfsPlugin.pluginId).toBe('acr');
});

// The filter the catalog uses to decide which entities get the tab. This is the
// assertion an e2e test is really making when it navigates to an annotated entity
// and looks for the tab — and it is the one the earlier draft of this recipe
// missed, because `filterFunction` only shows up if you enumerate dataRefs.
it('shows the tab only for entities that have the ACR annotation', () => {
  const filter = createExtensionTester(acrImagesEntityContent)
    .get(EntityContentBlueprint.dataRefs.filterFunction);
  if (!filter) throw new Error('the extension declares no entity filter');
  expect(filter(entity)).toBe(true);
  expect(filter({ ...entity, metadata: { ...entity.metadata, annotations: {} } }))
    .toBe(false);
});

// The render assertion. `apis` goes on renderInTestApp, NOT on createExtensionTester —
// see the note below.
it('renders through the extension, with the API mocked', async () => {
  renderInTestApp(
    <EntityProvider entity={entity}>
      {createExtensionTester(acrImagesEntityContent).reactElement()}
    </EntityProvider>,
    { apis: [[AzureContainerRegistryApiRef, { getTags: async () => ({ tags: fixtureTags }) }]] },
  );
  expect(await screen.findByText(/latest/)).toBeInTheDocument();
});
```

**What the mutations proved:**

| Mutation | Caught by |
|---|---|
| `title: 'ACR images'` → `'Image Registry'` | `.get(EntityContentBlueprint.dataRefs.title)` |
| `path: 'acr-images'` → `'acr'` | `.get(coreExtensionData.routePath)` |
| `filter: isAcrAvailable` → `() => true` | `.get(EntityContentBlueprint.dataRefs.filterFunction)` |
| extension removed from `extensions: [...]` | **only** the plugin-composition assertion |
| `pluginId: 'acr'` → `'acr2'` | the composition assertion, twice (the ids move with it) |

**Four details that each cost a debugging cycle:**

- **`EntityContentBlueprint.dataRefs` carries more than `title`.** It also exposes
  `filterFunction`, `filterExpression`, `group` and `icon`; `coreExtensionData` adds
  `routePath`, `routeRef`, `reactElement` and `icon`. Enumerate them once rather than
  guessing — `filterFunction` is the highest-value assertion of the set and is easy
  to miss.
- **`getExtension(id)`, `$$type` and `pluginId` are public**, so the composition
  assertion needs no `as any`. Ids are namespaced: `entity-content:acr/acrImagesEntityContent`,
  not the bare extension name.
- **`apis` belongs on `renderInTestApp`, not on `createExtensionTester`,** when the tester's
  element is nested inside it. `createExtensionTester` does accept an `apis` option, and the
  package's own docs recommend it over wrapping in `TestApiProvider` — but in this composition
  the app's registry wins and the tester's option is silently ignored. The symptom is
  `NotImplementedError: No implementation available for apiRef{plugin.acr.service}`.
- It is `coreExtensionData.routePath`, not `coreExtensionData.routing.path`.
- `.snapshot().id` carries **no plugin-id prefix** when the extension is tested in isolation:
  `entity-content:acrImagesEntityContent`, not `entity-content:acr/...`.

`createExtensionTester` also accepts `{ config: {...} }`, which is how you assert the extension's
config schema — the NFS replacement for the Scalprum `config:` block the e2e suite sets today.
`.snapshot()` returns the extension tree for inline snapshot testing, and `.add(ext, {config})`
brings sibling extensions into the tree when you need to test composition.

### Recipe B — does the backend plugin start, route, and enforce auth? (L2)

For backend packages. The strategy defines three progressive levels, and for plugins we do not
own it says stop at these:

| Level | Assert | Catches |
|---|---|---|
| 1 loading | `startTestBackend({ features: [plugin] })` resolves | missing deps, broken exports, API version mismatch |
| 2 routes | `GET /api/<id>/...` is not 404 | endpoints renamed by a version bump |
| 3 shape + auth | response matches what our frontend reads; unauthenticated is rejected | breaking API changes |

```ts
import { startTestBackend } from '@backstage/backend-test-utils';
import catalogPlugin from '@backstage/plugin-catalog-backend';
import { keycloakCatalogModule } from '../src/module';

// The module has to be started with the plugin that owns the extension point it
// registers into. startTestBackend does create a stub plugin for an orphan module,
// but that stub registers no routes, so a module on its own can never answer
// level 2 — it would 404 on a URL the assertion expects to be 200.
const backend = await startTestBackend({
  features: [catalogPlugin, keycloakCatalogModule],
});

// There is no `server.url()`. `TestBackend.server` is an `ExtendedHttpServer`, whose
// public surface is `start()`, `stop()` and `port()` — Backstage builds its own
// `backend.baseUrl` the same way.
const base = `http://localhost:${backend.server.port()}`;
const res = await fetch(`${base}/api/catalog/entities?filter=kind=user`);
expect(res.status).toBe(200);
```

In-memory SQLite, ~2 seconds, no cluster. Already used in **27 source files in each** of
`rhdh-plugins` and `community-plugins` — the pattern is established, not new. (The strategy's
"only 4 files" figure counts the `rhdh` repo alone.)

Unlike Recipe A this one was **not executed** — it is checked against the published types of
`@backstage/backend-test-utils@1.11.6` and `@backstage/plugin-catalog-backend@3.9.0`, and an
earlier revision of it did not run: it passed a module with no plugin and called a
`server.url()` that does not exist. Treat it as a shape to copy, not as a green test.

### Recipe C — component behaviour with a mocked API (L3)

`renderInTestApp` is used in **70 source files in `rhdh-plugins`** and **284 in
`community-plugins`** (working-tree grep and GitHub code search respectively, both
re-counted 2026-08-21). For any assertion about a table, a filter, a form, a dialog or an error
state, this is the established path, and every one of these workspaces already has neighbours
doing it.

Use `registerMswTestHooks` when the component fetches over HTTP rather than through an API ref —
32 files in `community-plugins` do, only 1 in `rhdh-plugins`, which is the bigger gap of the two.

### Recipe D — a real browser without a cluster (L4a)

**An earlier revision of this document said Layer 4a "does not exist yet". That was wrong**, and
the correction changes the shape of the work. Layer 4a exists, it is larger than the cluster
suite, and it runs on localhost.

Ten of the 11 `rhdh-plugins` workspaces that also carry an overlay e2e suite have a
`playwright.config.ts` with a `webServer` block starting a local instance on ports 3000-3002,
`testDir: 'e2e-tests'`, and specs named `*.test.ts` — which is why an earlier sweep for
`*.spec.ts` missed them entirely. The eleventh, `app-defaults`, has no upstream lane, which
is why it is absent here and why its row in section 5 proposes building one:

| Workspace | 4a in plugin repo (no cluster) | 4b here (cluster) | Identical test names |
|---|---|---|---|
| `intelligent-assistant` | 92 | 34 | 7 |
| `scorecard` | 47 | 16 | 0 |
| `homepage` | 16 | 18 | 1 |
| `extensions` | 12 | 11 | 5 |
| `orchestrator` | 11 | 26 | 0 |
| `adoption-insights` | 10 | 7 | 1 |
| `global-header` | 8 | 10 | 0 |
| `bulk-import` | 6 | 9 | 0 |
| `theme` | 4 | 5 | 1 |
| `quickstart` | 3 | 2 | 2 (all) |
| **Total** | **209** | **138** | **17** |

Both test columns count **statically declared `test()` blocks**, so the two sides are
comparable to each other but are a floor, not a run count: Playwright expands
parametrised tests at collection time, and `npx playwright test --list` reports 19 for
`scorecard` against the 16 declared, 32 for `orchestrator` against 26. They are also a
snapshot — the suites move — so re-derive rather than quote them if a decision turns on
the exact figure.

**Swept 2026-08-18 across the last 300 CI runs: 8 of the 10 lanes are green** — `global-header` 1m34s, `theme` 1m28s, `homepage` 2m24s, `quickstart` 2m52s, `extensions` 4m44s, `bulk-import` 4m47s, `scorecard` 13m30s, `intelligent-assistant` 25m35s. Two are not: `orchestrator` is **persistently red**, three consecutive runs failing after 195m, 216m and 191m against the job timeout, so it burns ~3.5h of runner time and never reports a real result. `adoption-insights` has **no signal at all** — no PR touched it in that window. Note the matrix runs only changed workspaces, so "green" means green the last time the workspace changed, not green today.

No `e2e-tests` directory in those repos references `RHDHDeployment`, `oc`, `kubectl`, `helm` or
`INSTALLATION_METHOD`, so the lane is genuinely cluster-free. `homepage` already parameterises
legacy versus NFS in it through an `appMode` variable — the switch this epic is building across
OpenShift namespaces already exists there as an environment variable. Six of the 11
`community-plugins` workspaces have an equivalent lane, and `acr`, `github` and `tech-radar`
ship a local `packages/app-next` host.

There is also **no Backstage utility that boots an instance**. `@backstage/e2e-test-utils@0.1.2`
exports `generateProjects()` — which returns one Playwright project per monorepo package with an
`e2e-tests` directory — and `failOnBrowserErrors()`. Its only runtime dependencies are `fs-extra`
and `@manypkg/get-packages`. Playwright's own `webServer` is the mechanism, which is what these
workspaces already use. (The parent Test Strategy said otherwise; it was corrected on
2026-08-18, as was `rhdh:docs/testing-requirements-matrix.md`.)

#### So what is actually missing

Not a browser lane. **A browser lane against the published OCI artifact.** That distinction is
the whole remaining gap, and it is narrow:

| | Upstream 4a lane | What this repo would need |
|---|---|---|
| What is exercised | workspace **source**, via `yarn start` | the **published OCI artifact**, installed as a dynamic plugin |
| Loading path | the app imports the plugin directly | `install-dynamic-plugins` → MF remote → `dynamicPluginsFeatureLoader` |

`smoke-tests-native/` covers more of that than it first appears, but less than an earlier
revision of this document claimed. What it does today: installs the published artifact, boots a
real backend in-process via `startTestBackend` (no Docker, no cluster), and since #3282 validates
the MF manifest against the guards the remotes router applies. What it does **not** do: it calls
`backend.stop()` immediately, so it never serves a request; it has no
`@backstage/backend-dynamic-feature-service` dependency, so it never serves
`/.backstage/dynamic-features/remotes`; and the frontend bundle is inspected as a static file,
never executed.

Closing that is four steps, three of them small: keep the backend alive (`startTestBackend`
already exposes `server.port()`), add the dynamic feature loader so the remotes router answers,
serve an app-next host, and point Playwright at it with `webServer`. **Step three is the one
with real unknowns** and the only place the estimate is soft.

## 5. Per workspace

`sup` = `spec.support`. `up` = test files in the plugin's own repo (all layers, not a test count). `α` = does its NFS
surface have a `createExtensionTester` test — `n/a` means the workspace is backend-only so NFS
does not apply, `blocked` means it is due but has no surface to test yet.
**Cluster after** = tests that would still need 4b.
`Tests` carries over the count from [`nfs-e2e-triage.md`](./nfs-e2e-triage.md), so the two
documents add up to the same 246; see the note under Recipe D for what it counts and why
it drifts from what Playwright reports today.

### First, a question that comes before the layer of any individual assertion

For 10 of the 11 workspaces in the table below — every one except `app-defaults` — a
cluster-free Playwright lane **already exists in the plugin's own repo** — 209 tests against the 138 here, with 17 test names byte-identical (see Recipe D).
`quickstart` is identical in both of two: upstream has `test.describe('Test Quick Start plugin')`
with `test('Access Quick start as Guest or Admin')` and `test('Access Quick start as User')`, and
so does the suite here.

So before asking "what layer does this assertion belong at", there is a prior question: **is this
test already covered, cluster-free, upstream?**

**This document does not answer it, and should not.** Exact-name matching is a floor, not the real
overlap — a reworded test will not match — and the two lanes are not equivalent:

| | Upstream 4a | This repo's 4b |
|---|---|---|
| Exercises | workspace **source** | the **published OCI artifact**, loaded as a dynamic plugin |

Two tests with the same name can therefore be testing genuinely different things. A 4b test that
looks redundant may be the only thing covering a ConfigMap mount, a real operator, or the
dynamic-plugin loading path itself. Only the person who owns the plugin and its tests can tell
which, so each duplicate has three honest readings and the owner picks:

- redundant — removing it reclaims a namespace;
- superficially redundant, but covering something the local lane structurally cannot;
- worth keeping while 4a coverage is still being established.

What is worth asking of every one of them is the thing the matrix already requires: that a 4b test
**carry its rationale**. Where that rationale turns out to be "the upstream lane already covers
this", the owner decides whether the copy goes.

### Ours — `redhat-developer/rhdh-plugins`

| Workspace | sup | Tests | up | α | Cluster after | Do this |
|---|---|---|---|---|---|---|
| `orchestrator` | GA | 26 | 123 | **no** | ~18 | The three `retry-workflow` tests already mock every response with `page.route`, so the retry policy never reaches SonataFlow — but they navigate to the form through a live workflow listing, which is why they need the deployment today. Render `ActiveTextInput` with a mocked fetch (**L3**) and the retry helper becomes **L1**. Workflow run, abort and rerun stay 4b. 123 upstream test files and 4 `startTestBackend` files to follow. |
| `intelligent-assistant` | GA | 34 | 81 | **no** | ~6 | Display modes, sidebar state, default prompts, scroll, conversation filter and the whole file-attachment validation set are **L3** — 86 `toBeVisible` assertions that need no model. Only bot response, feedback and model selection need the `lightspeed-core` sidecar. 9 msw files upstream already. |
| `homepage` | GA | 18 | 26 | **no** | ~6 | Persistence across reload and re-login, and per-user isolation, are real integration — keep. The add-widget dialog, per-type add, distinct cards, edit-mode toggle and resize are **L3** against `homePageCards.tsx` extensions, which are `Blueprint.make` and so directly `createExtensionTester`-able. |
| `global-header` | GA | 10 | 28 | **no** | 0 | Ten visibility assertions over 22 Scalprum keys that NFS replaces with `app.extensions`. All **L3** on `src/alpha/index.ts`. Blocked as e2e regardless — `rhdh:packages/app-next` ships no global header. |
| `adoption-insights` | GA | 7 | 53 | **no** | 0 | Panels and date range are **L3**; "this click was recorded" is **L2**, frontend-module to backend to DB. Two NFS surfaces here (`adoption-insights` and `analytics-module-adoption-insights`) and neither is tested. |
| `quickstart` | GA | 2 | 16 | **no** | 0 | Two tests carrying 14 clicks, 10 `verifyButtonURL` and 17 text assertions over static drawer content. **L3**, entirely. The one e2e-shaped question — guest vs authenticated — needs an identity, not a cluster. |
| `bulk-import` | TP | 9 | 46 | **no** | 0 | Generating a real GitHub PR to assert the YAML inside it is **L2** with msw; 10 msw files already exist in this workspace. Permission test is **L2**. 17 Scalprum keys, so NFS rewrites most of this suite anyway. |
| `extensions` | TP | 11 | 39 | **no** | 0 | Filters, badges, search, tables are **L3** on `extensionsPage`; enable-disable and edit-package are **L2** (3 `startTestBackend` files present). Publishes no OCI artifact — it is baked into the image — so a cluster-free *artifact* lane cannot cover it either way. |
| `app-defaults` | TP | 3 | 6 | **no** | 0 | A real IdP is the subject, but a container is a real IdP: **L4a with Keycloak in a container**. Blocked by [RHIDP-15482](https://redhat.atlassian.net/browse/RHIDP-15482). |
| `scorecard` | **dev-preview** | 16 | 145 | yes | 0 | The matrix requires **nothing** at this tier, and the plugin already has 145 upstream test files and the only `createExtensionTester` test in `rhdh-plugins` besides `boost`. Empty, error and invalid-threshold states cannot be produced from live GitHub or Jira, so the suite is already faking them one layer too high. Move the lot to **L3** beside `ScorecardLayoutBlueprint.test.tsx`. |
| `theme` | **community** | 5 | 21 | **no** | 0 | Palette, gradient and border are **L1** — a palette is data. Favicon, logo and title want a real app shell but no external dependency. Note the upstream workspace already has a cluster-free lane with 4 tests, so this is not a greenfield 4a case — check what those cover first. Two blockers: neither `plugins/theme` nor `plugins/qe-theme` has an `alpha` surface at all (the four that do are the `bui-test` / `bcc-test` / `mui4-test` / `mui5-test` fixtures), and NFS has no `app.extensions` equivalent for the `themes:` / `appIcons:` config surface. |

### Not ours — verify integration, do not rewrite their coverage

With two exceptions the table itself then contradicts: `rbac` and `topology` are hosted in
`backstage/community-plugins` but are `generally-available` and both listed in
`rhdh-supported-packages.txt`, so we own their quality whoever hosts them. Read the split as
keyed on support tier, not on the hosting org — the repo is only a proxy for it, and these
two are where the proxy breaks.

| Workspace | sup | Tests | up | α | Cluster after | Do this |
|---|---|---|---|---|---|---|
| `backstage` | mixed | 47 | — | — | ~10 | 13 projects, the largest single consumer of the epic's cluster budget. Catalog CRUD by commit is **L2**; webhook signature verification is **L1**; notifications are **L2** plus **L3**; TechDocs rendering is **L3**. Only `-kubernetes` and part of `-auth` are genuinely 4b. |
| `rbac` | GA | 27 | 71 | **no** | ~3 | Most of the 27 assert policy enforcement — **L2**, where every role runs in one process instead of one namespace each. Nav gating is **L3**. Keep 2–3 walking identity to token to policy to UI. `src/alpha/index.ts` exists and is untested. |
| `topology` | GA | 4 | 32 | **no** | **4** | OpenShift is the subject. **Stays 4b** — and it is one of the few suites that can document a 4b rationale as the matrix requires. Add Recipe A upstream anyway: `topologyPlugin` and `isTopologyAvailable` are exported and untested. |
| `tech-radar` | GA | 1 | 17 | **yes** | 0 | One test: open sidebar, verify heading — and `alpha.test.tsx` upstream already asserts the NFS page renders. The overlay test adds only "the OCI artifact loads", which `smoke-tests-native/` already checks. Cheapest candidate for a 4a lane against the *published artifact* (it has an upstream `packages/app-next` host but no Playwright config); blocked only by the baked-in wrapper. **Has no Jira ticket.** |
| `keycloak` | GA | 2 | 8 | n/a | 0 | Backend-only — both packages are `backend-plugin-module`, so **NFS does not apply to the packages themselves**. It nonetheless now has a `keycloak-app-next` project and no legacy one, which tests that the backend modules still work under an NFS *shell* — a different claim, and one nothing in the suite currently asserts (see [RHIDP-16457](https://redhat.atlassian.net/browse/RHIDP-16457)). Both tests are **L2**: `startTestBackend` plus Keycloak in a testcontainer, no cluster and no port-forward. 2 `startTestBackend` files upstream already. |
| `scaffolder-backend-module-kubernetes` | GA | 1 | 2 | n/a | **1** | The API call is the assertion. Irreducible, stays 4b. Also backend-only, so NFS does not apply — likely a no-op ticket. |
| `argocd` | community | 7 | 61 | **no** | ~3 | Drawer and the Kind/Name/Sync/Health filters are **L3**. Blue-green and canary rollouts with analysis runs stay 4b. Tier requires no E2E at all, so scope this behind the GA workspaces. Ships no `backstage.features` — see the correction already on that ticket for what that does and does not imply. |
| `github` | community | 2 | 25 | **yes** | 0 | **Already covered upstream**: 7 `createExtensionTester` tests across 4 of its 5 `alpha/` directories, including `entityContent.test.tsx` for exactly the mounting this suite checks. The fifth, `github-discussions`, ships an NFS surface with no test — so "covered" is 4 of 5, not all of it. The two overlay tests are redundant at that layer; what they uniquely add is "the published artifact loads", which is a load check. Also uses the baked-in copy rather than this repo's artifact — confirm which is exercised before calling a pass coverage. |
| `roadie-backstage-plugins` | mixed | 6 | — | — | 0 | Third-party. Pagination, per-page and OPEN/CLOSED/ALL filters are the vendor's to test, and "the 5 most recently updated PRs" is non-deterministic against live GitHub by construction. Our responsibility is Recipe B levels 1–2. The `http-request` scaffolder test is an action test. |
| `quay` | community | 3 | 17 | **blocked** | 0 | No NFS surface upstream yet, so Recipe A is blocked until one exists. Tab and scan rendering are **L3**; "Creates Quay repository" writes to a real quay.io registry from CI to test a scaffolder action — **L2** with msw (2 msw files present). |
| `acr` | community | 1 | 8 | **no** | 0 | Already migrated, and its diff is the clearest evidence in the epic: the `"ACR IMAGES"` / `"Image Registry"` branch is pure wiring. `acrImagesEntityContent` is exported at `alpha.tsx:60` and untested — Recipe A verbatim. Only 8 upstream test files, the thinnest of the community set. |
| `tekton` | community | 3 | 30 | **no** | **3** | Real `PipelineRun`s from the operator. Stays 4b, with a documented rationale. Reference recipe alongside `topology`. |
| `analytics` | mixed | 1 | 4 | **no** | 0 | Already dependency-free — Segment fully mocked with `page.route` — and the cheapest existing 4a-shaped lane. Keep as the reference: it is the only coverage anywhere that a frontend *module* (not a plugin) mounts under NFS. Four untested `alpha.ts` surfaces upstream, on only 4 test files. |

### Where it lands

| | Now | Proposed |
|---|---|---|
| Tests needing a cluster | 246 | ~54 |
| Namespaces per full run | one per project, and rising as lanes double | ~10 |
| Plugins whose NFS surface has a test | 3 of 19 | 19 of 19 |

The `~54` is an aggregate of the per-assertion judgements above and nothing more; the table's
arithmetic is checked against it, but the inputs are proposals. It also does **not** net off the
duplicate-coverage question, because that is the owner's to settle: if a meaningful share of the
17 exact-name matches turn out to be genuinely redundant, the real figure is lower, and if they
turn out to be covering the artifact-loading path the upstream lane cannot reach, it is not.

## 6. Assert a positive fact, not the absence of an error

Under NFS a plugin that fails to contribute produces **a clean boot with nothing on the page** —
no error, no console warning, exit 0. A test that only checks the app loaded passes against a
plugin that contributed nothing. This holds at every layer: `createExtensionTester` will happily
render an extension that renders nothing. Assert a DOM fact that is only true when the plugin
mounted.

## 7. What this is not

- **Not a measurement.** The layer assignments come from reading each suite's assertions and
  each plugin's upstream tree, not from running anything. Every row needs the plugin owner's
  confirmation.
- **Not a proposal to delete coverage.** Everything moves down a layer. `topology`, `tekton` and
  `scaffolder-backend-module-kubernetes` stay exactly where they are.
- **Not a change to either governing document.** Sections 1.1 and 1.2 are quotations. Both
  documents were separately corrected on 2026-08-18 on one point of fact — that
  `@backstage/e2e-test-utils/playwright` boots a local instance, which it does not — and
  `rhdh:docs/testing-requirements-matrix.md` gained the measured state recorded here.

### Corrections this document has already needed

Recorded because both were load-bearing, and a reader who saw an earlier revision should know:

- **L2 and L3 were swapped.** The matrix defines L2 as integration (`startTestBackend`) and L3 as
  component (RTL). The first revision had them the other way round, which inverted every backend
  recommendation.
- **"Layer 4a does not exist yet" was wrong.** It exists in 16 of the 22 workspaces, cluster-free,
  today. What does not exist is a 4a lane against the *published artifact* — a much narrower gap.
  The mistake came from sweeping for `*.spec.ts` when the upstream specs are named `*.test.ts`.
