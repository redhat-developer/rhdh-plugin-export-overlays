# yarnlock-backport

Generate `0-cve-yarn-lock.patch` and `cve-backports.yaml` for overlay workspaces without bumping `source.json:repo-ref`.

Full workflow: [user-guide/06-patch-management.md](../../user-guide/06-patch-management.md).

```bash
cd scripts/yarnlock-backport && npm install

export OVERLAY_WORKSPACE=<absolute-path>/workspaces/orchestrator
export PLUGINS_REPO=<absolute-path>

yarnlock-backport prepare  --release 1.10 --overlay-workspace "$OVERLAY_WORKSPACE" --plugins-repo "$PLUGINS_REPO"
# … yarn up in plugins workspace …
yarnlock-backport generate --release 1.10 --overlay-workspace "$OVERLAY_WORKSPACE" --plugins-repo "$PLUGINS_REPO" --cve 'CVE-…,CVE-…/package'
```

`--cve` accepts comma-separated CVE ids. Override the npm package name when MITRE metadata is wrong:
`CVE-2026-41674/@xmldom/xmldom` or multiple aliases: `CVE-2026-41674/@xmldom/xmldom,xmldom` (same syntax as [rhdh-security triager](https://github.com/redhat-developer/rhdh-security/blob/main/triage/triager.py)).

Requires: Node.js, `git`, `yarn`, `patch`, `diff`, `npm`. `--overlay-workspace` and `--plugins-repo` must be **absolute** paths.

Fork clones need an `upstream` remote pointing at `https://github.com/redhat-developer/rhdh-plugin-export-overlays.git` (step 0 syncs the release branch from there).

```bash
npm test
```
