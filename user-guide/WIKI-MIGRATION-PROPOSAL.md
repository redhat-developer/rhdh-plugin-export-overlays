# Wiki Migration Proposal

This document outlines the plan to migrate user guide documentation to the GitHub Wiki with automation support.

## Why Wiki?

| Aspect | Static Docs (current) | Wiki |
|--------|----------------------|------|
| Edit workflow | PR required | Direct edit |
| Integration with generated content | Manual | Can be automated |
| Discoverability | Linked from README | Native GitHub feature |
| Version control | Full git history | Separate wiki repo |
| PR review | Yes | No (trade-off) |

## Proposed Wiki Structure

```
Home.md                           # Overview, links to all sections
├── Getting-Started.md            # Core concepts, repository structure
├── Adding-a-Plugin.md            # Step-by-step plugin onboarding
├── Export-Tools.md               # CLI reference (links to official docs)
├── Plugin-Owner-Guide.md         # Responsibilities, checklists
├── Metadata-Synchronization.md   # Sync procedures
├── Version-Updates.md            # Backstage version maintenance
├── Patch-Management.md           # Creating/maintaining patches
├── Troubleshooting.md            # Common issues and solutions
│
├── [GENERATED] Backstage-Compatibility-Report.md    # Auto-generated
├── [GENERATED] Workspace-Status-main.md             # Auto-generated per branch
├── [GENERATED] Workspace-Status-release-1.6.md      # Auto-generated per branch
│
└── _Sidebar.md                   # Custom navigation
```

## Custom Sidebar (`_Sidebar.md`)

```markdown
### 📚 User Guide
* [[Home]]
* [[Getting Started]]
* [[Adding a Plugin]]
* [[Export Tools]]

### 🔧 Maintenance
* [[Plugin Owner Guide]]
* [[Metadata Synchronization]]
* [[Version Updates]]
* [[Patch Management]]

### 📊 Status (Auto-Generated)
* [[Backstage Compatibility Report]]
* [[Workspace Status - main]]
* [[Workspace Status - release-1.6]]

### 🔗 External Links
* [Dynamic Plugins Docs](https://github.com/redhat-developer/rhdh/tree/main/docs/dynamic-plugins)
* [Backstage Documentation](https://backstage.io/docs)
```

## Automation Implementation

### GitHub Actions Workflow

A workflow is configured at `.github/workflows/sync-user-guide-to-wiki.yaml` that:

1. **Triggers automatically** when `user-guide/**` files change on `main` branch
2. **Can be triggered manually** via workflow_dispatch (with optional dry-run)
3. **Uses JavaScript** (`.github/workflows/github-script/sync-user-guide-to-wiki.js`) for transformation

```yaml
# Workflow triggers
on:
  push:
    branches: [main]
    paths: ['user-guide/**']
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run (do not push changes)'
        type: boolean
```

### What the Script Does

1. Clones the wiki repository (`*.wiki.git`)
2. Copies user guide files with wiki-compatible names
3. Transforms internal markdown links to wiki format (`[[Page|Text]]`)
4. Generates `_Sidebar.md` for navigation
5. Generates `Home.md` as landing page
6. Commits and pushes changes

### Manual Trigger

```bash
gh workflow run sync-user-guide-to-wiki.yaml
# Or with dry-run
gh workflow run sync-user-guide-to-wiki.yaml -f dry_run=true
```

## Auto-Generated Content

The sync script reads repository data and injects dynamic content into wiki pages.

### What Gets Auto-Generated

| Content | Source | Placeholder |
|---------|--------|-------------|
| Backstage version | `versions.json` | `{{AUTO:BACKSTAGE_VERSION}}` |
| Node.js version | `versions.json` | `{{AUTO:NODE_VERSION}}` |
| CLI version | `versions.json` | `{{AUTO:CLI_VERSION}}` |
| CLI package | `versions.json` | `{{AUTO:CLI_PACKAGE}}` |
| Versions table | `versions.json` | `<!-- AUTO:VERSIONS_TABLE -->` |
| Source repos table | `plugins-regexps` | `<!-- AUTO:SOURCE_REPOS_TABLE -->` |
| Workspace count | `workspaces/` scan | `{{AUTO:WORKSPACE_COUNT}}` |
| Workflow URLs | Context | `{{AUTO:WORKFLOW_EXPORT}}` |

### Using Placeholders in Docs

**Block placeholders** (replaced with multi-line content):
```markdown
<!-- AUTO:VERSIONS_TABLE -->
```

**Inline placeholders** (replaced with single values):
```markdown
Current version: `{{AUTO:BACKSTAGE_VERSION}}`
```

### Triggers for Auto-Update

The wiki sync workflow triggers when:
- `user-guide/**` files change
- `versions.json` is updated
- `plugins-regexps` is modified
- Manual workflow dispatch

---

## Migration Steps

1. **Phase 1: Initial Setup**
   - [ ] Create `_Sidebar.md` in wiki
   - [ ] Create `Home.md` as landing page
   - [ ] Migrate core user guide pages

2. **Phase 2: Integration**
   - [ ] Update existing generated pages to fit new structure
   - [ ] Add cross-links between manual and generated content
   - [ ] Update main README to point to Wiki

3. **Phase 3: Automation**
   - [ ] Create workflow to sync generated content
   - [ ] Add workflow to validate wiki links
   - [ ] Set up notifications for wiki changes

## Decision Points for Discussion

1. **PR Review Trade-off**: Wiki edits don't require PR review. Is this acceptable?
2. **Generated Content Location**: Should auto-generated pages live in wiki or stay as workflow artifacts?
3. **Maintenance Ownership**: Who owns wiki content updates?

## References

- [GitHub Wiki Documentation](https://docs.github.com/en/communities/documenting-your-project-with-wikis)
- [Current Wiki](https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki)
- [Dynamic Plugins Docs](https://github.com/redhat-developer/rhdh/tree/main/docs/dynamic-plugins)
