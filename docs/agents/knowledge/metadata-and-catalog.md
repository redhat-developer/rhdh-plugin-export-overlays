# Metadata and Catalog

The two entity layers — Package metadata in `workspaces/*/metadata/` and Plugin entities in `catalog-entities/extensions/` — and the rules that keep them valid, mutually consistent, and visible in the Extensions UI. The version values these files must carry are in [workspace-maintenance.md](./workspace-maintenance.md); which packages get metadata at all is in [dynamic-plugins.md](./dynamic-plugins.md#which-packages-get-metadata).

## Metadata validation in `/publish`

`/publish` includes a metadata validation step comparing each built plugin's real version and Backstage compatibility version against the corresponding metadata fields:

- **`spec.version`** — must equal the plugin version built from the `source.json` source ref.
- **`spec.dynamicArtifact`** OCI tag — must contain the right plugin and Backstage versions, for example `bs_1.52.0__0.12.0`.
- **`spec.backstage.supportedVersions`** — must equal the Backstage compatibility version.

A mismatch fails the publish. This is a hard gate, not a warning: the workflow posts the validation errors as a PR comment and blocks until the files are corrected.

When reviewing a workspace update — where `source.json` moves to a new ref — verify **all** metadata files in the workspace moved together. A workspace can hold several, such as a main plugin plus a theme variant. Any file still carrying the old version or OCI tag is a blocking finding. In particular, every package in `plugins-list.yaml` needs its own current `metadata/*.yaml`; stale metadata for any exported package is a hard pipeline error.

## `appConfigExamples`

Package metadata carries `spec.appConfigExamples`, the deployment configuration merged into `app-config.dynamic-plugins.yaml` at deploy time. Several plugins in one workspace contribute to that merge, so one malformed example can poison the whole deployment.

### Matching the plugin's own config schema

Plugins in the same workspace often share a config namespace — `catalog.providers`, for instance — while consuming it with different shapes: flat strings versus nested objects, different required fields. When adding a plugin to a workspace that already has others, the new file's `appConfigExamples` must describe the **new plugin's** interface, not its siblings'.

1. **Read the upstream `config.d.ts`** (or `configSchema` in `package.json`) at the workspace's `repo`/`repo-ref`. Do not assume sibling plugins share a config structure.
2. **Cross-reference every key against the schema.** Strings where strings are expected, objects where objects are, arrays where arrays are. If the schema defines `clusters` as an array of objects with `name`, `url`, `authProvider`, a flat string is wrong.
3. **Do not copy a sibling's `appConfigExamples` verbatim.** Read siblings for the metadata format — YAML structure, field names, OCI reference patterns — and derive the content from the new plugin's schema.
4. **Check the upstream README** for working config snippets; it complements the TypeScript schema.
5. **Run smoke tests where available.** `/publish` then `/smoketest` catches config shapes that schema validation misses — passing a string where an object is expected typically crashes the plugin at runtime.

### Fixing a pattern across every sibling file

When you correct a structural problem in one `metadata/*.yaml` — wrong nesting, a schema violation, a flat value where an object belongs — check every other metadata file in the same workspace for the same pattern.

1. Identify the broken pattern in the file you are fixing.
2. Search the siblings:

   ```bash
   grep -r '<broken-pattern>' workspaces/<name>/metadata/
   ```

3. Apply the same fix wherever it appears.

[#3225](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/3225) fixed a flat `baseUrl` string where a nested cluster object belonged, but missed two sibling files carrying the identical error. Because all three files' `appConfigExamples` merge at deploy time, the unfixed pair caused eight days of continuous smoke test failures. One broken file is enough.

## Referential integrity

Three layers cross-reference each other, and editing one usually means editing all three:

- `plugins-list.yaml` — which packages this workspace builds.
- `workspaces/*/metadata/*.yaml` — `kind: Package`, one per standalone entry.
- `catalog-entities/extensions/plugins/*.yaml` — `kind: Plugin`, the user-facing entity.
- `catalog-entities/extensions/plugins/all.yaml` — the index listing every Plugin YAML.

**Package key fields:** `spec.packageName`, `spec.dynamicArtifact` (OCI reference), `spec.version`, `spec.backstage.role` (`frontend-plugin` / `backend-plugin`), `spec.backstage.supportedVersions`, `spec.support`, `spec.partOf` (parent Plugin entity names), `spec.appConfigExamples`.

**Plugin key fields:** `spec.categories`, `spec.highlights`, `spec.icon` (base64 SVG), `spec.packages` (links to Package entities), `spec.description` (markdown, no images). Schema: `https://raw.githubusercontent.com/redhat-developer/rhdh-plugins/refs/heads/main/workspaces/extensions/json-schema/plugins.json`.

The references run both ways:

- Plugin entities list their packages in `spec.packages`.
- Package entities name their parent in `spec.partOf`.

### When modifying `plugins-list.yaml`

Audit all three layers:

1. **`metadata/*.yaml`** — every `kind: Package` must have a `spec.packageName` matching a plugin exported in `plugins-list.yaml`. Remove or rename metadata for plugins that left.
2. **`catalog-entities/extensions/plugins/*.yaml`** — every `spec.packages` entry must resolve to an existing Package entity. Update references when packages are renamed or removed.
3. **`all.yaml`** — must list every Plugin YAML file; update it when Plugin files are added or removed.

Before committing, confirm no orphaned metadata remains: every `metadata/*.yaml` filename should correspond to a plugin in `plugins-list.yaml`. `/publish` validates this and fails on orphaned references.

### When renaming or splitting a Plugin entity

A `metadata.name` change breaks both directions at once:

1. Update `spec.packages` in the new or modified Plugin YAML files.
2. Update `spec.partOf` in every Package file that referenced the old name.

When reviewing such a change, verify each `spec.partOf` resolves to an existing Plugin entity name, and each `spec.packages` resolves to an existing Package entity name.

## Reviewing a new plugin addition

When a PR adds a plugin to an existing workspace — a new `plugins-list.yaml` entry plus a new `metadata/*.yaml` — check catalog entity completeness:

1. **Is there a corresponding Plugin entity** in `catalog-entities/extensions/plugins/`? Without one, the plugin is built and published as an OCI image but never appears in the Extensions UI, so users cannot discover or enable it through the standard interface. Flag this at medium or higher severity: a plugin that is built but invisible is a functional gap, not a cosmetic one.
2. **Does `all.yaml` list it?** Every Plugin YAML must be registered.
3. **Does the parent Plugin's `spec.packages` reference the new Package entity?** Without the link, the Extensions UI cannot associate them.

This gap is easy to miss because nothing fails. `publish-workspace-plugins.yaml` publishes OCI images from workspace metadata whether or not a Plugin entity exists — the plugin is installable by OCI reference and simply absent from the UI.

## Support-level promotion consistency

Plugins form families: `@backstage/plugin-notifications-backend-module-email` is a module of the `@backstage/plugin-notifications` family. When a PR changes one plugin's support level — `tech-preview` to `generally-available`, say — check the rest of the family.

Support levels live in three places, and a change usually needs all three:

- `spec.support` in `workspaces/*/metadata/*.yaml`
- `spec.support.level` in `catalog-entities/extensions/plugins/*.yaml`
- `support` in `default.packages.yaml`

A child promoted to GA while its parent stays tech-preview is a contradiction: the child cannot be generally available on a base that is not. The reverse is equally broken — demoting a parent without demoting its children leaves GA modules on an unsupported base.

1. **Identify the family by name prefix.** Everything up to and including the base plugin name, before `-backend`, `-module-*`, and similar suffixes. All packages matching `@backstage/plugin-notifications*` are one family.
2. **Search the prefix** across `default.packages.yaml` and `workspaces/*/metadata/*.yaml` to find the parent, the backend plugin, and any modules. Compare their current levels.
3. **Flag promotions that leave the parent behind** and ask for clarification before approving.
4. **Flag demotions that leave children behind**, for the same reason in reverse.
5. **Verify all three locations moved together.** One updated without the others is an omission.

Do not approve a single-plugin support change without the family check. It is a product-level decision — request clarification from the author exactly as a human reviewer would.

## `default.packages.yaml`

`default.packages.yaml` is the curated list of core RHDH packages. Packages listed there have their default configuration available for `{{inherit}}` in dynamic plugin deployment YAML and count as part of the core RHDH experience; over time the list is meant to align with the GA plugins in the catalog.

**Adding a package is a product-level decision requiring explicit PM or stakeholder approval — not a routine metadata change.** The file says so inline: *"Do not add packages to this list without prior agreement from PM."*

When reviewing a change here:

1. **New entries.** Do not approve autonomously. Flag for human review and confirm a PM or stakeholder explicitly signed off. A tidy, alphabetically placed insertion is not justification — inclusion changes what ships as core defaults.
2. **Removals and modifications.** Also need human review; they change the default configuration surface every user gets.
3. **Support-level changes.** Moves between `generally-available`, `tech-preview`, and commented-out entries change the core experience. Confirm the change went through the proper process.

Do not approve an addition to `default.packages.yaml` without evidence of stakeholder approval. Request human review and note that the change affects core RHDH defaults.
