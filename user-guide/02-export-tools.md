# Using the Dynamic Plugins Export Tools

This guide covers the CLI tools and workflow options for exporting Backstage plugins as dynamic plugins.

---

## Overview

The export process transforms a standard Backstage plugin into an OCI-packaged dynamic plugin that can be loaded at runtime by RHDH.

```
Source Plugin                     Export Process                    OCI Artifact
┌─────────────┐    ┌────────────────────────────────┐    ┌──────────────────────┐
│ package.json│    │ 1. Clone source repo           │    │ Dynamic plugin       │
│ src/        │───▶│ 2. Apply patches               │───▶│ packaged as OCI      │
│ ...         │    │ 3. Install dependencies        │    │ image                │
└─────────────┘    │ 4. Build plugin                │    └──────────────────────┘
                   │ 5. Export as dynamic plugin    │
                   │ 6. Package as OCI container    │
                   └────────────────────────────────┘
```

---

## CLI Package

The export tooling is provided by the `@red-hat-developer-hub/cli` package (specified in `versions.json`):

```json
{
  "backstage": "1.45.3",
  "node": "22.19.0",
  "cli": "1.9.1",
  "cliPackage": "@red-hat-developer-hub/cli"
}
```

---

## Export Arguments in plugins-list.yaml

Each plugin entry in `plugins-list.yaml` can include CLI arguments after the colon:

```yaml
plugins/my-plugin:
plugins/my-plugin-backend: --embed-package @backstage/some-dependency --suppress-native-package cpu-features
```

### Common CLI Arguments

| Argument | Description | When to Use |
|----------|-------------|-------------|
| `--embed-package <pkg>` | Embed a dependency package into the dynamic plugin | When a dependency isn't available as a separate dynamic plugin |
| `--suppress-native-package <pkg>` | Exclude a native Node.js package from the bundle | When a native dependency causes build issues or isn't needed at runtime |
| `--no-integrity-check` | Skip SHA integrity verification | **Use with caution** – only when source metadata differs from overlay |
| `--clean` | Clean build artifacts before export | When troubleshooting stale build issues |

### Example: Embedding Dependencies

Some plugins require dependencies that aren't published as standalone dynamic plugins:

```yaml
# The github-org module needs the base github module embedded
plugins/catalog-backend-module-github-org: --embed-package @backstage/plugin-catalog-backend-module-github

# Notifications backend needs signals-node embedded
plugins/notifications-backend: --embed-package @backstage/plugin-signals-node

# Email module needs notifications-node embedded
plugins/notifications-backend-module-email: --embed-package @backstage/plugin-notifications-node
```

### Example: Suppressing Native Packages

Some native packages cause build issues or aren't needed:

```yaml
# cpu-features is a native module that isn't required at runtime
plugins/techdocs-backend: --embed-package @backstage/plugin-search-backend-module-techdocs --suppress-native-package cpu-features
```

---

## Workflow Inputs

When triggering exports via GitHub Actions, the following inputs are available.

**Workflow:** [`export-workspaces-as-dynamic.yaml`](https://github.com/redhat-developer/rhdh-plugin-export-overlays/actions/workflows/export-workspaces-as-dynamic.yaml)

### Export Workflow Inputs

| Input | Type | Description |
|-------|------|-------------|
| `workspace-path` | string | Relative path to a single workspace (e.g., `workspaces/backstage`) |
| `overlay-branch` | string | Branch of the overlay structure |
| `node-version` | string | Node.js version (defaults to `versions.json`) |
| `janus-cli-version` | string | CLI package version (defaults to `versions.json`) |
| `cli-package` | string | CLI package name (defaults to `versions.json`) |
| `publish-container` | boolean | Whether to publish OCI images |
| `image-repository-prefix` | string | OCI registry prefix |
| `upload-project-on-error` | boolean | Upload workspace on failure for debugging |

### Triggering via GitHub CLI

```bash
# Export all plugins in a workspace
gh workflow run export-workspaces-as-dynamic.yaml \
  -f workspace-path="workspaces/backstage" \
  -f overlay-branch="main" \
  -f publish-container=true

# Export with custom Node version
gh workflow run export-workspaces-as-dynamic.yaml \
  -f workspace-path="workspaces/my-plugin" \
  -f overlay-branch="main" \
  -f node-version="22.19.0" \
  -f publish-container=false
```

---

## PR Commands

When working with Pull Requests, use these comment commands:

| Command | Action |
|---------|--------|
| `/publish` | Build and publish test OCI artifacts |
| `/test` | Re-run integration tests (requires prior `/publish`) |

### What `/publish` Does

1. Checks out the overlay branch
2. Clones the source repository at the specified `repo-ref`
3. Applies any patches from `patches/`
4. Installs dependencies
5. Builds the plugins
6. Exports as dynamic plugins
7. Packages as OCI containers
8. Publishes to `ghcr.io` with tag `pr_<number>__<version>`
9. Posts OCI references as a PR comment

---

## Frontend Plugin Configuration

Frontend plugins often require additional configuration files.

### app-config.dynamic.yaml

Defines route bindings, dynamic routes, and mount points:

```yaml
backstage.plugin-techdocs:
  routeBindings:
    targets:
      - importName: techdocsPlugin
    bindings:
      - bindTarget: catalogPlugin.externalRoutes
        bindMap:
          viewTechDoc: techdocsPlugin.routes.docRoot
  dynamicRoutes:
    - path: /docs
      importName: TechDocsIndexPage
      menuItem:
        icon: docs
        text: Docs
  mountPoints:
    - mountPoint: entity.page.docs/cards
      importName: EntityTechdocsContent
```

**Location:** `workspaces/[workspace]/plugins/[plugin-name]/app-config.dynamic.yaml`

### scalprum-config.json

Defines the Scalprum module configuration:

```json
{
  "name": "backstage.plugin-api-docs-module-protoc-gen-doc",
  "exposedModules": {
    "PluginRoot": "./src/api.ts"
  }
}
```

**Location:** `workspaces/[workspace]/plugins/[plugin-name]/scalprum-config.json`

---

## Overlays vs Patches

| Feature | Overlay | Patch |
|---------|---------|-------|
| **Scope** | Single plugin | Entire workspace |
| **Method** | Replace/add files | Line-by-line changes |
| **Location** | `plugins/[name]/overlay/` | `patches/*.patch` |
| **Use Case** | Add new files, replace implementations | Fix bugs, modify configs |

### When to Use Overlays

- Adding new source files to a plugin
- Replacing entire modules or implementations
- Adding configuration files

**Example structure:**

```
workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/
├── overlay/
│   ├── package.json
│   └── src/
│       └── api.ts
└── scalprum-config.json
```

### When to Use Patches

- Fixing build issues
- Modifying package.json fields
- Small, targeted source changes

See [06 - Patch Management](./06-patch-management.md) for details.

---

## Troubleshooting

### Build Failures

1. **Check workflow logs** – Look for the specific error message
2. **Enable debug upload:**

   ```bash
   gh workflow run export-workspaces-as-dynamic.yaml \
     -f workspace-path="workspaces/failing-plugin" \
     -f upload-project-on-error=true
   ```

3. **Download the artifact** and inspect locally

### Integrity Check Failures

**Symptom:** `Integrity check failed for package X`

**Cause:** The `package.json` in the source repo doesn't match the overlay's expectations.

**Solution:**
1. Verify `source.json` points to the correct `repo-ref`
2. Check if the source `package.json` was modified
3. If intentional, consider using `--no-integrity-check` (document why)

### Missing Dependencies

**Symptom:** `Cannot find module '@backstage/some-package'`

**Solution:** Add `--embed-package @backstage/some-package` to the plugin entry in `plugins-list.yaml`

### Native Module Errors

**Symptom:** Build fails with native compilation errors

**Solution:** Add `--suppress-native-package [package-name]` if the native module isn't needed at runtime

---

## Next Steps

- [03 - Plugin Owner Responsibilities](./03-plugin-owner-responsibilities.md) – Understand maintenance obligations
- [06 - Patch Management](./06-patch-management.md) – Learn to create and maintain patches
