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
| Plugin Metadata updates | As needed | 🟡 Medium |
| Package Metadata synchronization | Every release | 🔴 High |
| Backstage version updates | When compatibility signals appear | 🔴 High |
| Patch maintenance | As needed | 🟡 Medium |
| Test validation | Every PR | 🔴 High |
| Deprecation communication | As needed | 🟡 Medium |

---

## Core Responsibilities

### 1. Keep Plugin Metadata and Catalog Curation Files Up To Date

**If you have been approved by RHDH PM**, and a RHDHPLAN feature JIRA exists tracking the request, you will need additional metadata stored only in this repo.

These files are only required (if approved by PM) for inclusion in the **Supported Plugins** catalog or the curated **Optional Extras** catalog. If you are not being advertised in one of the catalogs, you can skip this step.

#### Plugin Metadata

Your file should be under [`../catalog-entities/extensions/plugins`](../catalog-entities/extensions/plugins).

It should also be referenced from `catalog-entities/extensions/plugins/all.yaml`.

#### Collections (if applicable)

If PM approval includes grouping your plugin in an Extensions Collection (featured, recommended, cicd, openshift, redhat, etc.), add or update the relevant file under [`../catalog-entities/extensions/collections`](../catalog-entities/extensions/collections) and ensure it is referenced from `catalog-entities/extensions/collections/all.yaml`. Skip this unless PM has approved inclusion in a Collection.

#### Catalog Curation

Additionally, your package(s) must be listed in the package-list file for the **catalog tier** you are targeting. These files select which catalog index includes the package; they do **not** set the support level. Support level (for example `community`, tech-preview, or generally-available) is declared in Plugin and Package metadata YAML and can vary independently of which list a package appears in.

* [`../rhdh-community-packages.txt`](../rhdh-community-packages.txt) — curated **Optional Extras** catalog index tier (Community and Developer Preview)
* [`../rhdh-supported-packages.txt`](../rhdh-supported-packages.txt) — **Supported Plugins** catalog index tier (GA and TP)
* [`../default.packages.yaml`](../default.packages.yaml) — **GA packages only** (`support: generally-available`), with PM approval tracked in an RHDHPLAN feature JIRA. List each package under `enabled:` (usable out of the box) or `disabled:` (requires configuration before use). Do not add non-GA packages to this file.
### 2. Keep Package Metadata Synchronized

Your packages exist in **two places** that must stay in sync:

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

### 3. Keep Backstage Versions Compatible

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

### 4. Maintain Patches and Overlays

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

### 5. Respond to CI Failures

When automated workflows fail on your workspace:

1. **Investigate immediately** – Failures block releases
2. **Check the error type:**
   - Build failure → Fix source or add patch
   - Integrity failure → Sync metadata
   - Test failure → Verify plugin loads correctly
3. **Open a PR** with the fix
4. **Validate** with `/publish` and `/smoketest` commands

---

### 6. Communicate Changes

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
- [ ] Updated support level in metadata: `spec.support.level` in Plugin YAML (`catalog-entities/extensions/plugins/`), and `spec.support` in Package YAML (`workspaces/*/metadata/`)
- [ ] Packages are listed in the correct catalog-tier file (`rhdh-community-packages.txt` for curated Optional Extras, or `rhdh-supported-packages.txt` for Supported Plugins) if PM-approved for catalog inclusion; support level in metadata matches the intended product status
- [ ] If GA and PM-approved, packages are listed in `default.packages.yaml` under `enabled:` or `disabled:` as appropriate; otherwise they must not be listed there
- [ ] If applicable and PM-approved, Collection membership under `catalog-entities/extensions/collections/` is correct

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

Offboarding reverses the PM-gated catalog onboarding steps in [Keep Plugin Metadata and Catalog Curation Files Up To Date](./03-plugin-owner-responsibilities.md#1-keep-plugin-metadata-and-catalog-curation-files-up-to-date), then removes workspace Package and Collection metadata. Confirm the plan with Product Management before changing files.

### 1. Determine the Offboarding Path and Notify Users

Offboarding takes one of two paths:

| Path | Outcome |
|------|---------|
| **Full retirement** | Remove from all catalogs (Supported Plugins and curated Optional Extras) and delete overlay workspace content |
| **Downgrade catalog tier** | Move packages from the Supported Plugins list to the curated Optional Extras list (or remove Optional Extras listing entirely), and update support level in Plugin/Package metadata to match PM’s decision |

Notify customers before deprecation or removal so they have time to adapt:

| Support level | Notice guidance |
|---------------|-----------------|
| GA (supported) | 2 full y-stream releases |
| Technology Preview | 1 full y-stream release recommended (not mandatory) |
| Developer Preview / Community | No SLA; advance notice not required |

For a GA supported plugin, coordinate via a RHDHPLAN Jira so PM can align on timeline, release-note warnings, and which y-stream release will include the change.

During the notice window, mark metadata as deprecated:

```yaml
spec:
  lifecycle: deprecated  # Changed from 'active'
  # Add deprecation notice
```

Document the migration path for users, using an RHDHPLAN feature to track the documentation update (if applicable).

### 2. Overlays Repository Clean-up

Submit a PR that updates or removes the same catalog artifacts added during onboarding ([Keep Plugin Metadata and Catalog Curation Files Up To Date](./03-plugin-owner-responsibilities.md#1-keep-plugin-metadata-and-catalog-curation-files-up-to-date)), plus Plugin, Package, Collection, and workspace files as required.

**Package lists** — remove or relocate entries in:

* `rhdh-supported-packages.txt`
* `rhdh-community-packages.txt`
* `default.packages.yaml` (GA only; remove on retirement or when leaving GA)

**Plugin / collection / package metadata** under `catalog-entities/extensions/` and `workspaces/<name>/metadata/`:

| Path | Full retirement | Downgrade (Supported Plugins → curated Optional Extras) |
|------|-----------------|----------------------------------------------------------|
| Plugin YAML + `plugins/all.yaml` | Delete plugin file and drop from `all.yaml` | Update `spec.support.level` |
| Collection YAML + `collections/all.yaml` | Remove from any collections | Update if collection membership changes |
| Package metadata (`workspaces/*/metadata/*.yaml`) | Delete with the workspace | Update `spec.support` |
| Package lists | Remove from all list files above | Move from `rhdh-supported-packages.txt` to `rhdh-community-packages.txt` (or remove if no longer in curated Optional Extras); remove from `default.packages.yaml` if present |

**Full retirement — delete the workspace folder** (`source.json`, `plugins-list.yaml`, metadata, patches, overlays). Document removal in release notes via the RHDHPLAN feature JIRA.

> **Important:** Simply commenting out entries in `plugins-list.yaml` or removing metadata files while keeping the workspace folder is not sufficient. If the workspace folder and `source.json` remain, automatic discovery will detect the plugin again and propose re-adding it. To permanently remove a plugin, delete the entire workspace directory.

### 3. Catalog Index Sync

After the PR merges, catalog-index pipelines rebuild the indexes. Verify on the [Plugin Catalog Index Status](https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki/Plugin-Catalog-Index-Status) page that the plugin no longer appears as active (retirement) or appears only under the intended tier (downgrade). See [07 - Plugin Catalog Index](./07-plugin-catalog-index.md).

### 4. Supported Midstream Clean-up (Outside This Repo)

If the plugin was built for Technology Preview or GA via the RHDH Konflux tenant, separately disable Tekton pipeline resources and, only when prior releases are EOL, deprecate or unpublish mapped Pyxis images. 

That work lives outside this repo (RHDH plugin-catalog midstream). Contact the COPE team for details, and follow the offboarding guide (`docs/OFFBOARD_KONFLUX.adoc` in the plugin-catalog repo).

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
