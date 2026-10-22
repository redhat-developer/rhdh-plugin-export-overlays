# RHDH Plugin Export Overlays Context

High-level orientation for agents working in this repo. Detailed topics live in `docs/agents/knowledge/`, indexed below — add new detailed knowledge as its own file there.

## What this repo is

The metadata and automation hub for dynamic plugins in Red Hat Developer Hub (RHDH). It holds no plugin source code: it pins upstream repositories, defines how to package them as OCI container images, and describes how they appear in the Extensions catalog. Key versions live in `versions.json` (Backstage, Node, redhat-developer-hub CLI).

## Two metadata layers

- **Workspaces** (`workspaces/*/`) — how to *build* an image. Each maps to one upstream source repo (monorepo or standalone): `source.json` (repo URL, ref, Backstage version), `plugins-list.yaml` (which plugins to export, with optional CLI args), `metadata/*.yaml` (`kind: Package` entities), `plugins/<plugin>/overlay/` (files replaced or added during packaging), and `patches/*.patch` (diffs applied to the source before build).
- **Catalog entities** (`catalog-entities/extensions/`) — how a plugin *appears* in the RHDH Extensions UI: `plugins/*.yaml` (`kind: Plugin` entities with descriptions, icons, categories, highlights), `collections/*.yaml` (groupings), and `plugins/all.yaml`, an index every plugin YAML must be listed in.

Package entities live in `workspaces/*/metadata/`, not in `catalog-entities/extensions/`; they are merged at build time into the plugin catalog index image.

## Branching, support, and scopes

- **`main`** — development branch for the next RHDH release; all new workspaces go here. **`release-x.y`** branches only take updates to existing workspaces, never new ones.
- Support levels are tracked in `rhdh-supported-packages.txt` (Red Hat supported — GA, or TP heading to GA) and `rhdh-community-packages.txt` (community supported). The plugin sweep does **not** read those files: it selects from `spec.support` in `workspaces/*/metadata/*.yaml`, which is what the build publishes from, one tier per nightly cron. The two currently disagree (41 workspaces carry a community package; the txt file names 20), so neither is authoritative for the other's purpose.
- Auto-discovery covers three npm scopes, defined in `plugins-regexps`: `@backstage-community/` (backstage/community-plugins), `@red-hat-developer-hub/` (redhat-developer/rhdh-plugins), and `@roadiehq/` (RoadieHQ/roadie-backstage-plugins).

## Where work runs

OCI packaging and publishing run through GitHub Actions. Workspace E2E tests run locally against an OpenShift cluster or in OpenShift CI (Prow). PR slash commands are in [pr-workflow.md](docs/agents/knowledge/pr-workflow.md#pr-commands); the workflow table and fullsend commands are in [scripts-and-ci.md](docs/agents/knowledge/scripts-and-ci.md#github-workflows).

## Knowledge index

| Topic | File | Read it before |
|---|---|---|
| Workspace maintenance | `docs/agents/knowledge/workspace-maintenance.md` | creating a workspace, changing `workspaces/*/source.json`, `backstage.json`, `versions.json`, `plugins-list.yaml`, or metadata versions; reviewing a `workspace-update` PR |
| Patches and lockfiles | `docs/agents/knowledge/patches-and-lockfiles.md` | touching `patches/`, a `yarn.lock` inside a patch, `cve-backports.yaml`, or a `source.json` ref in a workspace that has patches |
| Dynamic plugins | `docs/agents/knowledge/dynamic-plugins.md` | editing `scalprum-config.json`, `--embed-package`, `dynamic-plugins.yaml`, installation example tags; diagnosing a missing module or route 404 |
| Metadata and catalog | `docs/agents/knowledge/metadata-and-catalog.md` | editing `metadata/*.yaml`, `catalog-entities/`, `default.packages.yaml`, or any support level |
| E2E testing | `docs/agents/knowledge/e2e-testing.md` | setting up or changing a local run, editing `tests/config/`, adding a project, or reading `rhdh.deploy()` behaviour |
| E2E test fix workflow | `docs/agents/knowledge/e2e-fix-workflow.md` | triaging a nightly, working a `[fullsend] E2E:` issue, or deciding whether to skip a test |
| Playwright test authoring | `docs/agents/knowledge/playwright-test-authoring.md` | writing a spec, or reviewing assertions, timeouts, and configurable values in one |
| Scripts and CI | `docs/agents/knowledge/scripts-and-ci.md` | editing `scripts/`, `.github/workflows/`, `.fullsend/`, `smoke-tests-native/`, or interpreting a CI gate |
| PR workflow | `docs/agents/knowledge/pr-workflow.md` | opening a PR, splitting work into issues, interpreting a missing `publish` check, or editing `user-guide/` |

## Other repository documentation

- `README.md` — repo overview, PR workflow, testing procedures
- `user-guide/` — contributor guide (getting started, export tools, ownership, metadata sync, versions, patches) plus catalog index pipeline docs
- `user-guide/troubleshooting-catalog-index.md` — troubleshooting content embedded by `renderCatalogStatus.py` into each generated status page; anchor slugs must stay in sync with `REASON_ANCHORS` in the renderer
- `catalog-entities/extensions/README.md` — Extensions catalog metadata format
- GitHub Wiki — auto-synced from `user-guide/` with `{{AUTO:*}}` placeholders injected from `versions.json`
- [E2E test utils docs](https://github.com/redhat-developer/rhdh-e2e-test-utils/tree/main/docs) — API docs, changelogs, tutorials, and configuration reference for `@red-hat-developer-hub/e2e-test-utils`
