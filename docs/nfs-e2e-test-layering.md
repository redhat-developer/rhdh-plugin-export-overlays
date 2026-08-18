# What each e2e workspace is actually testing, and where it belongs

Companion to [`nfs-e2e-triage.md`](./nfs-e2e-triage.md), which measured the epic's *cost*
(46 Playwright projects, 246 tests, 24 workspaces). This one asks the other half of the
question the epic opens: for each of those 246 tests, **what is the cheapest layer that can
hold the assertion it makes?**

The NFS migration is the forcing function. Under NFS a suite's Scalprum `mountPoints` /
`dynamicRoutes` config is inert — the tab, the card, the header slot come from the plugin's
own `EntityContentBlueprint` instead. So every assertion that a suite has to *rewrite* during
this migration is, by construction, an assertion about **declarative wiring** rather than
about the external service the suite claims to test. Those are precisely the assertions a
`createExtensionTester` test upstream can hold, at no cluster cost and with a far better
failure message.

This document is a **proposal per workspace**, not a measurement. Every recommendation needs
confirmation by whoever owns the plugin. Nothing here proposes deleting coverage: it proposes
moving it down a layer.

## Layers

| Layer | Where it runs | Tool | Cost |
|---|---|---|---|
| **L1** unit | upstream plugin repo | jest | seconds |
| **L2** component | upstream plugin repo | `renderInTestApp`, `createExtensionTester` | seconds |
| **L3** backend integration | upstream plugin repo | `startTestBackend` (+ testcontainers) | ~a minute |
| **L4a** cluster-free e2e | this repo | a browser against a locally-booted app-next + the published OCI remote | minutes, no cluster |
| **L4b** cluster e2e | Prow | the current suites | a namespace, an operator, a claim |

L4a does not exist yet. `smoke-tests-native/` already does the hard half — it installs the
published artifact and boots a real backend with no Docker and no cluster — and
[`loader.ts`](../smoke-tests-native/src/loader.ts) already validates that the artifact's
module-federation remote is servable. What is missing is a browser pointed at an app that
loads that remote. That is the foundation piece worth building once, for everyone.

## The three questions that decide the layer

1. **Is the external service the subject, or just the fixture?** `topology` asserts that a
   pod's logs are RBAC-gated — OpenShift *is* the subject. `github` asserts that a table
   renders five rows — GitHub is a fixture, and a fixture that rate-limits.
2. **Could the assertion be produced deterministically?** An empty state, an error state, a
   threshold-misconfiguration state cannot be reliably produced against live data. If a suite
   asserts them today it is already faking, and faking is cheaper one layer down.
3. **Does the assertion survive the NFS rewrite unchanged?** If it does not, it was testing
   the wiring.

## Per-workspace

Cluster column: how many of the workspace's current tests would still need a **cluster** after
the move. `tests` is the static `test()` count from the triage sheet.

| Workspace | Tests | Cluster after | Where the rest goes |
|---|---|---|---|
| `orchestrator` | 26 | ~18 | Three tests assert HTTP retry semantics (`503 retries with delay 1500 and backoff 2`, `404 is not retried`, `single fetch when maxAttempts absent`) — a fetch wrapper's unit tests, running on OpenShift Serverless Logic. **L1, upstream.** Workflow execution, abort, rerun and status transitions need SonataFlow and stay. |
| `intelligent-assistant` | 34 | ~6 | The display modes (overlay / dock / fullscreen), sidebar open-close-reopen, default prompts, scroll controls, conversation filter and switch, and the whole file-attachment validation set (rejects unsupported types, rejects duplicates, rejects multiple files) are chat-widget behaviour that needs no LLM. **L2.** Only bot response, feedback submission and model selection need the `lightspeed-core` sidecar. |
| `backstage` | 47 | ~10 | Catalog CRUD driven by committing `catalog-info.yaml` is provider integration (**L3**); GitHub webhook signature verification is **L1**; notification mark read/unread/saved is **L3** plus **L2**; TechDocs page rendering is **L2**. Only `-kubernetes` and part of `-auth` need OpenShift. This workspace alone declares 12 of the epic's 46 namespaces. |
| `rbac` | 27 | ~3 | Most of the 27 assert *policy enforcement* — a user with role X can or cannot do Y. That is `startTestBackend` plus a permission policy (**L3**), where every role can be exercised in the same second. Nav visibility gating is **L2**. Keep 2–3 that walk identity → token → policy → UI end to end. |
| `homepage` | 18 | ~6 | Persistence across reload and re-login, per-user isolation and resized-layout persistence are genuine integration and stay. The add-widget dialog listing plugins, each widget type adding, multiple widgets producing distinct cards, and layout surviving an edit-mode toggle are **L2** against a mocked home API. |
| `scorecard` | 16 | 0 | The strongest single candidate in the epic. 29 `toBeVisible` and 8 `toContainText` over cards rendering a metric response; the empty state, the error state and the invalid-threshold state cannot be produced from live GitHub or Jira at all. **L2** throughout, with the aggregation logic at **L1**. |
| `extensions` | 11 | 0 | Search, category/author/support filters, badges and the installed-packages table are **L2**; enable-disable and edit-package write through a backend, so **L3**. Note this workspace publishes no OCI artifact — it is baked into the RHDH image — so a cluster-free *artifact* lane cannot cover it either way. Its natural home is `rhdh-plugins/workspaces/extensions`. |
| `global-header` | 10 | 0 | Ten tests asserting that a logo, a button, a dropdown or a search modal is visible, configured through 22 Scalprum keys that NFS replaces with `app.extensions`. Every one is a `createExtensionTester` assertion (**L2**). Blocked as e2e regardless: `app-next` ships no global header. |
| `bulk-import` | 9 | 0 | Generating a real pull request on GitHub to assert the content of the `catalog-info.yaml` inside it is backend logic — **L3** with a recorded GitHub. The permission test is **L3** against the RBAC policy. Creating real PRs from CI also leaves artifacts behind. |
| `adoption-insights` | 7 | 0 | Panels and the date-range picker are **L2**. "This click was recorded" is frontend-module → backend → database, which is exactly `startTestBackend` (**L3**) and does not need a seeded cluster DB. |
| `argocd` | 7 | ~3 | The drawer and the resource-table Kind/Name/Sync/Health filters are **L2** against a mocked ArgoCD API. Blue-green and canary rollout details with analysis runs need a real ArgoCD and stay. |
| `roadie-backstage-plugins` | 6 | 0 | Pagination arrows, the 5/10/20 per-page selector and the OPEN/CLOSED/ALL filter are table-component behaviour (**L2**); asserting "the 5 most recently updated PRs" against live GitHub is non-deterministic by construction. The `http-request` scaffolder test is an action test (**L3**). |
| `theme` | 5 | 0 | Palette, header gradient, border colour, favicon, logo and title — no external dependency at all, so this is the natural **L4a** pilot. Two blockers: `qe-theme` still uses the legacy `createPlugin`, and NFS has no `app.extensions` equivalent for the `themes:` / `appIcons:` config surface. Until then the colour assertions are **L1** against the theme object. |
| `topology` | 4 | 4 | OpenShift is the subject: real pods, real deployments, RBAC-gated pod logs. **Stays L4b.** Already migrated — its diff is the reference recipe. |
| `quay` | 3 | 0 | Tab presence and security-scan rendering are **L2**. "Creates Quay repository" writes to a real quay.io registry from CI to test a scaffolder action — **L3**. |
| `tekton` | 3 | 3 | Real `PipelineRun`s from the OpenShift Pipelines operator. **Stays L4b.** Already migrated; reference recipe. |
| `app-defaults` | 3 | 0 | OIDC login, an authenticated catalog API call, and a sign-in redirect URL. A real IdP is the subject, but a *container* is a real IdP — **L4a with Keycloak in a container**, no OpenShift. Blocked by RHIDP-15482 (`app-auth` / `app-integrations` are not in the image). |
| `quickstart` | 2 | 0 | Two tests carrying 14 clicks, 10 `verifyButtonURL` and 17 text assertions over static drawer content. **L2**, entirely. The only e2e-shaped question — does the drawer differ for guest and authenticated users — needs an identity, not a cluster. |
| `github` | 2 | 0 | Renders open issues and the five most recent Actions runs. **L2** with a mocked API; live GitHub adds rate limits and ordering flake for no extra signal. |
| `keycloak` | 2 | 0 | A backend catalog provider ingesting users from Keycloak, plus its failure-counter metrics. No frontend at all — `startTestBackend` with Keycloak in a testcontainer (**L3**). Worth stating plainly on the ticket: both published packages are backend-only, so **NFS does not apply to this workspace**. |
| `analytics` | 1 | 0 | Already dependency-free — Segment is fully mocked with `page.route`. Keep it as the **L4a** reference lane: it is the cheapest proof that the loader mounts a frontend *module* (not a plugin) under NFS, which nothing else covers. |
| `acr` | 1 | 0 | The tab-title branch (`ACR IMAGES` under Scalprum vs `Image Registry` under NFS) is pure wiring — **L2** on the `EntityContentBlueprint`. The image table is **L2** against a mocked `acrApiRef`. What is left is "does the published artifact mount its tab", which is exactly **L4a**. The live `rhdhqetest.azurecr.io` dependency asserts that Azure works. |
| `tech-radar` | 1 | 0 | One test: open the sidebar, verify a heading. The cheapest **L4a** candidate in the epic, already skipped in nightly, blocked only by the baked-in wrapper. |
| `scaffolder-backend-module-kubernetes` | 1 | 1 | Creates and deletes a real namespace; the API call *is* the assertion. Irreducible, **stays L4b**. Also backend-only, so NFS does not apply — this ticket may be a no-op. |

### Where that lands

| | Now | Proposed |
|---|---|---|
| Tests running against a cluster | 246 | ~54 |
| Namespaces needed per full run | 46 | ~10 (the `ocp` class from the triage sheet) |

Roughly **a fifth of the current e2e suite is testing something that needs a cluster**. The
rest is testing plugin rendering, table behaviour, form validation, retry policy and
permission logic — all of which have a faster, more deterministic home one or two layers down,
and most of which have to be rewritten during this migration anyway.

## What to build once, rather than 24 times

1. **The L4a lane.** A browser against a locally-booted app-next that loads the workspace's
   published OCI remote. `smoke-tests-native/` already installs the artifact, boots the
   backend, and validates the remote is servable; the missing piece is the page. This single
   piece unlocks the `none` and much of the `svc` class from the triage sheet.
2. **A shared "does it mount" assertion.** Every workspace needs the same first test — the
   remote loaded and contributed its extension. Today each suite reimplements it as "a tab
   with this title exists". Under NFS that assertion is worth making directly.
3. **Upstream test scaffolding.** `createExtensionTester` is what makes the L2 column above
   real. Where a plugin has no component-test setup at all, that is the blocking task, not
   the NFS migration.

## Assert a positive fact, not the absence of an error

Repeating the warning from the triage sheet because it applies to every layer here: under NFS,
a plugin that fails to contribute produces **a clean boot with nothing on the page** — no
error, no console warning, exit 0. A test that only checks the app loaded will pass against a
plugin that contributed nothing. Every lane, at every layer, has to assert a DOM fact that is
only true when the plugin mounted.
