# Patch Management

This guide covers creating, maintaining, and retiring patches for dynamic plugins in the overlay repository.

---

## When to Use Patches

Patches modify upstream source code before the build process. Use them when:

| Scenario | Example |
|----------|---------|
| **Build fixes** | Fixing TypeScript errors, missing exports |
| **Compatibility fixes** | Backporting API changes for older Backstage |
| **Bug fixes** | Critical fixes before upstream merges |
| **Configuration changes** | Modifying package.json fields |

> **Rule:** Patches are temporary. Always prefer upstream fixes when possible.

---

## Patch vs Overlay

| Feature | Patch | Overlay |
|---------|-------|---------|
| **Scope** | Entire workspace | Single plugin |
| **Method** | Line-by-line diff | File replacement |
| **Location** | `workspaces/[ws]/patches/` | `workspaces/[ws]/plugins/[plugin]/overlay/` |
| **Best for** | Small, targeted fixes | Adding new files, major rewrites |

### Use Patches When

- Fixing a few lines in existing files
- Changes apply across multiple files
- You want to track exactly what changed

### Use Overlays When

- Adding entirely new files
- Replacing complete implementations
- Changes are plugin-specific, not workspace-wide

---

## Patch File Format

Patches use **unified diff** format (same as `git diff`):

```diff
--- path/to/original/file.ts
+++ path/to/original/file.ts
@@ -20,7 +20,8 @@
 unchanged line
 unchanged line
-removed line
+added line
+another added line
 unchanged line
```

### Format Rules

| Element | Format |
|---------|--------|
| File header | `--- path/to/file` and `+++ path/to/file` |
| Hunk header | `@@ -start,count +start,count @@` |
| Context lines | Lines starting with space (` `) |
| Removed lines | Lines starting with minus (`-`) |
| Added lines | Lines starting with plus (`+`) |

---

## Creating a Patch

### Method 1: From Git Diff (Recommended)

```bash
# 1. Clone the source repository
git clone https://github.com/backstage/community-plugins
cd community-plugins

# 2. Checkout the exact ref from source.json
git checkout @backstage-community/plugin-your-plugin@1.2.3

# 3. Make your changes
vim plugins/your-plugin/src/some-file.ts

# 4. Generate the patch
git diff > ~/fix-description.patch

# 5. Review and clean up the patch
# Remove any paths that shouldn't be included
# Ensure paths are relative to workspace root
```

### Method 2: Manual Creation

For simple changes, create manually:

```diff
--- plugins/your-plugin/package.json
+++ plugins/your-plugin/package.json
@@ -2,8 +2,8 @@
   "name": "@backstage-community/plugin-your-plugin",
   "version": "1.2.3",
-  "main": "dist/index.esm.js",
-  "types": "dist/index.d.ts",
+  "main": "src/index.ts",
+  "types": "src/index.ts",
   "license": "Apache-2.0",
```

### Naming Convention

Export applies all `*.patch` files in **lexicographic (alphabetical) order** by filename
([override-sources.sh](https://github.com/redhat-developer/rhdh-plugin-export-utils/blob/main/override-sources/override-sources.sh)).

| Class | Pattern | Examples |
|-------|---------|----------|
| **CVE yarn.lock** | `0-cve-yarn-lock.patch` | At most **one** per workspace — dependency CVE fixes in `yarn.lock` only |
| **Code / build** | `[1-9][0-9]*-[description].patch` | `1-fix-typescript-errors.patch`, `2-add-missing-export.patch` |

The `0-` prefix ensures CVE lockfile patches run **before** numbered code patches (`1-`, `2-`, …).
Use numbered prefixes to control order among code patches.

---

## Patch Examples

### Example 1: Fix Double Wildcards in package.json

From `workspaces/roadie-backstage-plugins/patches/1-avoid-double-wildcards.patch`:

```diff
--- package.json
+++ package.json
@@ -32,7 +32,8 @@
   "workspaces": {
     "packages": [
       "packages/*",
-      "plugins/**",
+      "plugins/*",
+      "plugins/*/*",
       "utils/**"
     ]
   },
```

**Why:** Yarn Berry workspace resolution does not support `**` (double-star) glob patterns. Replacing `plugins/**` with explicit `plugins/*` and `plugins/*/*` ensures Yarn correctly discovers all plugin packages during dependency installation.

### Example 2: Fix Package Entry Points

From `workspaces/pagerduty/patches/1-fix-tsc-errors.patch`:

```diff
--- plugins/backstage-plugin/package.json
+++ plugins/backstage-plugin/package.json
@@ -2,8 +2,8 @@
   "name": "@pagerduty/backstage-plugin",
   "description": "A Backstage plugin that integrates towards PagerDuty",
   "version": "0.16.4",
-  "main": "dist/index.esm.js",
-  "types": "dist/index.d.ts",
+  "main": "src/index.ts",
+  "types": "src/index.ts",
   "license": "Apache-2.0",
```

**Why:** Export process needs source entry points, not dist.

### Example 3: Add Missing Private Field

From `workspaces/apiconnect/patches/1-fix-private-root-package.patch`:

```diff
--- package.json
+++ package.json
@@ -1,6 +1,7 @@
 {
   "name": "apic-backstage",
   "version": "1.0.1",
+  "private": true,
   "workspaces": [
     "plugins/*"
   ],
```

**Why:** Root package must be marked private to prevent accidental publishing.

### Example 4: Fix Import Statement

From `workspaces/backstage/patches/1-fix-mcp-actions-backend.patch`:

```diff
--- plugins/mcp-actions-backend/src/services/McpService.ts
+++ plugins/mcp-actions-backend/src/services/McpService.ts
@@ -20,13 +20,14 @@
   CallToolRequestSchema,
 } from '@modelcontextprotocol/sdk/types.js';
 import { JsonObject } from '@backstage/types';
 import { ActionsService } from '@backstage/backend-plugin-api/alpha';
-import { version } from '@backstage/plugin-mcp-actions-backend/package.json';
 import { NotFoundError } from '@backstage/errors';

 import { handleErrors } from './handleErrors';

+const version = '0.1.5';
+
 export class McpService {
```

**Why:** The original code imports `version` from `@backstage/plugin-mcp-actions-backend/package.json` using the package's own name as a bare specifier. In the dynamic plugin build and runtime context, this resolution path does not work because the package is extracted and loaded independently from the standard `node_modules` layout. The fix replaces the import with a hardcoded version string.

---

## Adding a Patch to the Repository

### Step 1: Create the Patch File

```bash
# Create patch using your preferred method
# Save to: workspaces/[workspace]/patches/[number]-[description].patch
```

### Step 2: Test the Patch Applies

```bash
# Clone source repo
git clone [repo-url] /tmp/test-patch
cd /tmp/test-patch
git checkout [repo-ref]

# Test patch application
patch -p0 --dry-run < /path/to/your-patch.patch

# If successful, output shows what would change
# If failed, you'll see rejection messages
```

### Step 3: Add to Repository

```bash
cd /path/to/rhdh-plugin-export-overlays
mkdir -p workspaces/[workspace]/patches
cp /path/to/your-patch.patch workspaces/[workspace]/patches/
git add workspaces/[workspace]/patches/
git commit -m "chore: add patch to fix [description]"
```

### Step 4: Document the Patch

Add a comment at the top of the patch file (optional but recommended):

```diff
# Patch: Fix TypeScript compilation errors
# Reason: Upstream uses newer TS features not compatible with our build
# Upstream issue: https://github.com/org/repo/issues/123
# Remove when: Upstream releases fix in next version
--- plugins/plugin-name/src/file.ts
+++ plugins/plugin-name/src/file.ts
```

---

## Maintaining Patches

### When Source Updates

After updating `source.json:repo-ref`:

1. **Test if patch still applies:**

   ```bash
   cd /tmp/source-checkout
   git checkout [new-ref]
   patch -p0 --dry-run < patches/1-my-fix.patch
   ```

2. **If patch applies cleanly:** No action needed

3. **If patch fails (context changed):** Re-roll the patch

4. **If fix is now upstream:** Remove the patch

### Re-Rolling a Patch

When line numbers or context have changed:

```bash
# 1. Checkout new source version
git clone [repo] /tmp/re-roll
cd /tmp/re-roll
git checkout [new-ref]

# 2. Apply old patch with --reject to see what failed
patch -p0 < /path/to/old-patch.patch
# Creates .rej files for failed hunks

# 3. Manually apply the intent of the rejected hunks
vim [files with .rej]

# 4. Generate new patch
git diff > /path/to/new-patch.patch

# 5. Clean up and test
rm *.rej *.orig
```

### Identifying Obsolete Patches

A patch is obsolete when:

- Upstream merged the fix
- A newer plugin version includes the change
- The issue no longer exists in the code

**Check process:**

```bash
# Compare patch content to upstream
git log --oneline --grep="[patch description]"
git log --oneline -p -- [affected-file] | head -100
```

---

## Removing Obsolete Patches

### Step 1: Verify Fix is Upstream

```bash
# Check if the patched lines exist in new version
curl -s "https://raw.githubusercontent.com/[repo]/[new-ref]/[file-path]" | grep -A5 -B5 "[patched content]"
```

### Step 2: Remove Patch File

```bash
git rm workspaces/[workspace]/patches/[obsolete-patch].patch
```

### Step 3: Test Build

```bash
# Open PR and trigger build
git commit -m "chore: remove obsolete patch [name] - fixed in upstream [version]"
git push
# Comment /publish on PR
```

### Step 4: Document Removal

In PR description:

```markdown
## Removed Patches

- `1-fix-xyz.patch`: Fixed in upstream v1.2.4 (commit abc123)
```

---

## Troubleshooting Patch Issues

### Error: "patch does not apply"

**Causes:**
- Wrong file path in patch header
- Context has changed
- Line endings mismatch (CRLF vs LF)

**Fix:**

```bash
# Check patch paths
head -5 my-patch.patch
# Verify paths exist at the repo-ref

# Check for line ending issues
file my-patch.patch
# Should show "ASCII text", not "ASCII text, with CRLF line terminators"

# Fix line endings if needed
dos2unix my-patch.patch
```

### Error: "Hunk #N FAILED"

**Cause:** Context lines don't match (file changed)

**Fix:** Re-roll the patch with updated context

### Error: "can't find file to patch"

**Cause:** File path in patch doesn't exist in source

**Fix:**

1. Verify `repo-ref` is correct
2. Check if file was moved/renamed
3. Update patch paths

---

## Patch Maintenance Checklist

```markdown
## Patch Review - [Workspace] - [Date]

### For Each Patch
- [ ] Patch still applies to current repo-ref
- [ ] Upstream issue is still open (if applicable)
- [ ] Fix is not yet in upstream release
- [ ] Patch is documented (reason, upstream issue, removal criteria)

### After Source Updates
- [ ] All patches apply cleanly
- [ ] No patches became obsolete
- [ ] Build succeeds with patches applied

### Quarterly Review
- [ ] Check all upstream issues for resolution
- [ ] Remove any obsolete patches
- [ ] Update patch documentation
```

---

## Best Practices

### Do

- ✅ Document why each patch exists
- ✅ Link to upstream issues when available
- ✅ Test patches before committing
- ✅ Remove patches when upstream fixes land
- ✅ Use descriptive patch names

### Don't

- ❌ Commit patches without testing
- ❌ Keep obsolete patches
- ❌ Create patches for problems that should be fixed upstream
- ❌ Use patches for adding new features (use overlays instead)
- ❌ Forget to re-roll patches after source updates

---

## CVE yarn.lock Backports

For **transitive-only** (i.e. `yarn.lock` change only) fixes, use `yarnlock-backport` — one `0-cve-yarn-lock.patch` per
workspace plus auto-generated `cve-backports.yaml`, without bumping `repo-ref`. For code
fixes, use numbered patches or overlays. When CVEs also require **direct** dependency
bumps in the upstream `package.json`, follow the sequence below first, then run the tooling to create the patch to fix the transitive dependencies.

CVE fixes for one workspace can include both **direct** dependencies (pinned in a
plugin's `package.json`) and **transitive** ones (lockfile-only). Use both upstream
releases and `yarnlock-backport` — in this order:

| Step | Where | Action |
|------|--------|--------|
| **1** | Upstream source repo (e.g. [rhdh-plugins](https://github.com/redhat-developer/rhdh-plugins) or [community-plugins](https://github.com/backstage/community-plugins)) | Bump affected **direct** dependencies in the plugin workspace `package.json`, merge, and publish new plugin npm versions (Release with changesets). |
| **2** | Overlays (`source.json` + metadata) | Update `repo-ref` to the upstream commit or tag that contains those releases. Sync `metadata/*.yaml` package versions. See [04 - Metadata Synchronization](./04-metadata-synchronization.md). |
| **3** | Overlays (`yarnlock-backport`) | At the **new** `repo-ref`, fix any remaining **transitive** CVEs with `0-cve-yarn-lock.patch` + `cve-backports.yaml` (steps below). |

Step 3 only covers what step 1–2 did not — lockfile bumps without another upstream release.
Re-run `generate` with the full CVE list after step 2 so `repo_ref` in the manifest matches
the updated baseline.

```
workspaces/[ws]/patches/
├── 0-cve-yarn-lock.patch    # applied first (max one)
├── cve-backports.yaml       # auto-generated
└── 1-fix-something.patch    # optional code/build patches
```

Tooling: `scripts/yarnlock-backport/` (`npm install` once). Requires Node.js
(see `versions.json`), `git`, `yarn`, `patch`, `diff`, `npm`. Use after step 2 above
when transitive bumps are still required at the current `repo-ref`.

| Path / remote | Requirement |
|---------------|-------------|
| `--overlay-workspace` | Absolute path; fork needs `upstream` on rhdh-plugin-export-overlays (prepare syncs `release-{version}`) |
| `--plugins-repo` | Absolute path to a local clone of **`source.json:repo`** (e.g. rhdh-plugins, [community-plugins](https://github.com/backstage/community-plugins)); git remote is resolved from that URL |

Use a [git worktree](https://git-scm.com/docs/git-worktree) on the overlay release branch when patch files are not on your current branch.

```bash
# Overlay release branch (for patches/manifest on release-1.10)
git worktree add ../rhdh-overlays-release-1.10 release-1.10
# Optional: dedicated tree for script development (keeps main checkout clean)
git worktree add ../rhdh-overlays-scripts lockfile-patch-scripts
```

```bash
cd scripts/yarnlock-backport && npm install   # local tool — not published to npm

export OVERLAY_WORKSPACE=<absolute-git-worktree-path>/workspaces/orchestrator
export PLUGINS_REPO=<absolute-path>   # clone matching source.json:repo

npx yarnlock-backport prepare --release 1.10 \
  --overlay-workspace "$OVERLAY_WORKSPACE" --plugins-repo "$PLUGINS_REPO"

# Manual step: Update dependencies in $PLUGINS_REPO/workspaces/<ws>/ (Instructions TBD)

npx yarnlock-backport generate --release 1.10 \
  --overlay-workspace "$OVERLAY_WORKSPACE" --plugins-repo "$PLUGINS_REPO" \
  --cve 'CVE-2026-44487,CVE-2026-41674/@xmldom/xmldom'
```

| Command | What it does |
|---------|--------------|
| **prepare** | Sync overlay release branch → checkout `repo-ref` in source repo → `yarn install` → apply existing `0-cve-yarn-lock.patch` |
| **generate** | `yarn install` → diff `repo-ref` baseline vs local `yarn.lock` → write patch + merge manifest (fetches MITRE) |

**Flags:** `--release`, `--overlay-workspace`, `--plugins-repo` (required). `prepare`: `--skip-patch`, `--force`, `--verbose`, `--dry-run`. `generate`: `--cve` (required), `--dry-run`.

**`--cve` syntax:** comma-separated CVE ids. Append `/npm-package` when MITRE names the product differently from the npm package (e.g. `CVE-2026-41242/protobufjs`). Multiple npm aliases: `CVE-2026-41674/@xmldom/xmldom,xmldom`. Combine with other CVEs via commas before the next `CVE-` id (e.g. `CVE-2026-44487,CVE-2026-41674/@xmldom/xmldom,xmldom`).

**Debugging:** `yarn install` streams output by default. Use `--verbose` on prepare to also stream git fetch/checkout. Other subprocess failures print captured stderr plus exit code and `cwd`.

**Re-roll:** If prepare fails at patch apply, discard the stale patch, restore bumps from `cve-backports.yaml` (Instructions TBD), apply any new fixes, then re-run **generate** with the **full** `--cve` list.

**Verify (future):** Planned `yarnlock-backport verify` against OCI images after `/publish`.

### Manifest (`cve-backports.yaml`)

Rows merge CVEs sharing the same `package` + `patch_version`. `repo_ref` is `source.json:repo-ref` at generate time (patch baseline). `patch_version` is comma-separated when multiple major lines exist (read from the local `yarn.lock`). Optional manual `notes` are preserved across re-runs.

```yaml
patch_file: 0-cve-yarn-lock.patch
repo_ref: eb6cce6110fc8bd532e717e9d995764481b36f1b
backports:
  - cve_ids: [CVE-2026-44486, CVE-2026-44487]
    package: axios
    patch_version: 1.18.1
    notes: Upstream PR 3537; shipped in backend OCI
  - cve_ids: [CVE-2026-45736, CVE-2026-48779]
    package: ws
    patch_version: 8.18.0, 8.21.0
    notes: |-
      [auto] ws@8.18.0 is still in CVE affected range; verify dev-only
      └─┬ @internal/orchestrator@1.0.0
        └── … → ws@8.18.0
```

**`[auto]` notes:** On generate, each `patch_version` is checked against MITRE affected ranges. Versions still in range get a warning plus an `npm ls` spine (usually dev-only). Manual notes above `[auto]` are preserved; the `[auto]` block is refreshed each run.

| Event | Action |
|-------|--------|
| First backport | generate → commit patch + manifest |
| Add CVEs / re-roll | update dependencies (Instructions TBD) → generate with full `--cve` list |
| Patch fails at prepare | Re-roll flow above |
| Retire | Delete patch + manifest when fixed upstream in `repo-ref` |

---

## Related Documentation

- [02 - Export Tools](./02-export-tools.md) – Overlays vs Patches comparison
- [04 - Metadata Synchronization](./04-metadata-synchronization.md) – Keeping versions in sync
- [03 - Plugin Owner Responsibilities](./03-plugin-owner-responsibilities.md) – Maintenance obligations
