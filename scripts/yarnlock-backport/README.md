# yarnlock-backport

Generate `0-cve-yarn-lock.patch` and `cve-backports.yaml` without bumping `source.json:repo-ref`.

**Use for:** transitive CVE lockfile backports on [community-plugins](https://github.com/backstage/community-plugins) / Backstage workspaces when an on-demand upstream `yarn.lock` fix and publish is not practical.

**Do not use for:** [rhdh-plugins](https://github.com/redhat-developer/rhdh-plugins) — fix transitive CVEs in the plugin workspace `yarn.lock` upstream, then bump `repo-ref` in overlays.

Details: [user-guide/06-patch-management.md](../../user-guide/06-patch-management.md) (CVE yarn.lock Backports).

```bash
cd scripts/yarnlock-backport && npm install   # not on npm — install locally first

export OVERLAY_WORKSPACE=<absolute-git-worktree-path>/workspaces/tech-radar
export PLUGINS_REPO=<absolute-path-to-community-plugins>   # clone of source.json:repo

npx yarnlock-backport prepare  --release 1.10 --overlay-workspace "$OVERLAY_WORKSPACE" --plugins-repo "$PLUGINS_REPO"
# Manual step: update dependencies in plugins workspace (Instructions TBD)
npx yarnlock-backport generate --release 1.10 --overlay-workspace "$OVERLAY_WORKSPACE" --plugins-repo "$PLUGINS_REPO" --cve 'CVE-…,CVE-…/package'
```

`--cve`: comma-separated ids; optional `/npm-package` override (and comma-separated aliases) when MITRE product names differ from npm. Multiple CVEs may be listed together — commas before the next `CVE-` start a new token. Add `--verbose` on prepare for git output. Use `--skip-overlay-sync` to keep the current overlay checkout (e.g. testing a local `source.json:repo-ref` bump).

Requires Node.js, `git`, `yarn`, `patch`, `diff`, `npm`. Paths must be absolute. Fork clones need `upstream` on the overlays repo.

```bash
npm test
```
