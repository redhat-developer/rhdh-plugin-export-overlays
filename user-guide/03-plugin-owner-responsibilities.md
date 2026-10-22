# Plugin Owner Responsibilities

As a plugin owner, you are responsible for maintaining the health and compatibility of your plugin within this dynamic plugins ecosystem. This guide outlines your obligations and best practices.

---

## Ownership Model

### Two ways a plugin can appear in this repository

Not every plugin is built and exported through overlays. Ownership responsibilities depend on which model applies:

| Model | What lives in overlays | OCI build / publish | Typical when |
|-------|------------------------|---------------------|--------------|
| **A. Source + overlay build** | `workspaces/<name>/` (`source.json`, `plugins-list.yaml`, `metadata/*.yaml` Package entities, optional patches). Overlay **export** only needs `workspaces/`. A Plugin entity under `catalog-entities/extensions/plugins/` is the Extensions/marketplace listing (usually with `packages:` links to Package **entity names**). OCI refs live on Package `spec.dynamicArtifact`, not on the Plugin YAML. | Built and published by overlay CI / midstream export | Source is on a **public** GitHub repo that CI can clone (`https://github.com/...` only today) |
| **B. Catalog metadata only** | Plugin entity YAML under `catalog-entities/extensions/plugins/` only — **no** `workspaces/` export config and **no** workspace Package metadata | Built and published **outside** this repository (owner’s own pipeline / registry) | Source or build stays outside overlays (including private source trees); overlays only need **listing** metadata in the catalog index |

> **Important:** Overlay export does **not** clone private source repositories. If the plugin cannot be built from a public GitHub URL via `source.json`, use **Model B** and keep OCI production in your own pipeline.
>
> **Model B is listing-only in the catalog index today.** The catalog-index pipeline resolves installable Package entities (and OCI) from `workspaces/*/metadata/` and package lists — see [07 - Plugin Catalog Index](./07-plugin-catalog-index.md). Catalog-only Plugin YAML contributes marketplace listing metadata (title, description, support level, links, install/config guidance). Omitting `packages:` is normal for listing-only / external-install docs. There is **no** supported path today to publish installable Package entities for an external OCI image without a Model A `workspaces/` entry.

Model A is the default path described in the rest of this guide (metadata sync, version bumps, patches, `/publish`, `/smoketest`). Model B owners skip workspace/export maintenance and keep catalog Plugin YAML accurate (title, description, support level, links, configuration guidance), knowing the index entry is listing-oriented unless/until the plugin moves to Model A.

### Who is a Plugin Owner?

You are a plugin owner if you:

1. **Maintain** the plugin source (in a public GitHub repo such as backstage/backstage, backstage/community-plugins, redhat-developer/rhdh-plugins, or another public plugin repo) **and/or** maintain its catalog Plugin YAML in this repository
2. **Created** or **modified** the overlay workspace configuration **or** the catalog-only Plugin entity for your plugin
3. Are **assigned** as maintainer by your organization

### Responsibilities Overview

| Area | Applies to | Frequency | Criticality |
|------|------------|-----------|-------------|
| Package metadata synchronization (source ↔ workspace) | Model A | Every release | 🔴 High |
| Catalog Plugin YAML accuracy | Model A and B | When listing/docs/support info changes | 🔴 High |
| Meeting the quality bar for your declared support level | Model A and B | Every release | 🔴 High |
| PM-gated catalog curation (package lists, collections, `default.packages.yaml`) | Model A and B (when approved for curated catalogs) | As needed | 🟡 Medium |
| Backstage version updates | Model A (Model B: keep external build compatible) | When compatibility signals appear | 🔴 High |
| Patch maintenance | Model A | As needed | 🟡 Medium |
| Test validation (`/publish`, `/smoketest`) | Model A | Every PR | 🔴 High |
| Deprecation communication | Model A and B | As needed | 🟡 Medium |

---

## Core Responsibilities

> Workspace/export subsections (**2**–**4**) focus on **Model A** (source + overlay build). For **Model B**, always maintain the Plugin YAML (and `plugins/all.yaml`); do not add a `workspaces/` entry unless you are moving the plugin onto the overlay export path with a public cloneable source. PM-gated curation bullets below (collections, package lists, `default.packages.yaml`) apply only when approved for curated catalogs.

### 1. Keep Plugin Metadata and Catalog Curation Files Up To Date

This section covers what **always** applies and what applies only after **RHDH PM approval** for a curated catalog tier.

#### Plugin Metadata (always for Model B; for Model A when advertising in Extensions)

Your file should be under [`../catalog-entities/extensions/plugins`](../catalog-entities/extensions/plugins).

It should also be referenced from `catalog-entities/extensions/plugins/all.yaml`.

For **Model B**, this Plugin YAML is the primary overlay-repo deliverable and is **always** required (even when you are not PM-approved for Supported Plugins / Optional Extras). Keep title, description, support level, links, and configuration / external-install guidance accurate. Expect a **listing-only** index contribution today — see [07 - Plugin Catalog Index](./07-plugin-catalog-index.md).

For **Model A**, overlay export itself only needs `workspaces/`. Add or update Plugin YAML when the plugin should appear in Extensions / marketplace listings (usually with `packages:` links to Package entity names from `workspaces/*/metadata/`).

#### Collections and package lists (only if PM-approved)

**If you have been approved by RHDH PM**, and a RHDHPLAN feature JIRA exists tracking the request, you will need additional curation metadata stored only in this repo for inclusion in the **Supported Plugins** catalog or the curated **Optional Extras** catalog.

If you are **not** PM-approved for those curated tiers, **skip the rest of this subsection** (collections, package-list files, `default.packages.yaml`). Model B owners still must not skip Plugin YAML / `all.yaml` above.

##### Collections (if applicable)

If PM approval includes grouping your plugin in an Extensions Collection (featured, recommended, cicd, openshift, redhat, etc.), add or update the relevant file under [`../catalog-entities/extensions/collections`](../catalog-entities/extensions/collections) and ensure it is referenced from `catalog-entities/extensions/collections/all.yaml`. Skip this unless PM has approved inclusion in a Collection.

##### Catalog Curation (package lists)

Package-list files select packages that the catalog-index pipeline resolves from **workspace** Package metadata (`workspaces/*/metadata/`). They do **not** set support level (support level lives in Plugin/Package YAML).

* [`../rhdh-community-packages.txt`](../rhdh-community-packages.txt) — curated **Optional Extras** catalog index tier (Community and Developer Preview)
* [`../rhdh-supported-packages.txt`](../rhdh-supported-packages.txt) — **Supported Plugins** catalog index tier (GA and TP)
* [`../default.packages.yaml`](../default.packages.yaml) — **GA packages only** (`support: generally-available`), with PM approval tracked in an RHDHPLAN feature JIRA. List each package under `enabled:` (usable out of the box) or `disabled:` (requires configuration before use). Do not add non-GA packages to this file.

**Model B (listing-only):** skip package-list / `default.packages.yaml` maintenance unless you also have Package entities (Model A or a rare hybrid). Listing-only plugins with no `packages:` and no `workspaces/*/metadata/` have nothing for those lists to select.

#### Quality Expectations for the Level You Declare

PM approval decides **whether** your plugin is listed and in which catalog tier. It does not decide whether the plugin meets the bar for the support level you declare — that is a separate expectation, and it is the same for every owner, inside or outside Red Hat.

The requirements per support level are defined in [RHDH Plugin Quality Requirements by Support Level](https://github.com/redhat-developer/rhdh/blob/main/docs/testing-requirements-matrix.md), in the `rhdh` repository. In short:

| Declared level | What is expected |
|----------------|------------------|
| **Generally Available** | Unit and integration coverage floors, E2E smoke tests required for release, blocking security scan, 2 review approvals |
| **Technology Preview** | Coverage recommended, not enforced — but the full GA bar must be met before promotion to GA |
| **Community** | The published artifact installs and boots, and `appConfigExamples` are valid. Both are already checked automatically |
| **Developer Preview** | Nothing required |

Most of this is measured for you: the export, smoke, `appConfigExamples` and Backstage compatibility workflows in this repository run against every listed plugin. Coverage and E2E are the exception — they are only measured when your workspace carries `e2e-tests/` and `coverage-anchors/`. Without those two directories, a coverage or E2E claim for a GA or TP plugin is taken on your word rather than measured. See [Getting a Plugin Listed in the Extensions Catalog](https://github.com/redhat-developer/rhdh/blob/main/docs/testing-requirements-matrix.md#getting-a-plugin-listed-in-the-extensions-catalog) for what counts as evidence.

### 2. Keep Package Metadata Synchronized

For **Model A**, your packages exist in **two places** that must stay in sync:

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

### Model A (source + overlay build)

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
- [ ] Updated catalog Plugin YAML under `catalog-entities/extensions/plugins/` if listing text changed

### Patch Check
- [ ] Verified all patches apply cleanly to current source
- [ ] Removed any patches that are now in upstream
- [ ] Documented any new patches required

### Test Validation
- [ ] PR created with updates
- [ ] `/publish` completed successfully
- [ ] `/smoketest` passed or manual testing completed
- [ ] Plugin still meets the quality expectations for its declared support level (see [Quality Expectations for the Level You Declare](./03-plugin-owner-responsibilities.md#quality-expectations-for-the-level-you-declare))
- [ ] PR merged
```

### Model B (catalog metadata only)

Listing-only in the catalog index today ([07 - Plugin Catalog Index](./07-plugin-catalog-index.md)). Installable Package/OCI resolution still requires Model A workspace Package metadata.

```markdown
## Catalog-only Plugin Maintenance - [Plugin Name] - [Date]

- [ ] Confirmed OCI images are still built and published by the external pipeline (install is outside overlays)
- [ ] Updated `catalog-entities/extensions/plugins/<plugin>.yaml` (title, description, support level, links, tags)
- [ ] Referenced the Plugin YAML from `catalog-entities/extensions/plugins/all.yaml`
- [ ] Reviewed configuration / external-install guidance in the Plugin YAML against current external docs
- [ ] Confirmed listing-only expectation (no workspace Package entities; omit `packages:` unless documenting links that already exist elsewhere)
- [ ] If PM-approved for curated catalogs **and** Package entities exist (Model A / hybrid only): package-list / collection / `default.packages.yaml` entries are still correct — otherwise skip
- [ ] Opened PR against this repository; no `workspaces/` changes required
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

Apply this on workspace Package metadata (**Model A**) and/or the catalog Plugin entity under `catalog-entities/extensions/plugins/` (**Model A and B**).

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
| Package metadata (`workspaces/*/metadata/*.yaml`) | Delete with the workspace (**Model A**) | Update `spec.support` (**Model A**) |
| Package lists | Remove from all list files above | Move from `rhdh-supported-packages.txt` to `rhdh-community-packages.txt` (or remove if no longer in curated Optional Extras); remove from `default.packages.yaml` if present |

**Full retirement:**

- **Model A:** Delete the workspace folder (`source.json`, `plugins-list.yaml`, metadata, patches, overlays), and remove or update the related catalog Plugin YAML
- **Model B:** Remove or update the catalog Plugin YAML under `catalog-entities/extensions/plugins/` (no workspace to delete)

Document removal in release notes via the RHDHPLAN feature JIRA.

> **Important (Model A):** Simply commenting out entries in `plugins-list.yaml` or removing metadata files while keeping the workspace folder is not sufficient. If the workspace folder and `source.json` remain, automatic discovery will detect the plugin again and propose re-adding it. To permanently remove a plugin, delete the entire workspace directory.

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
