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

```
[number]-[description].patch

Examples:
1-fix-typescript-errors.patch
2-add-missing-export.patch
3-fix-private-root-package.patch
```

Patches are applied in **numerical order**.

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

**Why:** Some package managers don't handle `**` wildcards correctly.

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

**Why:** Importing from package.json isn't supported in the dynamic plugin context.

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

## Related Documentation

- [02 - Export Tools](./02-export-tools.md) – Overlays vs Patches comparison
- [04 - Metadata Synchronization](./04-metadata-synchronization.md) – Keeping versions in sync
- [03 - Plugin Owner Responsibilities](./03-plugin-owner-responsibilities.md) – Maintenance obligations
