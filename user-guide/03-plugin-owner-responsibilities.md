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
| Backstage version updates | When compatibility signals appear | 🔴 High |
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

### 2. Keep Backstage Versions Compatible

The target platform tracks Backstage releases. Your plugin must remain compatible with the version declared in `versions.json`.

Rather than following a fixed calendar cadence, watch for concrete signals that an update is needed:

- The [Backstage Compatibility Report](https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki/Backstage-Compatibility-Report) shows your workspace as incompatible
- A new platform release branch is being created and your plugin blocks it
- Automated discovery PRs fail the compatibility check for your workspace
- Upstream has released a version built against the current target Backstage version

**When any of these signals appear:**

1. Check the target Backstage version in `versions.json`
2. Find a plugin release compatible with that version
3. Update `repo-ref` and `repo-backstage-version` in `source.json`
4. Update `supportedVersions` in metadata files
5. Test with `/publish` and `/smoketest`, and run workspace E2E validation when available for that workspace

See [01 - Getting Started: Testing Your Plugin](./01-getting-started.md#testing-your-plugin) for test workflow details.

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

## Maintenance Checklist

Use this checklist when updating your plugin (triggered by a compatibility signal, a new upstream release, or a platform version bump):

```markdown
## Plugin Maintenance - [Plugin Name] - [Date]

### Version Check
- [ ] Checked target Backstage version in versions.json
- [ ] Found a plugin release compatible with the target version
- [ ] Updated `source.json:repo-ref` and `repo-backstage-version`
- [ ] Updated `metadata/*.yaml:spec.version` and `spec.backstage.supportedVersions`

### Metadata Check
- [ ] Verified `spec.packageName` matches source `package.json:name`
- [ ] Reviewed and updated `appConfigExamples` if configuration changed
- [ ] Updated metadata links (source, issues, docs) if needed

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

## Handling Plugin Deprecation

When deprecating a plugin:

### 1. Mark as Deprecated in Metadata

```yaml
spec:
  lifecycle: deprecated  # Changed from 'active'
  # Add deprecation notice
```

### 2. Communicate to Users

- Open an issue documenting the deprecation
- Provide migration path to replacement plugin
- Set a timeline for removal (typically 2 release cycles)

### 3. Remove After Grace Period

When the grace period ends, remove the workspace entirely:

- Delete the workspace folder (including `source.json`, `plugins-list.yaml`, metadata files, and any patches)
- Document removal in release notes

> **Important:** Simply commenting out entries in `plugins-list.yaml` or removing metadata files while keeping the workspace folder is not sufficient. If the workspace folder and `source.json` remain, automatic discovery will detect the plugin again and propose re-adding it. To permanently remove a plugin, delete the entire workspace directory.

---

## Getting Help

| Issue | Where to Go |
|-------|-------------|
| Build failures | Check workflow logs, open issue |
| Patch conflicts | See [06 - Patch Management](./06-patch-management.md) |
| Compatibility questions | Check the [Backstage Compatibility Report](https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki/Backstage-Compatibility-Report) |
| Process questions | Open a discussion or issue |

---

## Next Steps

- [04 - Metadata Synchronization](./04-metadata-synchronization.md) – Detailed sync procedures
- [05 - Version Updates](./05-version-updates.md) – Version update guide
- [06 - Patch Management](./06-patch-management.md) – Patch maintenance
