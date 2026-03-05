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

## Documentation

- `README.md` — Repo overview, PR workflow, testing procedures
- `user-guide/` — 6-part contributor guide (getting started, export tools, ownership, metadata sync, versions, patches)
- `catalog-entities/extensions/README.md` — Extensions catalog metadata format
- GitHub Wiki — Auto-synced from `user-guide/` with dynamic content injection (`{{AUTO:*}}` placeholders replaced from `versions.json`)
