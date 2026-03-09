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

### Step 1: Identify the Source Version

Determine the version you want to target:

```bash
# For community-plugins
git ls-remote --tags https://github.com/backstage/community-plugins | grep "plugin-your-plugin"

# For backstage/backstage
git ls-remote --tags https://github.com/backstage/backstage | tail -20
```

### Step 2: Get Source package.json Data

```bash
# Fetch the package.json for your target version
curl -s "https://raw.githubusercontent.com/backstage/community-plugins/@backstage-community/plugin-your-plugin@1.2.3/workspaces/your-workspace/plugins/your-plugin/package.json" | jq '{name, version, backstage}'
```

Example output:

```json
{
  "name": "@backstage-community/plugin-your-plugin",
  "version": "1.2.3",
  "backstage": {
    "role": "backend-plugin",
    "pluginId": "your-plugin",
    "pluginPackages": ["@backstage-community/plugin-your-plugin"]
  }
}
```

### Step 3: Get Backstage Version from Source

```bash
# Get the root package.json to find Backstage version
curl -s "https://raw.githubusercontent.com/backstage/community-plugins/@backstage-community/plugin-your-plugin@1.2.3/package.json" | jq '.dependencies["@backstage/core-plugin-api"] // .devDependencies["@backstage/backend-plugin-api"]'
```

Or check the workspace's `backstage.json`:

```bash
curl -s "https://raw.githubusercontent.com/backstage/community-plugins/@backstage-community/plugin-your-plugin@1.2.3/workspaces/your-workspace/backstage.json" | jq '.version'
```

### Step 4: Update source.json

```json
{
  "repo": "https://github.com/backstage/community-plugins",
  "repo-ref": "@backstage-community/plugin-your-plugin@1.2.3",
  "repo-flat": false,
  "repo-backstage-version": "1.45.0"
}
```

### Step 5: Update Metadata YAML

```yaml
apiVersion: extensions.backstage.io/v1alpha1
kind: Package
metadata:
  name: backstage-community-plugin-your-plugin
  namespace: default
  title: "Your Plugin"
  links:
    - url: https://backstage.io
      title: Homepage
    - url: https://github.com/backstage/community-plugins/issues
      title: Bugs
    - title: Source Code
      url: https://github.com/backstage/community-plugins/tree/main/workspaces/your-workspace/plugins/your-plugin
  annotations:
    backstage.io/source-location: url:https://github.com/backstage/community-plugins/tree/main/workspaces/your-workspace/plugins/your-plugin
spec:
  packageName: "@backstage-community/plugin-your-plugin"  # Must match package.json:name
  version: 1.2.3                                          # Must match package.json:version
  dynamicArtifact: ./dynamic-plugins/dist/backstage-community-plugin-your-plugin-dynamic
  backstage:
    role: backend-plugin                                  # Must match package.json:backstage.role
    supportedVersions: 1.45.0                             # Target Backstage version
  author: Your Organization
  support: community
  lifecycle: active
```

---

## Automated Synchronization

The repository has automated workflows that create PRs for plugin updates.

### Daily Discovery

Runs daily for scopes in `plugins-regexps`:
- `@backstage-community/`
- `@red-hat-developer-hub/`
- `@roadiehq/`

### Manual Trigger

```bash
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

**Cause:** `repo-backstage-version` is higher than target Backstage version in `versions.json`

**Fix:**

1. Find a plugin version compatible with the target Backstage version
2. Update `repo-ref` to that version
3. Update `repo-backstage-version` to match

---

## Integrity Hash Verification

The build process may verify that the source `package.json` matches expectations.

### If Integrity Check Fails

1. **Verify you have the correct ref:**

   ```bash
   git ls-remote --refs https://github.com/[repo] | grep "[your-ref]"
   ```

2. **Check if package.json was modified after tagging** (rare but possible)

3. **If intentional mismatch**, add `--no-integrity-check` to `plugins-list.yaml`:

   ```yaml
   plugins/your-plugin: --no-integrity-check
   ```

   > ⚠️ **Warning:** Only use this when you understand why the mismatch exists and have verified it's safe.

---

## Best Practices

### Do

- ✅ Update metadata immediately when releasing new plugin versions
- ✅ Use exact tags (e.g., `@backstage-community/plugin-x@1.2.3`) not branches
- ✅ Test with `/publish` and `/smoketest` before merging
- ✅ Keep descriptions and links current

### Don't

- ❌ Point `repo-ref` to `main` or `master` branches
- ❌ Use commit SHAs when tags are available
- ❌ Update `spec.version` without updating `repo-ref`
- ❌ Skip integrity checks without documenting why

---

## Next Steps

- [05 - Version Updates](./05-version-updates.md) – Backstage version update procedures
- [06 - Patch Management](./06-patch-management.md) – When source needs modification
