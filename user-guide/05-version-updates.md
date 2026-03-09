# Backstage Version Updates

This guide covers the process of updating Backstage target and minimum versions for your plugins in the overlay repository.

---

## Version Concepts

### Target Backstage Version

The version of Backstage that the target platform is built on. Defined in `versions.json`:

```json
{
  "backstage": "1.45.3",
  "node": "22.19.0",
  "cli": "1.9.1",
  "cliPackage": "@red-hat-developer-hub/cli"
}
```

### Supported Versions (in metadata)

The Backstage version your plugin is compatible with:

```yaml
spec:
  backstage:
    supportedVersions: 1.42.5  # Plugin was built/tested against this version
```

### Source Backstage Version

The Backstage version the source repository uses:

```json
{
  "repo-backstage-version": "1.45.0"
}
```

---

## Version Compatibility Rules

### Rule 1: Source ≤ Target

Your plugin's source Backstage version should be **less than or equal to** the target:

```
source repo-backstage-version ≤ versions.json backstage
            1.45.0            ≤      1.45.3     ✅
```

### Rule 2: Best-Effort Matching

The automation performs best-effort version matching:

| Scenario | Result |
|----------|--------|
| Exact match available | ✅ Used directly |
| Older version available | ⚠️ Used with warning |
| Newer only available | ❌ Blocked |

> **Warning:** Best-effort matches require additional testing. A bot comment will appear on PRs with version mismatches.

---

## Update Cadence

### Monthly Updates (Recommended)

With each Backstage monthly release:

1. **Check** if your plugin has a compatible release
2. **Update** `source.json:repo-ref` to the new version
3. **Update** `source.json:repo-backstage-version`
4. **Update** `metadata/*.yaml:spec.version`
5. **Update** `metadata/*.yaml:spec.backstage.supportedVersions`
6. **Test** with `/publish` and `/smoketest`

### Quarterly Updates (Minimum)

At minimum, update every quarter to ensure:

- Security patches are included
- Breaking changes are addressed before they accumulate
- Plugins remain compatible with platform releases

---

## Step-by-Step Update Process

### Step 1: Check Current Target Version

```bash
cat versions.json | jq '.backstage'
# "1.45.3"
```

### Step 2: Find Compatible Plugin Version

```bash
# For community-plugins, list available versions
git ls-remote --tags https://github.com/backstage/community-plugins \
  | grep "@backstage-community/plugin-your-plugin@" \
  | tail -10
```

For Backstage core plugins, check the [Backstage releases](https://github.com/backstage/backstage/releases).

### Step 3: Verify Backstage Version in Plugin Release

```bash
# Check what Backstage version the plugin release uses
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

### Step 5: Update Metadata Files

For each file in `metadata/*.yaml`:

```yaml
spec:
  version: 1.2.3                    # Match new plugin version
  backstage:
    supportedVersions: 1.45.0       # Match source Backstage version
```

### Step 6: Verify and Test

```bash
# Create PR and trigger build
git checkout -b update-your-plugin-version
git add .
git commit -m "chore: update your-plugin to 1.2.3 (Backstage 1.45.0)"
git push origin update-your-plugin-version

# Open PR, then comment:
# /publish
# /smoketest
```

---

## Handling Major Backstage Updates

When Backstage releases a major version (e.g., 1.x → 2.x):

### Assessment Phase

1. **Review Backstage changelog** for breaking changes
2. **Identify** which breaking changes affect your plugin
3. **Check** if upstream has released a compatible version

### Update Phase

1. **Update** all version references
2. **Create patches** if source hasn't addressed breaking changes
3. **Update** any overlays that depend on changed APIs
4. **Test thoroughly** in a real Backstage instance

### Validation Phase

1. **Run** `/publish` and `/smoketest`
2. **Perform** manual testing if automated tests pass
3. **Document** any migration notes in PR description

---

## Version Fields Reference

### versions.json (Repository-Wide)

```json
{
  "backstage": "1.45.3",        // Target Backstage version for all plugins
  "node": "22.19.0",            // Node.js version for builds
  "cli": "1.9.1",               // CLI tool version
  "cliPackage": "@red-hat-developer-hub/cli"  // CLI package name
}
```

### source.json (Per Workspace)

```json
{
  "repo": "https://github.com/backstage/community-plugins",
  "repo-ref": "@backstage-community/plugin-x@1.2.3",  // Exact version tag
  "repo-flat": false,
  "repo-backstage-version": "1.45.0"  // Backstage version at this ref
}
```

### metadata/*.yaml (Per Plugin)

```yaml
spec:
  version: 1.2.3                    # Plugin version (must match source)
  backstage:
    role: backend-plugin            # Plugin role
    supportedVersions: 1.45.0       # Backstage version compatibility
```

---

## Automated Version Updates

### Daily Workflow

The `update-plugins-repo-refs.yaml` workflow runs daily and:

1. Scans for new plugin releases
2. Checks compatibility with target Backstage version
3. Creates/updates PRs with version bumps

### Manual Trigger

```bash
gh workflow run update-plugins-repo-refs.yaml \
  -f regexps="@backstage-community/plugin-your-plugin" \
  -f single-branch="main"
```

---

## Compatibility Check Badge

The repository displays a compatibility badge:

[![Target Backstage Compatibility Badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fredhat-developer%2Frhdh-plugin-export-overlays%2Frefs%2Fheads%2Fmetadata%2Fincompatible-workspaces.json)](https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki/Backstage-Compatibility-Report)

This badge shows whether mandatory plugins are compatible with the target version.

### When Badge is Red

- Some mandatory plugins are incompatible
- Release branch creation is blocked
- Requires version updates or patches

---

## Troubleshooting Version Issues

### Error: "Backstage version X is higher than target Y"

**Cause:** Plugin requires newer Backstage than the target platform supports

**Solutions:**

1. Find an older plugin version compatible with target
2. Wait for the target platform to update its Backstage version
3. Create a patch to backport compatibility (advanced)

### Error: "No compatible version found"

**Cause:** Plugin hasn't released a version for target Backstage

**Solutions:**

1. Request upstream release for target Backstage version
2. Use commit SHA instead of tag (less preferred)
3. Create a fork with backported changes (last resort)

### Warning: "Best-effort version match"

**Cause:** Exact Backstage version match not available

**Action:**

1. Review the version gap
2. Test thoroughly for compatibility issues
3. Document any known limitations
4. PR will have a bot comment explaining risks

---

## Release Branch Considerations

### main Branch

- Tracks the **next** platform release
- Can accept new workspaces
- Should use latest compatible plugin versions

### release-x.y Branches

- Track specific platform releases
- Only accept updates to **existing** workspaces
- Must maintain compatibility with that release's Backstage version

### Backporting Updates

To update a plugin on a release branch:

```bash
# Checkout release branch
git checkout release-1.6

# Update plugin version (use version compatible with release-1.6's Backstage)
# Edit source.json and metadata files

# Create PR against release branch
git checkout -b backport-plugin-update-1.6
git commit -m "chore: backport plugin-x update to release-1.6"
git push origin backport-plugin-update-1.6
```

---

## Version Update Checklist

```markdown
## Version Update Checklist - [Plugin Name] - [Date]

### Pre-Update
- [ ] Identified target Backstage version from versions.json
- [ ] Found compatible plugin release
- [ ] Verified plugin's Backstage version is ≤ target

### Updates
- [ ] Updated source.json:repo-ref
- [ ] Updated source.json:repo-backstage-version
- [ ] Updated all metadata/*.yaml:spec.version
- [ ] Updated all metadata/*.yaml:spec.backstage.supportedVersions
- [ ] Verified patches still apply (if any exist)

### Validation
- [ ] Created PR
- [ ] /publish completed successfully
- [ ] /smoketest passed
- [ ] Manual testing completed (if best-effort match)
- [ ] PR approved and merged
```

---

## Next Steps

- [06 - Patch Management](./06-patch-management.md) – When version updates require patches
- [03 - Plugin Owner Responsibilities](./03-plugin-owner-responsibilities.md) – Full ownership guide
