# Plugin Owner Responsibilities

As a plugin owner, you are responsible for maintaining the health and compatibility of your plugin within this dynamic plugins ecosystem. This guide outlines your obligations and best practices.

---

## Ownership Model

### Who is a Plugin Owner?

You are a plugin owner if you:

1. **Maintain** the source plugin in upstream repositories (backstage/backstage, backstage/community-plugins, rhdh-plugins, etc.)
2. **Created** or **modified** the overlay configuration for your plugin
3. Are **assigned** as maintainer by your organization

### Responsibilities Overview

| Area | Frequency | Criticality |
|------|-----------|-------------|
| Metadata synchronization | Every release | 🔴 High |
| Backstage version updates | Monthly/Quarterly | 🔴 High |
| Patch maintenance | As needed | 🟡 Medium |
| Test validation | Every PR | 🔴 High |
| Deprecation communication | As needed | 🟡 Medium |

---

## Core Responsibilities

### 1. Keep Metadata Synchronized

Your plugin exists in **two places** that must stay in sync:

| Location | Files | Owner Updates |
|----------|-------|---------------|
| **Source Repo** | `package.json`, `src/` | When you release new versions |
| **Overlay Repo** | `source.json`, `metadata/*.yaml` | When source changes |

**What must match:**

| Field | Source Location | Overlay Location |
|-------|-----------------|------------------|
| Version | `package.json:version` | `metadata/*.yaml:spec.version` |
| Package name | `package.json:name` | `metadata/*.yaml:spec.packageName` |
| Backstage deps | `package.json:dependencies` | `metadata/*.yaml:spec.backstage.supportedVersions` |
| Description | `package.json:description` | `metadata/*.yaml:metadata.title` |

> ⚠️ **Warning:** Metadata drift causes build failures, incorrect catalog entries, and compatibility issues.

See [04 - Metadata Synchronization](./04-metadata-synchronization.md) for detailed procedures.

---

### 2. Update Backstage Versions Regularly

The target platform tracks Backstage releases. Your plugin must remain compatible.

**Minimum cadence:**

| Update Type | Frequency | Action Required |
|-------------|-----------|-----------------|
| Target version | Monthly | Verify compatibility with new Backstage release |
| Minimum version | Quarterly | Update `supportedVersions` in metadata |
| Major version | As released | Full compatibility testing |

**Process:**

1. Check the target Backstage version in `versions.json`
2. Verify your plugin works with that version
3. Update `repo-backstage-version` in `source.json`
4. Update `supportedVersions` in metadata files

See [05 - Version Updates](./05-version-updates.md) for detailed procedures.

---

### 3. Maintain Patches and Overlays

If your plugin requires patches:

| Task | When | Action |
|------|------|--------|
| **Verify patches apply** | Every source update | Ensure patches don't conflict |
| **Re-roll patches** | When context changes | Update line numbers/context |
| **Remove patches** | When fix is upstream | Delete obsolete patches |
| **Document patches** | Always | Explain why each patch exists |

> ⚠️ **Warning:** Stale patches cause silent failures or unexpected behavior.

See [06 - Patch Management](./06-patch-management.md) for detailed procedures.

---

### 4. Respond to CI Failures

When automated workflows fail on your workspace:

1. **Investigate immediately** – Failures block releases
2. **Check the error type:**
   - Build failure → Fix source or add patch
   - Integrity failure → Sync metadata
   - Test failure → Verify plugin loads correctly
3. **Open a PR** with the fix
4. **Validate** with `/publish` and `/smoketest` commands

---

### 5. Communicate Changes

Notify downstream users when:

| Change | Communication |
|--------|---------------|
| Breaking API changes | Update metadata, document migration |
| Deprecation | Add deprecation notice, timeline |
| New dependencies | Update `plugins-list.yaml` with embed args |
| Configuration changes | Update `appConfigExamples` in metadata |

---

## Monthly Maintenance Checklist

Use this checklist each month:

```markdown
## Monthly Plugin Maintenance - [Plugin Name] - [Month/Year]

### Version Check
- [ ] Verified plugin compatibility with current target Backstage version
- [ ] Updated `source.json:repo-backstage-version` if needed
- [ ] Updated `metadata/*.yaml:spec.backstage.supportedVersions` if needed

### Metadata Check
- [ ] Verified `spec.version` matches source `package.json:version`
- [ ] Verified `spec.packageName` matches source `package.json:name`
- [ ] Reviewed and updated `appConfigExamples` if configuration changed

### Patch Check
- [ ] Verified all patches apply cleanly to current source
- [ ] Removed any patches that are now in upstream
- [ ] Documented any new patches required

### Test Validation
- [ ] PR created with updates
- [ ] `/publish` completed successfully
- [ ] `/smoketest` passed or manual testing completed
- [ ] PR merged
```

---

## Quarterly Maintenance Checklist

Use this checklist each quarter:

```markdown
## Quarterly Plugin Maintenance - [Plugin Name] - [Quarter/Year]

### Compatibility Review
- [ ] Reviewed Backstage changelog for breaking changes
- [ ] Tested plugin with minimum supported platform version
- [ ] Tested plugin with current platform version
- [ ] Updated `supportedVersions` range

### Dependency Audit
- [ ] Reviewed embedded packages (--embed-package)
- [ ] Checked for security advisories in dependencies
- [ ] Updated suppressed native packages if needed

### Documentation Review
- [ ] Updated metadata links (source, issues, docs)
- [ ] Reviewed and updated description/title
- [ ] Checked `appConfigExamples` accuracy

### Cleanup
- [ ] Removed obsolete patches
- [ ] Removed obsolete overlay files
- [ ] Archived any deprecated plugin variants
```

---

## Handling Plugin Deprecation

When deprecating a plugin:

### 1. Mark as Deprecated in Metadata

```yaml
spec:
  lifecycle: deprecated  # Changed from 'active'
  # Add deprecation notice
```

### 2. Comment Out in plugins-list.yaml

```yaml
# plugins/my-deprecated-plugin: ==> Deprecated: Use new-plugin instead
```

### 3. Communicate to Users

- Open an issue documenting the deprecation
- Provide migration path to replacement plugin
- Set a timeline for removal (typically 2 release cycles)

### 4. Remove After Grace Period

- Delete metadata files
- Remove from `plugins-list.yaml`
- Document removal in release notes

---

## Getting Help

| Issue | Where to Go |
|-------|-------------|
| Build failures | Check workflow logs, open issue |
| Patch conflicts | See [06 - Patch Management](./06-patch-management.md) |
| Compatibility questions | Check [Backstage Compatibility wiki](https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki) |
| Process questions | Open a discussion or issue |

---

## Next Steps

- [04 - Metadata Synchronization](./04-metadata-synchronization.md) – Detailed sync procedures
- [05 - Version Updates](./05-version-updates.md) – Version update guide
- [06 - Patch Management](./06-patch-management.md) – Patch maintenance
