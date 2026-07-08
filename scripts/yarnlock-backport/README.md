# yarnlock-backport

Generate `0-cve-yarn-lock.patch` and `cve-backports.yaml` without bumping `source.json:repo-ref`.

Details: [user-guide/06-patch-management.md](../../user-guide/06-patch-management.md).

```bash
cd scripts/yarnlock-backport && npm install   # not on npm — install locally first

export OVERLAY_WORKSPACE=<absolute-git-worktree-path>/workspaces/orchestrator
export PLUGINS_REPO=<absolute-path>   # clone of source.json:repo (e.g. rhdh-plugins or community-plugins)

npx yarnlock-backport prepare  --release 1.10 --overlay-workspace "$OVERLAY_WORKSPACE" --plugins-repo "$PLUGINS_REPO"
# Manual step: update dependencies in plugins workspace (Instructions TBD)
npx yarnlock-backport generate --release 1.10 --overlay-workspace "$OVERLAY_WORKSPACE" --plugins-repo "$PLUGINS_REPO" --cve 'CVE-…,CVE-…/package'
```

`--cve`: comma-separated ids; optional `/npm-package` override (and comma-separated aliases) when MITRE product names differ from npm. Multiple CVEs may be listed together — commas before the next `CVE-` start a new token. Add `--verbose` on prepare for git output.

Requires Node.js, `git`, `yarn`, `patch`, `diff`, `npm`. Paths must be absolute. Fork clones need `upstream` on the overlays repo.

```bash
npm test
```
