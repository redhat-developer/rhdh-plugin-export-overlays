# DevPortal Plugin Export Overlays

Exports upstream Backstage plugins as dynamic plugins and publishes them as OCI artifacts to `ghcr.io/veecode-platform/devportal-plugin-export-overlays`.

This is a fork of the [RHDH plugin export overlays](https://github.com/redhat-developer/rhdh-plugin-export-overlays) system, adapted for the VeeCode DevPortal distribution.

## How it works

```
workspaces/<name>/source.json          # points to upstream repo + version
workspaces/<name>/plugins-list.yaml    # lists plugins to export from that workspace
workspaces/<name>/metadata/            # package metadata for each plugin
         ↓
   GitHub Actions (push to main or workflow_dispatch)
         ↓
   rhdh-cli export → OCI image per plugin
         ↓
   ghcr.io/veecode-platform/devportal-plugin-export-overlays/<plugin>:<tag>
```

The pipeline uses the reusable workflows from [devportal-plugin-export-utils](https://github.com/veecode-platform/devportal-plugin-export-utils). Versions of Backstage, Node, and the CLI are pinned in `versions.json`.

## Registry

All published artifacts live under:

```
ghcr.io/veecode-platform/devportal-plugin-export-overlays
```

Image tags follow the pattern `bs_<backstage_version>__<plugin_version>` (e.g. `bs_1.48.4__2.4.3`).

## Adding a new plugin workspace

1. Create a directory under `workspaces/<workspace-name>/`.

2. Add `source.json` pointing to the upstream repo:
   ```json
   {
     "repo": "https://github.com/backstage/community-plugins",
     "repo-ref": "v1.2.3",
     "repo-flat": false,
     "repo-backstage-version": "1.48.4"
   }
   ```
   - `repo-flat`: `true` if plugins live at the repo root (e.g. `backstage/backstage`), `false` if inside a workspace subfolder.

3. Add `plugins-list.yaml` listing the plugins to export:
   ```yaml
   plugins/my-plugin:
   plugins/my-plugin-backend: --embed-package @scope/some-dependency
   ```
   Lines can include extra CLI flags like `--embed-package` or `--suppress-native-package`.

4. Optionally add a `metadata/` directory with Package manifests (one YAML per plugin). These are used for smoke tests and for consuming the plugins in DevPortal.

5. Optionally add per-plugin overlays or workspace-level patches:
   - `plugins/<plugin-name>/overlay/` — files that replace or add to the plugin source
   - `plugins/<plugin-name>/app-config.dynamic.yaml` — dynamic app config for frontend plugins
   - `plugins/<plugin-name>/scalprum-config.json` — Scalprum config for frontend plugins
   - `patches/*.patch` — patches applied to the workspace source before build

6. Push to `main`.

## Disabling a workspace

Rename the plugins list file:

```bash
mv workspaces/<name>/plugins-list.yaml workspaces/<name>/plugins-list.yaml.disabled
```

The build pipeline skips any workspace without an active `plugins-list.yaml`.

## Triggering a build

- **Automatic**: push to `main` that changes anything under `workspaces/` or `versions.json`.
- **Manual**: run the "Publish DevPortal Dynamic Plugin Images" workflow via `workflow_dispatch` in GitHub Actions.

## Consuming published artifacts

Reference the OCI artifact in your `dynamic-plugins.yaml`:

```yaml
plugins:
  - package: oci://ghcr.io/veecode-platform/devportal-plugin-export-overlays/backstage-community-plugin-argocd:bs_1.48.4__2.4.3!backstage-community-plugin-argocd
    disabled: false
    pluginConfig: {}
```

The `!` suffix after the tag specifies the integrity sub-path inside the OCI image.

## Upstream sync

This repo is periodically synced with the upstream RHDH export overlays. See [SYNC.md](SYNC.md) for the process.

## Based on

- [rhdh-plugin-export-overlays](https://github.com/redhat-developer/rhdh-plugin-export-overlays) — upstream workspace definitions
- [rhdh-plugin-export-utils](https://github.com/redhat-developer/rhdh-plugin-export-utils) — reusable export workflows and CLI tooling
