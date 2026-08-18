# What each e2e workspace tests today, and where it belongs

Companion to [`nfs-e2e-triage.md`](./nfs-e2e-triage.md), which measured the epic's *cost*
(46 Playwright projects, 246 tests, 24 workspaces). This one asks what those tests assert, at
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

### 1.2 Testing depth scales with `spec.support`, and four of these workspaces are over-tested by policy

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

Five workspaces have an `-app-next` lane today. Their diffs are the epic's own evidence of what
the work costs, and it tracks the Scalprum-key count from the triage sheet almost exactly:

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

**The migration as executed increases cluster cost.** The `-app-next` project is added *beside*
the legacy one, not in place of it — `acr`, `tekton`, `topology`, `tech-radar` and `analytics`
all run two projects, so two namespaces. Carried across all 24 workspaces that takes the epic
from 46 projects to roughly 65. Whatever else is decided, that doubling should be a conscious
choice with an end date, not a side effect.

## 3. The finding that reorders the whole epic

For each workspace, whether the plugin has an NFS surface upstream (`src/alpha*`), and whether
anything tests it (`createExtensionTester`):

| | Workspaces |
|---|---|
| NFS surface exists, **has a test** | 3 — `github` (7 tests), `tech-radar` (1), `scorecard` (1) |
| NFS surface exists, **no test at all** | **16** |
| No NFS surface upstream yet | 3 — `keycloak`, `quay`, `scaffolder-backend-module-kubernetes` (two are backend-only, so none is due) |

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

The one every workspace needs, and the one 16 of them are missing. Template:
[`community-plugins:workspaces/github/plugins/github-actions/src/alpha/entityContent.test.tsx`](https://github.com/backstage/community-plugins/blob/main/workspaces/github/plugins/github-actions/src/alpha/entityContent.test.tsx).

```tsx
// workspaces/acr/plugins/acr/src/alpha.test.tsx   (community-plugins)
import { screen } from '@testing-library/react';
import {
  createExtensionTester,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/frontend-test-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { acrImagesEntityContent } from './alpha';   // the real export, alpha.tsx:60
import { acrApiRef } from './api';

it('mounts the ACR entity content and renders the image table', async () => {
  renderInTestApp(
    <TestApiProvider apis={[[acrApiRef, { getTags: async () => fixtureTags }]] as const}>
      <EntityProvider entity={sampleEntity}>
        {createExtensionTester(acrImagesEntityContent).reactElement()}
      </EntityProvider>
    </TestApiProvider>,
  );

  // A positive DOM fact — see §6. Never assert only that nothing threw.
  await expect(screen.findByText('latest')).resolves.toBeInTheDocument();
});
```

`createExtensionTester` also takes `{ config: {...} }`, which is how you assert the extension's
config schema — the NFS replacement for the Scalprum `config:` block the e2e suite sets today.

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

const { server } = await startTestBackend({ features: [keycloakCatalogModule] });
const res = await fetch(`${server.url()}/api/catalog/entities?filter=kind=user`);
expect(res.status).toBe(200);
```

In-memory SQLite, ~2 seconds, no cluster. Already used in **27 source files in each** of
`rhdh-plugins` and `community-plugins` — the pattern is established, not new. (The strategy's
"only 4 files" figure counts the `rhdh` repo alone.)

### Recipe C — component behaviour with a mocked API (L3)

`renderInTestApp` is used in **69 source files in `rhdh-plugins`** and **256 in
`community-plugins`**. For any assertion about a table, a filter, a form, a dialog or an error
state, this is the established path, and every one of these workspaces already has neighbours
doing it.

Use `registerMswTestHooks` when the component fetches over HTTP rather than through an API ref —
32 files in `community-plugins` do, only 1 in `rhdh-plugins`, which is the bigger gap of the two.

### Recipe D — a real browser without a cluster (L4a)

Does not exist here yet, and is the one piece worth building **once** for all 24 workspaces.
`smoke-tests-native/` already does the hard part: it installs the published OCI artifact, boots
a real backend with no Docker and no cluster, and since #3282 validates that the artifact's
module-federation remote is servable and exposes its declared NFS entry points. What is missing
is a browser pointed at an app that loads that remote.

Prior art to reuse rather than reinvent: `rhdh` PR #4523 (Playwright `webServer` against a local
Backstage), and `@backstage/e2e-test-utils/playwright`, which the strategy flags as still needing
evaluation.

> **How the adoption counts here were measured.** `grep -rl --include='*.ts' --include='*.tsx'`
> over full checkouts of `redhat-developer/rhdh-plugins` at `b6e0f31` and
> `backstage/community-plugins` at `7f8712b`, counting source files only. An earlier revision
> quoted GitHub's code-search totals (71/283 and 31/32); those count every file type, markdown
> included, and did not reproduce locally. The numbers above are the ones that do.

## 5. Per workspace

`sup` = `spec.support`. `up` = test files in the upstream plugin workspace. `α` = does its NFS
surface have a `createExtensionTester` test. **Cluster after** = tests that would still need 4b.

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
| `app-defaults` | TP | 3 | 6 | **no** | 0 | A real IdP is the subject, but a container is a real IdP: **L4a with Keycloak in a container**. Blocked by RHIDP-15482. Note this is the only workspace whose *only* project is `-app-next`. |
| `scorecard` | **dev-preview** | 16 | 145 | yes | 0 | The matrix requires **nothing** at this tier, and the plugin already has 145 upstream test files and the only `createExtensionTester` test in `rhdh-plugins` besides `boost`. Empty, error and invalid-threshold states cannot be produced from live GitHub or Jira, so the suite is already faking them one layer too high. Move the lot to **L3** beside `ScorecardLayoutBlueprint.test.tsx`. |
| `theme` | **community** | 5 | 21 | **no** | 0 | Palette, gradient and border are **L1** — a palette is data. Favicon, logo and title want a real app shell but no external dependency, making this the natural **L4a** pilot. Two blockers: neither `plugins/theme` nor `plugins/qe-theme` has an `alpha` surface at all (the four that do are the `bui-test` / `bcc-test` / `mui4-test` / `mui5-test` fixtures), and NFS has no `app.extensions` equivalent for the `themes:` / `appIcons:` config surface. |

### Not ours — verify integration, do not rewrite their coverage

| Workspace | sup | Tests | up | α | Cluster after | Do this |
|---|---|---|---|---|---|---|
| `backstage` | mixed | 47 | — | — | ~10 | 12 of the epic's 46 projects, the largest single consumer. Catalog CRUD by commit is **L2**; webhook signature verification is **L1**; notifications are **L2** plus **L3**; TechDocs rendering is **L3**. Only `-kubernetes` and part of `-auth` are genuinely 4b. |
| `rbac` | GA | 27 | 71 | **no** | ~3 | Most of the 27 assert policy enforcement — **L2**, where every role runs in one process instead of one namespace each. Nav gating is **L3**. Keep 2–3 walking identity to token to policy to UI. `src/alpha/index.ts` exists and is untested. |
| `topology` | GA | 4 | 32 | **no** | **4** | OpenShift is the subject. **Stays 4b** — and it is one of the few suites that can document a 4b rationale as the matrix requires. Add Recipe A upstream anyway: `topologyPlugin` and `isTopologyAvailable` are exported and untested. |
| `tech-radar` | GA | 1 | 17 | **yes** | 0 | One test: open sidebar, verify heading — and `alpha.test.tsx` upstream already asserts the NFS page renders. The overlay test adds only "the OCI artifact loads", which `smoke-tests-native/` already checks. Cheapest 4a candidate in the epic; blocked only by the baked-in wrapper. **Has no Jira ticket.** |
| `keycloak` | GA | 2 | 8 | n/a | 0 | Backend-only — **NFS does not apply to this workspace**, and the ticket may reduce to recording that. Both tests are **L2**: `startTestBackend` plus Keycloak in a testcontainer, no cluster and no port-forward. 2 `startTestBackend` files upstream already. |
| `scaffolder-backend-module-kubernetes` | GA | 1 | 2 | n/a | **1** | The API call is the assertion. Irreducible, stays 4b. Also backend-only, so NFS does not apply — likely a no-op ticket. |
| `argocd` | community | 7 | 61 | **no** | ~3 | Drawer and the Kind/Name/Sync/Health filters are **L3**. Blue-green and canary rollouts with analysis runs stay 4b. Tier requires no E2E at all, so scope this behind the GA workspaces. Ships no `backstage.features` — see the correction already on that ticket for what that does and does not imply. |
| `github` | community | 2 | 25 | **yes** | 0 | **Already covered upstream**: 7 `createExtensionTester` tests across 5 `alpha/` directories, including `entityContent.test.tsx` for exactly the mounting this suite checks. The two overlay tests are redundant at that layer; what they uniquely add is "the published artifact loads", which is a load check. Also uses the baked-in copy rather than this repo's artifact — confirm which is exercised before calling a pass coverage. |
| `roadie-backstage-plugins` | mixed | 6 | — | — | 0 | Third-party. Pagination, per-page and OPEN/CLOSED/ALL filters are the vendor's to test, and "the 5 most recently updated PRs" is non-deterministic against live GitHub by construction. Our responsibility is Recipe B levels 1–2. The `http-request` scaffolder test is an action test. |
| `quay` | community | 3 | 17 | n/a | 0 | No NFS surface upstream yet, so Recipe A is blocked until one exists. Tab and scan rendering are **L3**; "Creates Quay repository" writes to a real quay.io registry from CI to test a scaffolder action — **L2** with msw (2 msw files present). |
| `acr` | community | 1 | 8 | **no** | 0 | Already migrated, and its diff is the clearest evidence in the epic: the `"ACR IMAGES"` / `"Image Registry"` branch is pure wiring. `acrImagesEntityContent` is exported at `alpha.tsx:60` and untested — Recipe A verbatim. Only 8 upstream test files, the thinnest of the community set. |
| `tekton` | community | 3 | 30 | **no** | **3** | Real `PipelineRun`s from the operator. Stays 4b, with a documented rationale. Reference recipe alongside `topology`. |
| `analytics` | mixed | 1 | 4 | **no** | 0 | Already dependency-free — Segment fully mocked with `page.route` — and the cheapest existing 4a-shaped lane. Keep as the reference: it is the only coverage anywhere that a frontend *module* (not a plugin) mounts under NFS. Four untested `alpha.ts` surfaces upstream, on only 4 test files. |

### Where it lands

| | Now | Proposed |
|---|---|---|
| Tests needing a cluster | 246 | ~54 |
| Namespaces per full run | 46 (heading for ~65 as lanes double) | ~10 |
| Plugins whose NFS surface has a test | 3 of 22 | 22 of 22 |

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
- **Not a change to either governing document.** Sections 1.1 and 1.2 are quotations.
