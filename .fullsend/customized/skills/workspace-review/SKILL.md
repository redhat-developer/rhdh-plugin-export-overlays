# Workspace Review Skill

Additional review dimension for PRs that touch workspace definitions or
catalog entities. This skill is invoked by the review agent alongside
`code-review` and `docs-review`.

## When to use this skill

Use this skill when the PR modifies files under `workspaces/` or
`catalog-entities/`. If neither directory is touched, skip this skill
entirely — it does not apply.

## Repository structure reference

### Workspace layout

Each workspace at `workspaces/<name>/` packages upstream plugins as OCI images:

| File/Directory | Purpose | Required |
|----------------|---------|----------|
| `source.json` | Upstream repo URL, git ref, Backstage version | Yes |
| `plugins-list.yaml` | Which plugins to export, with CLI args | Yes |
| `metadata/*.yaml` | `kind: Package` entities (version, OCI ref, appConfigExamples) | Yes |
| `plugins/<plugin>/overlay/` | File replacements applied during packaging | No |
| `patches/*.patch` | Unified diffs applied to workspace source | No |
| `e2e-tests/` | Playwright test suite | No |

### Catalog entity layout

| File/Directory | Purpose |
|----------------|---------|
| `catalog-entities/extensions/plugins/*.yaml` | `kind: Plugin` entities (UI display) |
| `catalog-entities/extensions/collections/*.yaml` | Plugin groupings |
| `catalog-entities/extensions/plugins/all.yaml` | Index — every Plugin YAML must be listed |

### Support tier files

| File | Purpose |
|------|---------|
| `rhdh-supported-packages.txt` | Red Hat supported plugins (GA + TP) |
| `rhdh-community-packages.txt` | Community supported plugins |

## Evaluation procedure

### 1. Identify changed workspace and catalog files

From the PR file list (already fetched by `pr-review`), filter for
files under `workspaces/` and `catalog-entities/`. Group workspace
files by workspace name.

### 2. Validate source.json structure

For any new or modified `source.json`, verify:

- Required fields present: `repo`, `repo-ref`, `repo-flat`, `repo-backstage-version`
- `repo` is a valid HTTPS GitHub URL
- `repo-ref` is a specific tag or SHA (not `main` or `master` — pinned refs prevent silent breakage)
- `repo-backstage-version` matches the major.minor of `versions.json` at the repo root (or has a documented reason for divergence)

### 3. Validate plugins-list.yaml

For any new or modified `plugins-list.yaml`, verify:

- Each entry has a `path` field pointing to a valid plugin directory in the upstream repo
- CLI args (if present) are valid `@red-hat-developer-hub/cli` export flags
- Plugin names are consistent with the workspace's `metadata/*.yaml` Package entities

### 4. Validate Package metadata

For any new or modified `metadata/*.yaml` files, verify:

- `kind: Package` is set
- Required spec fields: `packageName`, `dynamicArtifact`, `version`, `backstage.role`
- `backstage.role` is one of: `frontend-plugin`, `backend-plugin`, `backend-plugin-module`, `frontend-plugin-module`
- `dynamicArtifact` follows the OCI reference pattern (`oci://ghcr.io/...`)
- `spec.support` (if present) is one of: `community`, `production`, `tech-preview`
- `spec.appConfigExamples` (if present) contains valid YAML snippets

### 5. Validate catalog entities

For any new or modified Plugin entities under `catalog-entities/extensions/`:

- `kind: Plugin` is set
- Required fields: `metadata.name`, `spec.description`, `spec.packages`
- `spec.packages` references must correspond to existing Package entities in some workspace's `metadata/`
- If a new Plugin YAML is added, verify it is listed in `plugins/all.yaml`
- `spec.icon` (if present) should be a base64-encoded SVG (not a URL)
- `spec.categories` values should match existing categories used in other Plugin entities

### 6. Check support tier consistency

When a PR modifies `rhdh-supported-packages.txt` or `rhdh-community-packages.txt`:

- Each package name should correspond to a Package entity in some workspace's `metadata/`
- A package should not appear in both support tier files
- Newly added workspaces should have their packages listed in the appropriate tier file

When a PR adds a new workspace, check whether its packages are absent from both tier files and flag as info.

### 7. Validate overlay and patch files

For overlays (`plugins/*/overlay/`):

- Files should have reasonable extensions (.ts, .tsx, .json, .yaml, etc.)
- Check for overly broad overlays that replace core framework files

For patches (`patches/*.patch`):

- Must be valid unified diff format
- Numbered prefix should maintain order (e.g., `1-foo.patch`, `2-bar.patch`)
- Context lines should be sufficient for clean application

### 8. Branch policy compliance

- New workspaces (entire new `workspaces/<name>/` directory) should only appear on PRs targeting `main`, never on `release-*` branches
- PRs targeting `release-*` branches should only update existing workspace files

### 9. Cross-reference checks

- If `source.json` changes `repo-ref` to a new version, check that `metadata/*.yaml` versions are updated accordingly
- If `plugins-list.yaml` adds or removes plugins, check that corresponding `metadata/*.yaml` files are added or removed
- If a workspace is being added, check `default.packages.yaml` for whether the plugins should be included in the default set

## Output

Report findings using the same format as `code-review`. Include findings in the `workspace-review` category:

- **high** `[workspace-structure]` — Missing required files, invalid source.json, broken cross-references
- **high** `[workspace-branch-policy]` — New workspace on a release branch
- **medium** `[workspace-metadata]` — Inconsistent metadata (version mismatch, missing Package entities)
- **medium** `[catalog-index]` — Plugin entity not listed in all.yaml
- **low** `[workspace-convention]` — Style issues, unpinned refs, naming inconsistencies
- **info** `[workspace-support-tier]` — Package not in any support tier file, support tier changes

## Common findings

- `source.json` with `repo-ref` pointing to `main` instead of a pinned tag/SHA
- New workspace missing Package metadata files
- Metadata version not updated when `source.json` ref changes
- New Plugin entity added but not listed in `plugins/all.yaml`
- Patches with insufficient context lines (may fail to apply on minor upstream changes)
- New workspace added to `release-*` branch instead of `main`
- Overlay replacing a file that doesn't exist in the upstream repo at the pinned ref
