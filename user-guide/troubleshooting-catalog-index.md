## Troubleshooting

Common issues reported on the status page and how to resolve them.

### Backstage version mismatch

**What it means:** The plugin's workspace targets an older Backstage minor version than the one expected by the current branch. The plugin is still included in the catalog index: community (ghcr.io) builds use the workspace's actual Backstage version in the image tag so the image can resolve. The status page flags this as a warning so you can update the workspace when a compatible upstream version is available.

**Common cause:** The upstream plugin repository has not yet released a version compatible with the latest Backstage version, or the workspace's `source.json` `repo-ref` points to an older tag.

**What to do:**

1. Check if a newer tag or commit exists in the upstream repo that supports the required Backstage version.
2. If a workspace update PR exists in the overlays, try commenting `/update-commit` to pull the latest compatible ref.
3. If no compatible version exists upstream, add a `backstage.json` override in the workspace to pin the version.

### Plugin marked as outdated

**What it means:** The exact requested image tag couldn't be found. Instead the latest published tag for the same Backstage/RHDH version line is being used as a fallback. The plugin is still included in the catalog index rather than being removed entirely.

**When this happens:**

- The plugin version in metadata was bumped (e.g., `1.2.0` → `1.3.0`) but the export/publish workflow hasn't run yet for the new plugin version.
- For example:
  - The requested tag is `bs_1.49.4__1.3.0` but only `bs_1.49.4__1.2.0` is published — the older tag is used.
  - The requested tag is `1.11-0.5.2` but only `1.11-0.4.6` and `1.11-0.4.5` are published, then `1.11-0.4.6` is used.

**What to do:**

1. Check whether the publish workflow has run successfully for this plugin.
2. Trigger the export/publish workflow for the plugin to publish the plugin with the updated tag.

If this fallback also fails (no older tag exists), the plugin will instead appear as [Image not found in registry](#image-not-found-in-registry).

### Image not found in registry

**What it means:** No OCI image exists in the container registry for *any* tag matching the plugin's Backstage or RHDH version. The pipeline has no image to use — not even an older one to fall back to (see [Outdated](#plugin-marked-as-outdated)) — so the plugin is excluded from the catalog index entirely.

**When this happens:**

- A plugin is newly onboarded for the specified backstage/RHDH version and the export/publish workflow has never run for it yet.
- For example, a plugin may have been updated from `bs_1.45.3` to `bs_1.49.4` and now expects `bs_1.49.4__1.2.0` and it might not have been published yet as no `bs_1.49.4_*` tags exist yet. Even if a tag like `bs_1.45.3__1.1.1` exists, it will not be considered for the fallback.

**What to do:**

1. Check whether the publish workflow has run successfully for this plugin.
2. Trigger the export/publish workflow for the plugin to publish the plugin with the updated tag.

### Image not found during catalog index generation

> **Note:** This is the same "Image not found" error as above, but detected during the final Catalog Index Generation step rather than during Image Metadata Fetch. It serves as a redundancy check which normally should never happen— if you see this, the image was likely deleted or became unavailable after the metadata fetch stage. Re-run the workflow to see if this persists, as it may be a transient registry issue. The resolution steps are the same as [Image not found in registry](#image-not-found-in-registry).

### Catalog index validation failed

Step 5 of the generation (`scripts/validateCatalogIndex.py`) checks the generated index
against the build metadata that produced it, without touching the network. A plugin whose
only failing stage is **Catalog Index Validation** was built and published fine — what
failed is the index's description of it.

Each finding is written as `[rule-id] message`. Run
`python3 scripts/validateCatalogIndex.py --list-rules` for the full set.

<a id="validation-unresolved-image"></a>

#### unresolved-image

The index ships this package, but its image was never resolved in the registry — the
generator logged "Image not found in registry" and carried on. Anyone who enables the
package fails at pull time.

**Fix:** publish the missing build (see [Image not found in
registry](#image-not-found-in-registry)), or drop the package from the packages file so
the index stops declaring it. Allowlisting is the wrong answer here: it ships a package
that cannot be pulled.

<a id="validation-unknown-image"></a>

#### unknown-image

The index references an image with no `plugin_builds/` entry, so the index and the build
metadata disagree. Usually a stale `catalog-index/` committed without the matching
`plugin_builds/`, or a rename that updated one and not the other.

**Fix:** re-run the generation so both are produced from the same inputs.

<a id="validation-digest-mismatch"></a>

#### digest-mismatch

A digest-pinned reference does not match the digest `plugin_builds/` recorded — the two
files describe different builds of the same plugin.

**Fix:** re-run the generation. If it persists, the index was edited by hand.

<a id="validation-registry-not-allowed"></a>

#### registry-not-allowed

A reference points at a registry this index is not built against — most often a
`ghcr.io` (community) reference leaking into a `quay.io/rhdh` (productized) index.

**Fix:** correct the package's support tier so it resolves against the right registry.
Pass `--community-registry` when the index is meant to carry community-tier packages.

<a id="validation-duplicate-ref"></a>

#### duplicate-ref

The same package reference appears twice in `dynamic-plugins.default.yaml`. The later
entry silently shadows the earlier one's `pluginConfig`, so whichever configuration you
expected may not be the one that applies.

**Fix:** remove the duplicate entry.

<a id="validation-ref-form"></a>

#### ref-form

A `plugins[].package` value is neither an `oci://` reference nor a
`./dynamic-plugins/dist/` path. Generated indexes should never produce this; it means the
file was hand-edited or a generator step wrote a malformed value.

<a id="validation-index-ref-mismatch"></a>

#### index-ref-mismatch

`index.json` and `dynamic-plugins.default.yaml` point at different digests for one
package, so the Extensions UI and the installer would disagree about which build is
current.

**Fix:** re-run the generation.

### Warnings that do not fail the stage

`fallback-tag` means the requested build was missing and an older tag was substituted —
the index ships a stale build. `not-digest-pinned` means a reference carries a tag rather
than a digest, so what it resolves to can change under the index.
`index-missing-entry` means a resolved package is missing from `index.json`, so the
Extensions UI will not list it. None of these fail the plugin, but each is worth chasing
before a release.
