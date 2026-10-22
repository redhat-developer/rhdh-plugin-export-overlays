# Dynamic Plugins

How plugin modules are exposed at build time, bundled into OCI images, and wired at deploy time — and how to diagnose a plugin that installs but never renders. The test-side view of the same failures is in [e2e-testing.md](./e2e-testing.md); the Package entities these configs are derived from are in [metadata-and-catalog.md](./metadata-and-catalog.md).

## `scalprum-config.json` and exposed modules

Frontend plugins use a `scalprum-config.json` to declare which modules they expose to the dynamic plugin loader. It sits at `workspaces/<name>/plugins/<plugin>/scalprum-config.json` — alongside the `overlay/` directory, not inside it.

Every frontend plugin has a default `PluginRoot` module. When metadata `appConfigExamples` reference a `module:` other than `PluginRoot` — `Legacy`, `Alpha`, `alpha` — the plugin's `scalprum-config.json` **must** list a matching key in `exposedModules`. Otherwise RHDH cannot resolve the module at runtime and the plugin fails to load.

```json
{
  "name": "backstage-community.plugin-rbac",
  "exposedModules": {
    "PluginRoot": "./src/index.ts",
    "Legacy": "./src/legacy/index.ts"
  }
}
```

The matching metadata:

```yaml
appConfigExamples:
  - title: Default configuration
    content:
      dynamicPlugins:
        frontend:
          backstage-community.plugin-rbac:
            appIcons:
              - name: rbacIcon
                importName: RbacIcon
                module: Legacy
```

The file overrides the upstream plugin's native module structure during packaging. If it lists only `PluginRoot`, every other module is absent from the built artifact — even when the upstream source exports it.

### Reviewing workspace updates for this

`update-plugins-repo-refs` generates metadata from upstream `package.json` exports. When an upstream plugin adds subpath exports such as `./legacy` or `./alpha`, the automation can emit metadata referencing those modules without creating the `scalprum-config.json` that exposes them.

1. Look at the `module:` values in the PR's `metadata/*.yaml` changes.
2. If any value other than `PluginRoot` appears, check for a matching `exposedModules` key in `plugins/<plugin>/scalprum-config.json`.
3. Add the missing module before merging, or the plugin fails at runtime.

### Diagnosing a missing module or a 404

When an E2E failure reports a missing module, an import that cannot be found, or a route 404 for a dynamic plugin, the cause is usually a `scalprum-config.json` that restricts what the artifact exposes. Do not add `module:` references to config files before checking whether the module was ever packaged.

1. **Identify the module the config expects.** Check `metadata/*.yaml` (`appIcons`, `dynamicRoutes`, `mountPoints` under `spec.appConfigExamples`) and `e2e-tests/tests/config/dynamic-plugins.yaml` if it exists. No `module:` field means `PluginRoot`.
2. **Read `exposedModules`.** If the referenced module is not a key there, it is not in the artifact — that is the root cause.
3. **Compare against upstream** at the workspace's `repo`/`repo-ref`. If upstream exports the module and the local file omits it, the local file is stale or over-restrictive.
4. **Fix it one of two ways.** Add the missing module to `exposedModules` when the overlay is needed for some other reason; or delete the file entirely when upstream's native config already exposes everything, which is often right for an overlay added against an older plugin version.

Common symptoms and what they mean:

- `BulkImportPage` / `BulkImportIcon` not found — the overlay exposes only `PluginRoot`, but those components live in `Legacy`.
- Route 404 for `/rbac` and similar — `dynamicRoutes` says `module: Legacy` while the artifact has only `PluginRoot`.
- Mount points not rendering — `mountPoints` references a module absent from `exposedModules`.

**The principle:** a missing module is a build-time overlay problem, not a deploy-time config problem. Adding `module:` to config does nothing if the module was never packaged. Check the overlay first.

## Embedding packages

`--embed-package` bundles a dependency inside a plugin's OCI image instead of relying on the host to provide it. It behaves differently for backend and frontend plugins because each runtime loads modules differently.

**Backend plugins** load as separate Node.js modules, each with its own `require` scope. Embedding creates an isolated copy and there is no shared singleton registry across modules, so duplication is safe and the flag works without caveats.

**Frontend plugins** use Module Federation. Each plugin runs in the same browser runtime inside a separate Webpack container, so embedding creates a private copy rather than sharing the host's version.

### The singleton identity problem

When a web library defines a singleton through Backstage's `createApiRef`, that singleton's identity is the JavaScript object reference. `ApiHolder` keys its `Map` by object identity, not by string name. If two frontend plugins each embed the same library, each gets its own copy of the `createApiRef` object: the provider registers under its copy, the consumer looks up under a different one, the lookup returns `undefined`, and the integration fails silently. React context behaves the same way — two copies of `React.createContext` produce two different contexts.

Neither builds nor smoke tests catch this. The image compiles, and smoke tests only prove each plugin loads individually; they never exercise cross-plugin API lookups. It surfaces only when multiple frontend plugins interact in a browser.

### Reviewing `--embed-package` on a frontend plugin

1. **Determine the role.** Read `spec.backstage.role` in the corresponding `metadata/*.yaml`. For `backend-plugin`, embedding is safe — stop here. The rules below apply to `frontend-plugin`.
2. **Check whether the library defines singletons.** Look for `createApiRef`, `React.createContext`, and similar in the library source at the workspace's `repo`/`repo-ref`.
3. **Check whether more than one frontend plugin would embed it.** One embedder means no duplication and no conflict. Two or more, on a library with singletons, is the problem case — flag it.
4. **Flag for human review when singleton risk exists.** Do not approve on build consistency or on the argument that backend plugins already embed the same library.
5. **Type-only packages are usually safe.** `-common` and `-node` packages holding only types, interfaces, and constants carry no runtime singleton risk. Verify from the source; the suffix is not a guarantee.
6. **Do not trade a build fix for a runtime regression.** When a PR claims to fix a build problem (BODY DRIFT, `sync-midstream` scrubbing, `validation-failed`), check that the proposed `--embed-package` does not break cross-plugin integration at runtime. A fix that trades one failure for the other is not a fix.

Backend and frontend plugins have fundamentally different module loading semantics. That a backend entry in the same `plugins-list.yaml` embeds a library says nothing about whether the frontend entry can.

## Which packages get metadata

Not every package in `plugins-list.yaml` gets a metadata entry.

- **Standalone entries** — the left-column paths, such as `plugins/catalog-backend-module-model-catalog:`. Each produces its own OCI image and needs a `kind: Package` metadata YAML in `workspaces/*/metadata/`.
- **`--embed-package` entries** — packages named after the flag, such as `--embed-package @red-hat-developer-hub/backstage-plugin-catalog-model-ai-model-server`. These are common libraries bundled into a standalone plugin's image. They get **no** metadata entry, no OCI artifact, and no `dynamicArtifact` reference.

```yaml
plugins/catalog-backend-module-model-catalog: --embed-package @red-hat-developer-hub/backstage-plugin-catalog-model-ai-model-server
```

Here `catalog-backend-module-model-catalog` is the standalone plugin with metadata; `catalog-model-ai-model-server` is embedded and has none. No embed-package in any workspace has a standalone metadata entry — that is by design.

When an issue asks for metadata for a package, check whether it is a standalone entry or only an `--embed-package` argument. In the second case the issue premise is wrong: the package is bundled into another plugin's image.

Package entries correspond one-to-one with standalone entries in `plugins-list.yaml`.

## `dynamic-plugins.yaml`: when it is needed

When a workspace has no `dynamic-plugins.yaml`, the framework auto-generates the complete plugin configuration from that workspace's `metadata/*.yaml`, resolving OCI references for all three modes. This is the recommended default, and most workspaces need zero config files.

Create one only to express something metadata cannot:

- disable a default plugin (`analytics-provider-segment`, `global-header`)
- remap a plugin to a different registry
- add `pluginConfig` that cannot live in `appConfigExamples`
- enable a plugin from `ghcr.io` workspace builds alongside catalog-index plugins
- declare a cross-workspace dependency (below)

### Keeping it minimal

When reviewing an added or modified `tests/config/dynamic-plugins.yaml`, ask whether each entry earns its place:

- **`disabled: true` for plugins the workspace does not use is redundant.** Auto-generation only includes plugins from this workspace's own `metadata/*.yaml`; plugins from other workspaces are never there to disable. The entry is coupling with no effect.
- **Entries duplicating auto-generated defaults** — same package, same config as `appConfigExamples` already yields — should be flagged. Omit the file instead.
- **Only genuine overrides justify the file**: config not in metadata, integrity overrides, version pins for testing.

This matters most during NFS migration, where the framework handles more automatically and legacy entries get carried forward out of habit.

### Cross-workspace dependencies

Auto-generation covers only plugins whose metadata lives in **this** workspace's `metadata/` directory. It cannot discover plugins from other workspaces, and some RHDH plugins are disabled by default and therefore appear in neither generated config nor RHDH defaults.

Known disabled-by-default plugins needing explicit configuration:

- `backstage-plugin-kubernetes-backend-dynamic`
- `backstage-plugin-kubernetes`

Workspaces that depend on `kubernetes-backend` from the `backstage` workspace and must keep their entries for it:

- `workspaces/argocd/` — cluster connectivity
- `workspaces/topology/` — resource discovery
- `workspaces/tekton/` — pipeline status

Rules:

1. **Never delete `dynamic-plugins.yaml` without checking for cross-workspace entries.** Entries for packages not in this workspace's `metadata/` are cross-workspace dependencies.
2. **When removing a local-path entry** such as `./dynamic-plugins/dist/...`, replace it with an OCI reference rather than deleting it. The plugin still needs configuring; only its source changes.
3. **An entry for a package absent from this workspace's metadata is a cross-workspace dependency** — do not remove it.
4. **When in doubt, keep it.** A redundant entry is harmless; a missing dependency fails tests.

### Reference formats

The `package:` field of a `dynamic-plugins.yaml` entry accepts:

- `ref://<package-name>` — resolved against the dynamic plugin descriptor YAML (DPDY) at runtime. Preferred for version-managed plugins.
- `oci://<registry>/<image>:<tag>` — a direct OCI reference.
- `./dynamic-plugins/dist/<name>` — a local wrapper path, legacy and removed in RHDH 2.0.

See the [e2e-test-utils docs](https://github.com/redhat-developer/rhdh-e2e-test-utils/tree/main/docs) for DPDY resolution details.

### Registries

Three registries are in active use, and their roles are shifting:

| Registry | Role | Notes |
| --- | --- | --- |
| `ghcr.io` | PR/dev builds, some released artifacts | `pr_<number>__<version>` tags and workspace-specific builds |
| `quay.io` | Production catalog index | Primary registry for released RHDH plugins |
| `registry.access.redhat.com` | Legacy production (RHEC) | Older refs, being phased out in favour of `quay.io` |

Hardcoded registry URLs are fragile. Plugin refs migrate as the catalog index evolves, and `{{inherit}}` resolves against the catalog index image's registry and repository — it matches only when registry and repo path align. That is exactly how the keycloak plugins broke: the catalog index moved to `quay.io` while e2e-test-utils still emitted `registry.access.redhat.com` `{{inherit}}` refs.

1. **Handle registry variation explicitly** when you must name an OCI URL. `intelligent-assistant` is the canonical pattern — disable the legacy ref and enable the equivalent `quay.io` one:

   ```yaml
   # Disable the legacy RHEC ref
   - package: oci://registry.access.redhat.com/rhdh/plugin-name:{{inherit}}
     disabled: true
   # Enable the quay.io ref with config
   - package: oci://quay.io/rhdh/plugin-name:{{inherit}}
     disabled: false
     pluginConfig: ...
   ```

2. **Prefer `{{inherit}}`** for plugins in the catalog index, so the framework resolves the right version per mode instead of pinning.
3. **Comment the assumptions.** Say which registry the catalog index uses, which refs need remapping, and what breaks if it moves. See `workspaces/intelligent-assistant/e2e-tests/tests/config/dynamic-plugins.yaml`.

## Baked-in plugins

Some plugins ship inside the RHDH image through `dynamic-plugins.default.yaml` (quickstart, for example). They load by default with no dynamic plugin configuration, and the overlays-side list of baked-in and DPDY packages lives in `default.packages.yaml` at the repo root.

E2E tests for these workspaces need mode-aware configuration:

- **PR mode** (`GIT_PR_NUMBER` set) — pass `dynamicPlugins: "tests/config/dynamic-plugins.yaml"` with `plugins: []`. That prevents auto-generation from creating duplicate config keys against the baked-in entry.
- **Nightly mode** (`E2E_NIGHTLY_MODE=true`, or `JOB_NAME` containing `periodic-`; `GIT_PR_NUMBER` wins) — pass a nightly-specific file such as `dynamic-plugins-nightly.yaml` with `plugins: []`, so metadata auto-generation cannot duplicate the OCI entries. `disablePlugins` has no effect in nightly mode.
- **Local dev** (neither set) — the plugin loads from defaults; `disablePlugins` has no effect outside PR mode.

The e2e-test-utils common defaults already set `disabled: true` for some baked-in plugins (quickstart popup suppression). That applies in every mode and is independent of the `disablePlugins` configure option.

**Omitting `dynamicPlugins` does not disable dynamic plugin configuration.** The framework falls back to `WorkspacePaths.dynamicPlugins` (`tests/config/dynamic-plugins.yaml`) and reads it if it exists. To control which config is used per mode, pass an explicit path.

```typescript
const isNightly = !process.env.GIT_PR_NUMBER &&
  (!!process.env.E2E_NIGHTLY_MODE ||
   (process.env.JOB_NAME?.includes("periodic-") ?? false));
await rhdh.configure({
  auth: "keycloak",
  ...(isNightly && { dynamicPlugins: "tests/config/dynamic-plugins-nightly.yaml" }),
});
```

When reviewing changes to `dynamicPlugins` configuration or to `dynamic-plugins.yaml` for a baked-in plugin workspace, verify all three modes.

For a deeper treatment of which `configure()` options take effect in which mode, see [e2e-fix-workflow.md](./e2e-fix-workflow.md#deployment-mode-validation).

## Installation example version tags

Plugin YAML files can carry a `spec.installation` section with OCI references, such as `oci://ghcr.io/.../plugin-name:bs_1.54.4__0.5.0`. Those tags must match the corresponding Package metadata.

1. **Cross-check every OCI reference in `spec.installation`** against the matching `workspaces/*/metadata/*.yaml` `spec.dynamicArtifact`. The tag format is `bs_<backstage-version>__<plugin-version>`, and both components must match. A mismatch is medium severity — it sends users to a stale or non-existent version.
2. **Watch for rebase-induced staleness.** Rebasing a Plugin YAML PR after a workspace version bump can silently leave installation examples behind while the Package metadata moves on. The original commit may have been correct; the rebase broke it. Check explicitly on rebased PRs.
3. **Fix by copying** the current tag from `spec.dynamicArtifact` in the corresponding metadata file.
