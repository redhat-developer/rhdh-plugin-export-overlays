# Syncing with Upstream RHDH

## Upstream repos
- Utils: https://github.com/redhat-developer/rhdh-plugin-export-utils
- Overlays: https://github.com/redhat-developer/rhdh-plugin-export-overlays

## Sync process

### 1. Sync export-utils

```bash
cd devportal-plugin-export-utils
git fetch upstream
git merge upstream/main
# Resolve conflicts (unlikely — we don't modify utils much)
git push origin main
```

### 2. Sync export-overlays

```bash
cd devportal-plugin-export-overlays
git fetch upstream
git merge upstream/main
# Resolve conflicts:
#   - versions.json: keep our backstage version
#   - plugins-regexps: keep our scope list
#   - .github/workflows/*: keep our org/registry references
#   - workspaces/: new workspaces will appear — categorize as KEEP or DISABLE
git push origin main
```

### 3. After sync
- Review new workspaces added by upstream
- Check if disabled workspaces have been updated (may be worth re-evaluating)
- Run full matrix build to validate
- Fix any patch conflicts

## Frequency
Monthly or when a new RHDH release branch is created.
