# Getting Started with the Overlay Repository

## What is this Repository?

The `rhdh-plugin-export-overlays` repository serves as a **metadata and automation hub** for managing dynamic plugins for Backstage-based platforms. It acts as a bridge between upstream source code and deployable OCI artifacts.

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│   Source Repos      │     │   Overlay Repo       │     │   OCI Registry      │
│                     │     │                      │     │                     │
│ • backstage/        │────▶│ • Metadata           │────▶│ • Dynamic Plugin    │
│   backstage         │     │ • Patches            │     │   Container Images  │
│ • backstage/        │     │ • Export Config      │     │                     │
│   community-plugins │     │ • Version Tracking   │     │ ghcr.io/redhat-     │
│ • redhat-developer/ │     │                      │     │ developer/...       │
│   rhdh-plugins      │     └──────────────────────┘     └─────────────────────┘
│ • roadiehq/...      │
└─────────────────────┘
```

### What the Overlay Repository Provides

1. **References** plugins from various Backstage ecosystem sources
2. **Tracks** plugin versions for compatibility with target platform releases
3. **Automates** the discovery, packaging, and publishing of dynamic plugins
4. **Customizes** builds via patches and overlays when upstream code needs modification

---

## Repository Structure

```
rhdh-plugin-export-overlays/
├── versions.json              # Target versions (Backstage, Node, CLI)
├── workspace-discovery-include # Auto-discovery scope patterns
├── workspace-discovery-exclude # Workspaces excluded from auto-discovery
├── workspaces/                # One folder per source workspace
│   └── [workspace-name]/
│       ├── source.json        # Source repository reference
│       ├── plugins-list.yaml  # Plugin paths + export args
│       ├── metadata/          # Package entity definitions
│       │   └── *.yaml
│       ├── patches/           # Workspace-level patches (optional)
│       │   └── *.patch
│       ├── plugins/           # Plugin-specific overrides (optional)
│       │   └── [plugin-name]/
│       │       └── overlay/
│       └── smoke-tests/       # Smoke test configuration (optional)
│           ├── test.env
│           └── app-config.test.yaml
└── .github/workflows/         # CI/CD automation
```

---

## Core Concepts

### Workspace

A **workspace** maps to a source repository (or a workspace within a monorepo). Each workspace folder contains all configuration needed to build and publish plugins from that source.

**Example:** `workspaces/backstage/` maps to `https://github.com/backstage/backstage`

### source.json

Defines where to fetch the source code:

```json
{
  "repo": "https://github.com/backstage/backstage",
  "repo-ref": "v1.45.3",
  "repo-flat": true,
  "repo-backstage-version": "1.45.3"
}
```

| Field | Description |
|-------|-------------|
| `repo` | GitHub repository URL |
| `repo-ref` | Git tag or commit SHA |
| `repo-flat` | `true` = plugins at repo root; `false` = plugins in workspace subfolder |
| `repo-backstage-version` | Backstage version used by the source |

### plugins-list.yaml

Lists plugins to export with optional CLI arguments:

```yaml
plugins/catalog-backend-module-github:
plugins/catalog-backend-module-github-org: --embed-package @backstage/plugin-catalog-backend-module-github
plugins/techdocs-backend: --embed-package @backstage/plugin-search-backend-module-techdocs --suppress-native-package cpu-features
#plugins/scaffolder: ==> Included as a static plugin in the host application
```

- **Commented lines** (prefixed with `#`) indicate plugins intentionally excluded
- **CLI arguments** after the colon customize the export behavior (e.g., `--embed-package`, `--shared-package`)

> 📖 **CLI Reference:** For detailed documentation on all export CLI flags (`--embed-package`, `--shared-package`, `--suppress-native-package`, etc.), see the official documentation:
> [Export Derived Dynamic Plugin Package](https://github.com/redhat-developer/rhdh/blob/main/docs/dynamic-plugins/export-derived-package.md)

### Metadata Files

Each plugin requires a `Package` entity definition in `metadata/*.yaml`:

```yaml
apiVersion: extensions.backstage.io/v1alpha1
kind: Package
metadata:
  name: backstage-plugin-catalog-backend-module-github
  namespace: default
  title: "Catalog Backend Module GitHub"
spec:
  packageName: "@backstage/plugin-catalog-backend-module-github"
  version: 0.8.5
  backstage:
    role: backend-plugin-module
    supportedVersions: 1.42.5
  author: Your Organization
  support: community
  lifecycle: active
```

---

## Branching Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Development branch for the **next** platform release |
| `release-x.y` | Long-running branches for specific platform versions (e.g., `release-1.6`) |

> **Rule:** New workspaces are **only** added to `main`. Release branches receive plugin updates only, and have no scheduled automatic updates — they must be triggered manually.

---

## Adding a New Plugin

### Prerequisites

1. Plugin exists in a supported source repository:
   - [`@backstage-community/`](https://github.com/backstage/community-plugins) – Backstage Community Plugins
   - [`@red-hat-developer-hub/`](https://github.com/redhat-developer/rhdh-plugins) – RHDH Plugins
   - [`@roadiehq/`](https://github.com/RoadieHQ/roadie-backstage-plugins) – Roadie Backstage Plugins
2. Plugin is compatible with the target Backstage version

### How Automatic Updates and Discovery Work

The overlay repository runs an automated workflow (`update-plugins-repo-refs.yaml`) **daily on the `main` branch only**. It operates in two complementary modes:

#### 1. Overlay-first package enumeration (all existing workspaces)

The workflow enumerates all existing workspaces directly from the overlay repository, reads each workspace's `source.json`, and scans the source repository tree to discover plugin package names. It then queries npm (`npm view`) for each discovered package to find published versions and check Backstage compatibility. This works for **any workspace regardless of npm scope** — once a workspace is added to the overlay, it will receive automatic version updates. What's avoided is the regexp-based `npm search` step for package name discovery.

#### 2. npm search discovery (new packages)

The workflow also runs `npm search` to discover new packages matching the scope patterns defined in the `workspace-discovery-include` file:

- `@backstage-community/`
- `@red-hat-developer-hub/`
- `@roadiehq/`

When a new release is found that doesn't correspond to an existing workspace, the workflow can propose adding a new workspace (on `main` only, with `allow-workspace-addition` enabled).

#### Where automatic updates work

- **All existing workspaces** are updated automatically regardless of their npm scope. This includes third-party plugins (e.g., `@immobiliarelabs/`, `@pagerduty/`, `@dynatrace/`) as long as they have a workspace in the overlay.
- **Plugins under the auto-discovery scopes** are additionally scanned on npm, enabling discovery of new workspaces.

#### Where automatic discovery does not work

- **Plugins outside the supported scopes** (e.g., `@pagerduty/`, `@dynatrace/`, or any other third-party namespace), which are part of new workspaces, are not discovered automatically. They must be added manually. However, once added, they **are** updated automatically.
- **Workspaces listed in `workspace-discovery-exclude`** are skipped entirely by the scheduled run.
- **Unpublished or pre-release versions** that are not yet on npm will not be discovered.
- **New workspaces** are only proposed when the scheduled workflow has the `allow-workspace-addition` flag enabled; otherwise only existing workspaces receive updates.

### Option 1: Automatic Updates (Preferred, `main` only)

If your workspace already exists in the overlay, the daily automation on `main` will detect new published versions and create a PR automatically. No action is needed on your part. For release branches, use Option 2.

### Option 2: Trigger Workflow Manually

You can trigger the update workflow on demand. The two main inputs serve different purposes:

| Input | Purpose | When to use |
|-------|---------|-------------|
| `workspace-path` | Update a specific existing workspace | Preferred for updates — works for any scope |
| `regexps` | Discover new plugins via npm search | For adding workspaces not yet in the overlay |

> **Important:** When `workspace-path` is set, only that workspace is updated (no npm search runs). When only `regexps` is provided, ALL existing workspaces are updated via overlay-first enumeration, and then npm search runs additionally to discover new workspaces.

#### Update an existing workspace (preferred)

Use `workspace-path` to target a specific workspace. This uses overlay-first enumeration and works for **any workspace regardless of npm scope**. Use `single-branch` to target a specific branch (required for release branches, which have no scheduled updates):

```bash
# Update on main
gh workflow run update-plugins-repo-refs.yaml \
  -f workspace-path="workspaces/your-workspace" \
  -f single-branch="main"

# Update on a release branch
gh workflow run update-plugins-repo-refs.yaml \
  -f workspace-path="workspaces/your-workspace" \
  -f single-branch="release-1.6"
```

This reads the workspace's `source.json`, scans its source repo for plugin package names, then queries npm for published versions and creates/updates PRs for any new compatible versions.

#### Add a new workspace via discovery

Use `regexps` with `allow-workspace-addition` to discover and add a new plugin not yet in the overlay. **Wrapping a value in single quotes** tells the workflow to treat it as an exact (literal) package name rather than a regular expression:

```bash
# Add a specific new plugin by exact name (note the single quotes)
gh workflow run update-plugins-repo-refs.yaml \
  -f regexps="'@backstage-community/plugin-your-plugin'" \
  -f single-branch="main" \
  -f allow-workspace-addition=true

# Discover multiple new packages matching a regex pattern
gh workflow run update-plugins-repo-refs.yaml \
  -f regexps="@backstage-community/plugin-catalog-backend-module-.*" \
  -f single-branch="main" \
  -f allow-workspace-addition=true
```

> **Note:** Running with `regexps` alone (without `workspace-path`) also updates all existing workspaces as a side effect, since overlay-first enumeration always runs first.

### Option 3: Manual PR (Fallback)

Manual PRs should be reserved for situations where automatic discovery does not apply — for example, plugins outside the supported scopes or workspaces that require nonstandard setup. Prefer Options 1 or 2 whenever possible.

1. **Create workspace folder:**

   ```bash
   mkdir -p workspaces/your-plugin
   ```

2. **Add `source.json`:**

   ```json
   {
     "repo": "https://github.com/backstage/community-plugins",
     "repo-ref": "@backstage-community/plugin-your-plugin@1.0.0",
     "repo-flat": false,
     "repo-backstage-version": "1.45.0"
   }
   ```

3. **Add `plugins-list.yaml`:**

   ```yaml
   plugins/your-plugin:
   plugins/your-plugin-backend:
   ```

4. **Add metadata files in `metadata/`:**

   Create one YAML file per plugin following the Package schema.

5. **Open PR against `main`**

---

## Testing Your Plugin

### Trigger a Build

Comment on your PR:

```
/publish
```

This builds and publishes test OCI artifacts tagged as `pr_<number>__<version>`.

### Run Smoke Tests

After `/publish` completes, smoke tests run automatically if:
- PR touches exactly one workspace
- Each plugin has a metadata file

To re-run smoke tests manually:

```
/smoketest
```

Plugin-specific configuration is extracted from `spec.appConfigExamples[0].content` in each plugin's metadata file and placed under `pluginConfig` in the generated config. The optional workspace-level `app-config.test.yaml` is for test-only or shared workspace settings. If a plugin's config references environment variables (e.g., `${API_TOKEN}`), provide them in `workspaces/<ws>/smoke-tests/test.env`.

### Manual Testing

Use the OCI references from the bot's comment to test in your own Backstage instance:

```yaml
# dynamic-plugins.yaml
plugins:
  - package: oci://ghcr.io/redhat-developer/rhdh-plugin-your-plugin:pr_123__1.0.0
    disabled: false
```

---

## Next Steps

- [02 - Export Tools](./02-export-tools.md) – Learn the CLI options
- [03 - Plugin Owner Responsibilities](./03-plugin-owner-responsibilities.md) – Understand your maintenance obligations
