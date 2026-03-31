# Metadata Synchronization

This guide covers the process of keeping your plugin metadata synchronized between the source repository and the overlay repository.

---

## Why Synchronization Matters

The overlay repository doesn't store your plugin's source code—it stores **references** and **metadata**. When these drift from the actual source, problems occur:

| Drift Type | Symptom | Impact |
|------------|---------|--------|
| Version mismatch | Build uses wrong tag | Old bugs, missing features |
| Backstage version wrong | Compatibility check fails | PR blocked, build failures |
| Package name changed | OCI tagging fails | Plugin not found at runtime |
| Description outdated | Catalog shows wrong info | User confusion |

---

## What Must Be Synchronized

### source.json ↔ Source Repository

| source.json Field | Must Match |
|-------------------|------------|
| `repo` | Repository URL where plugin lives |
| `repo-ref` | Exact tag or commit SHA for the version you want |
| `repo-backstage-version` | Backstage version declared in source's root `package.json` |

### metadata/*.yaml ↔ Source package.json

| Metadata Field | Source Field |
|----------------|--------------|
| `spec.packageName` | `package.json:name` |
| `spec.version` | `package.json:version` |
| `spec.backstage.role` | Derived from plugin type |
| `spec.backstage.supportedVersions` | Backstage deps in `package.json` |

---

## Step-by-Step Synchronization

> **Note:** For most plugins under supported scopes, the automated discovery workflow handles synchronization automatically. The manual steps below are for cases where automation does not apply or when you need to verify/override what automation produced.

### Step 1: Identify the Source Version

How you identify the correct `repo-ref` depends on the source repository model:

**Single-plugin repositories** (e.g., `backstage/backstage`) use version tags:

```bash
git ls-remote --tags https://github.com/backstage/backstage | tail -20
# repo-ref example: "v1.45.3"
```

**Multi-plugin monorepos** (e.g., `backstage/community-plugins`, `redhat-developer/rhdh-plugins`) typically use per-package tags. However, these tags point to individual plugin releases and there is no common workspace-level tag. When a workspace contains multiple plugins that may release independently, the preferred reference is often a **commit SHA** rather than a single package tag:

```bash
# Per-package tag (works when the workspace has a single plugin or all plugins share the same tag)
git ls-remote --tags https://github.com/backstage/community-plugins | grep "plugin-your-plugin"
# repo-ref example: "@backstage-community/plugin-your-plugin@1.2.3"

# Commit SHA (preferred for multi-plugin workspaces where plugins release independently)
# Use the commit that contains the versions you need for all plugins in the workspace
# repo-ref example: "abc123def456..."
```

### Step 2: Get Source package.json Data

```bash
# Using a tag
curl -s "https://raw.githubusercontent.com/backstage/community-plugins/@backstage-community/plugin-your-plugin@1.2.3/workspaces/your-workspace/plugins/your-plugin/package.json" | jq '{name, version, backstage}'

# Using a commit SHA
curl -s "https://raw.githubusercontent.com/backstage/community-plugins/abc123def456/workspaces/your-workspace/plugins/your-plugin/package.json" | jq '{name, version, backstage}'
```

### Step 3: Get Backstage Version from Source

Check the workspace's `backstage.json`:

```bash
curl -s "https://raw.githubusercontent.com/backstage/community-plugins/[ref]/workspaces/your-workspace/backstage.json" | jq '.version'
```

### Step 4: Update source.json

**Tag-based reference** (single-plugin workspace or shared tag):

```json
{
  "repo": "https://github.com/backstage/community-plugins",
  "repo-ref": "@backstage-community/plugin-your-plugin@1.2.3",
  "repo-flat": false,
  "repo-backstage-version": "1.45.0"
}
```

**Commit-based reference** (multi-plugin workspace):

```json
{
  "repo": "https://github.com/redhat-developer/rhdh-plugins",
  "repo-ref": "abc123def456789...",
  "repo-flat": false,
  "repo-backstage-version": "1.45.2"
}
```

### Step 5: Update Metadata YAML

Update each file in `metadata/*.yaml` to match the source `package.json` at the ref you chose:

```yaml
spec:
  packageName: "@backstage-community/plugin-your-plugin"  # Must match package.json:name
  version: 1.2.3                                          # Must match package.json:version
  backstage:
    role: backend-plugin                                  # Must match package.json:backstage.role
    supportedVersions: 1.45.0                             # Backstage version from backstage.json
```

---

## Automated Synchronization

The repository has automated workflows that create PRs for plugin updates.

### Daily Discovery

Runs twice daily for scopes defined in `workspace-discovery-include`:
- `@backstage-community/`
- `@red-hat-developer-hub/`
- `@roadiehq/`

Workspaces matching patterns in `workspace-discovery-exclude` are skipped.

### Manual Trigger

You can trigger the discovery workflow on demand. Wrap the value in single quotes to target an exact package name rather than a regex pattern (see [Option 2: Trigger Workflow Manually](./01-getting-started.md#option-2-trigger-workflow-manually) for a full explanation of quoting behavior).

```bash
# Exact package name (single quotes = literal match)
gh workflow run update-plugins-repo-refs.yaml \
  -f regexps="'@backstage-community/plugin-your-plugin'" \
  -f single-branch="main"

# Regex pattern (no quotes = pattern match)
gh workflow run update-plugins-repo-refs.yaml \
  -f regexps="@backstage-community/plugin-your-plugin" \
  -f single-branch="main"
```

### What Automation Updates

| File | Fields Updated |
|------|----------------|
| `source.json` | `repo-ref`, `repo-backstage-version` |
| `metadata/*.yaml` | `spec.version`, `spec.backstage.supportedVersions` |

> **Note:** Automation does not update descriptions, links, or custom fields.

---

## Validation Checklist

Before submitting your PR, verify:

```markdown
## Sync Validation Checklist

### source.json
- [ ] `repo-ref` points to a valid tag or commit
- [ ] Tag/commit actually contains the plugin
- [ ] `repo-backstage-version` matches source Backstage version

### metadata/*.yaml (for each plugin)
- [ ] `spec.packageName` exactly matches source `package.json:name`
- [ ] `spec.version` exactly matches source `package.json:version`
- [ ] `spec.backstage.role` matches (frontend-plugin, backend-plugin, etc.)
- [ ] `spec.backstage.supportedVersions` is reasonable for source

### plugins-list.yaml
- [ ] Plugin path is correct for the source structure
- [ ] Any `--embed-package` args reference valid packages
```

---

## Common Synchronization Errors

### Error: "Package version mismatch"

**Cause:** `spec.version` doesn't match source `package.json:version`

**Fix:**

```bash
# Get correct version
curl -s "https://raw.githubusercontent.com/[repo]/[ref]/path/to/package.json" | jq '.version'
# Update metadata file
```

### Error: "Cannot find plugin at path"

**Cause:** Plugin path in `plugins-list.yaml` doesn't exist in source at `repo-ref`

**Fix:**

1. Verify the plugin exists at the ref:

   ```bash
   git ls-tree -r --name-only [ref] | grep "plugin-name"
   ```

2. Update path or `repo-ref` accordingly

### Error: "Backstage compatibility check failed"

**Cause:** The `repo-backstage-version` declared in `source.json` is higher than the target Backstage version in `versions.json`. The automated workflow rejects updates where the source was built against a newer Backstage than the platform currently targets.

**Fix:**

1. Find a plugin version whose source Backstage version is less than or equal to the target version in `versions.json`
2. Update `repo-ref` to point to that version
3. Update `repo-backstage-version` to match the source's actual Backstage version

> This check runs during the discovery/update workflow, not during the export build itself. It prevents the overlay from referencing a plugin version that is known to be incompatible with the target platform.

---

## Integrity Verification

During the export build, the process verifies that the source `package.json` fields (name, version) match the metadata declared in the overlay. This catches cases where `source.json:repo-ref` and `metadata/*.yaml:spec.version` have drifted apart.

### If Integrity Verification Fails

1. **Verify you have the correct ref:**

   ```bash
   git ls-remote --refs https://github.com/[repo] | grep "[your-ref]"
   ```

2. **Compare the source version with your metadata:**
   - Check `package.json:version` at the ref you are targeting
   - Confirm it matches `spec.version` in your metadata YAML

3. **If the mismatch is intentional** (e.g., a patch modifies the version), document the reason in your PR description

---

## Best Practices

### Do

- ✅ Update metadata immediately when releasing new plugin versions
- ✅ Use exact tags (e.g., `@backstage-community/plugin-x@1.2.3`) not branches
- ✅ Test with `/publish` and `/smoketest` before merging
- ✅ Keep descriptions and links current

### Don't

- ❌ Point `repo-ref` to `main` or `master` branches
- ❌ Update `spec.version` without updating `repo-ref`
- ❌ Use a per-package tag as `repo-ref` when the workspace contains other plugins at different versions (use a commit SHA instead)

---

## Next Steps

- [05 - Version Updates](./05-version-updates.md) – Backstage version update procedures
- [06 - Patch Management](./06-patch-management.md) – When source needs modification
