# Using the Dynamic Plugins Export Tools

This guide covers the CLI tools and workflow options for exporting Backstage plugins as dynamic plugins.

---

## Overview

The export process transforms a standard Backstage plugin into an OCI-packaged dynamic plugin that can be loaded at runtime by a Backstage-based host application.

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

<!-- AUTO:VERSIONS_TABLE -->

```bash
# Install/run the CLI
npx {{AUTO:CLI_PACKAGE}}@{{AUTO:CLI_VERSION}} plugin export
```

> 📖 **Version Matrix:** Ensure CLI version matches your target platform version. See [versions.json](../versions.json) for current values.

---

## Export Arguments in plugins-list.yaml

Each plugin entry in `plugins-list.yaml` can include CLI arguments after the colon:

```yaml
plugins/my-plugin:
plugins/my-plugin-backend: --embed-package @backstage/some-dependency --suppress-native-package cpu-features
```

### CLI Arguments Quick Reference

| Argument | Description |
|----------|-------------|
| `--embed-package <pkg>` | Bundle a dependency into the dynamic plugin (for packages not available separately) |
| `--shared-package <pkg>` | Mark package as shared (provided by host at runtime) |
| `--shared-package '!<pkg>'` | Force a `@backstage/` package to be bundled instead of shared |
| `--suppress-native-package <pkg>` | Exclude a native Node.js package from the bundle |

> 📖 **Full CLI Documentation:** For comprehensive details on all export flags, shared vs embedded dependencies, and frontend plugin configuration, see:
> [Export Derived Dynamic Plugin Package](https://github.com/redhat-developer/rhdh/blob/main/docs/dynamic-plugins/export-derived-package.md)

### Common Usage Examples

```yaml
# Embed a dependency that isn't available as a separate dynamic plugin
plugins/catalog-backend-module-github-org: --embed-package @backstage/plugin-catalog-backend-module-github

# Suppress a native module that causes build issues
plugins/techdocs-backend: --embed-package @backstage/plugin-search-backend-module-techdocs --suppress-native-package cpu-features

# Force a @backstage package to be bundled (not shared)
plugins/notifications-backend: --shared-package '!/@backstage/plugin-notifications/' --embed-package @backstage/plugin-notifications-backend
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
| `/smoketest` | Re-run smoke tests (requires prior `/publish`) |

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
└── overlay/
    ├── package.json
    └── src/
        └── api.ts
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

**Symptom:** Workflow logs show an integrity mismatch for a package.

**Cause:** The export process verifies that the `package.json` fields in the checked-out source match the metadata declared in the overlay (e.g., package name, version). A mismatch usually means `source.json:repo-ref` points to a different version than what `metadata/*.yaml:spec.version` declares.

**Solution:**
1. Verify `source.json:repo-ref` points to the correct tag or commit
2. Confirm that `spec.version` and `spec.packageName` in your metadata files match the source `package.json` at that ref
3. If the mismatch is intentional (e.g., a patch changes the version), document the reason in the PR

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
