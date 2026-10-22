# Workspace Maintenance

Adding plugins to a workspace, moving a workspace to a new upstream release, and keeping the version values across `source.json`, `backstage.json`, `versions.json`, and `metadata/*.yaml` in agreement. The metadata fields these updates must satisfy are in [metadata-and-catalog.md](./metadata-and-catalog.md); workspaces that carry patches also need [patches-and-lockfiles.md](./patches-and-lockfiles.md).

## Adding a new workspace

New workspaces go on `main` only; a `release-x.y` branch never takes one.

1. Create `workspaces/<name>/source.json`:

   ```json
   {"repo":"https://github.com/org/repo","repo-ref":"<tag-or-sha>","repo-flat":false,"repo-backstage-version":"1.45.1"}
   ```

   `repo-flat` is `true` when the plugins sit at the repo root and `false` when they sit inside a workspace subdirectory.

2. Create `workspaces/<name>/plugins-list.yaml` listing the plugin paths to export.
3. Create `workspaces/<name>/metadata/<package-name>.yaml` for each plugin (`kind: Package`).
4. Add a CODEOWNERS entry in `.github/CODEOWNERS` for the new workspace, in alphabetical order.

## Overlay versus patch

- **Overlay** (`plugins/<plugin>/overlay/`) — replaces or adds entire files during packaging. Use it for changes specific to one plugin.
- **Patch** (`patches/*.patch`) — applies line-by-line changes to the workspace source before build. Use it for fixes that span the workspace. The numeric prefix controls application order (`1-fix-something.patch`).

## Adding a plugin to an existing workspace

A workspace with `source.json` and `plugins-list.yaml` already has `repo-ref` pinned to a specific commit. The new plugin must exist **at that ref** — not at the upstream default branch or latest tag.

1. **Read the pinned ref.** Take `repo`, `repo-ref`, and `repo-flat` from `source.json`. `repo-ref` is the exact commit the build checks out.

2. **Verify the plugin directory exists at that commit:**

   ```bash
   # Monorepo workspaces (repo-flat: false) keep plugins under workspaces/<name>/plugins/<plugin>/
   gh api repos/{owner}/{repo}/contents/{plugin-path}?ref={repo-ref} --jq '.name' 2>/dev/null
   ```

   Do not use `git clone --depth 1` for this check. A shallow clone fetches the default branch HEAD, which may contain content that does not exist at the pinned ref.

3. **If the plugin is missing at the pinned ref, advance `repo-ref`.** Find the earliest upstream commit containing the plugin, set `repo-ref` to it, and confirm every existing plugin in `plugins-list.yaml` still exists and is valid at the new ref — same directory structure, compatible versions.

4. **Re-check `repo-backstage-version` when the ref moves.** If the upstream repo's Backstage version changed between the old and new ref, update the field to match. Read the upstream root `package.json` or `backstage.json` at the new ref.

5. **Add the plugin to `plugins-list.yaml` and create its metadata.** Follow the existing pattern: the plugin path in `plugins-list.yaml`, and a `metadata/<package-name>.yaml` of `kind: Package` with `spec.packageName`, `spec.dynamicArtifact`, `spec.version`, and the rest of the required fields. Remember that `--embed-package` entries get no metadata of their own — see [dynamic-plugins.md](./dynamic-plugins.md#which-packages-get-metadata).

## Updating a workspace to a new release

1. **Read `versions.json`** at the repo root for the target `backstage` version (for example `1.52.0`).
2. **Update `source.json`.** Set `repo-ref` to the target commit or tag, and `repo-backstage-version` to the upstream source's own Backstage version.
3. **Update each affected `metadata/*.yaml`:**
   - `spec.version` — the new plugin version.
   - `spec.backstage.supportedVersions` — the `backstage` value from `versions.json`, **not** `repo-backstage-version` from `source.json`.
   - The OCI tag in `spec.dynamicArtifact` — `bs_<versions.json backstage>__<plugin version>`, for example `bs_1.52.0__0.17.3`.
4. **Verify consistency.** Every metadata file in the workspace should carry the same `supportedVersions` and the same `bs_` prefix, and both should match `versions.json`.

### `supportedVersions` versus `repo-backstage-version`

These two are routinely different and are not interchangeable.

- `versions.json` `backstage` is what this repo builds and publishes against. `supportedVersions` and the `bs_` prefix record it.
- `source.json` `repo-backstage-version` is the upstream source's own compatibility target.

A workspace may well read `1.51.0` in `source.json` while `versions.json` says `1.52.0`. That is correct, not a bug.

## Reviewing workspace version update PRs

Version updates are the most common PR type here, generated daily by `update-plugins-repo-refs.yaml` and identifiable by the `workspace-update` label. They are mechanical, which is exactly why the consistency errors slip through: a metadata version that does not match the release, an OCI tag with the wrong Backstage version, a stale file for a plugin that did not change. Generic review heuristics miss all three.

1. **Ref-to-version consistency.** Confirm `repo-ref` corresponds to a tagged release or a merged version-bump commit upstream, using the `repo` URL. Confirm each updated `spec.version` matches the upstream package version at that ref.
2. **OCI tag format.** Confirm `spec.dynamicArtifact` tags follow `bs_<backstage-version>__<plugin-version>`, that the Backstage component matches `backstage.supportedVersions` in the same file, and that the plugin component matches `spec.version`.
3. **Selective metadata updates.** Only plugins whose versions changed upstream should have changed metadata. Cross-reference the upstream changelog or the linked PR to see which plugins were actually released.
4. **Backstage compatibility.** If `repo-backstage-version` changed, look harder: a framework jump may need E2E verification. Check that `supportedVersions` moved consistently with it.
5. **File scope.** A version update should touch only `source.json` and `metadata/*.yaml` in the target workspace. Anything outside that — overlays, patches, `plugins-list.yaml`, other workspaces — needs an explanation.

Do not apply code-style review to version strings and OCI tags. They are machine-generated in a fixed format; spend the effort on consistency instead.

### Verify metadata completeness, not just the issue text

The issue that prompted the update may not describe every plugin that changed. An upstream ref spans many commits.

After updating `source.json`, walk the workspace:

1. **Enumerate plugins** from `plugins-list.yaml`.
2. **Read each plugin's upstream `package.json` at the new `repo-ref`.** Resolve the path by layout: with `"repo-flat": false`, `plugins/my-plugin` means `workspaces/<workspace>/plugins/my-plugin/package.json`; with `"repo-flat": true`, it means `plugins/my-plugin/package.json` at the repo root.
3. **Compare against `metadata/*.yaml`.** Where `spec.version` disagrees, update `spec.version` and the `spec.dynamicArtifact` tag.
4. **Update every stale file**, not only the ones the issue names. The PR is not done until all metadata matches the upstream source at the target ref.

## Major version bumps in workspace updates

When a workspace update crosses a major version boundary — the first numeric component of `spec.version` rises, `1.22.0` to `2.0.0` — the risk is higher than a minor or patch bump. Upstream majors restructure module layouts, move component exports, rename mount points, and change dynamic plugin configuration. The build can succeed against stale metadata while the plugin fails to load at runtime.

This repo holds no plugin source. It holds metadata, including `appConfigExamples` with mount points, `module` references, and config keys, and that metadata has to match what the new version actually exposes.

**Scope.** The Scalprum and mount-point steps below target **frontend** plugins (`spec.backstage.role: frontend-plugin`). Backend major bumps need a different focus: breaking changes to API routes, configuration schemas, and database migrations.

**When it applies.** Only on a major boundary. Minor and patch updates do not need upstream config comparison — the standard checks above suffice. One caveat: an upstream project that does not follow semver can introduce breaking config changes in a minor release, so consider applying these checks to any bump that changes plugin configuration.

1. **Detect the boundary.** Compare old and new `spec.version` in `metadata/*.yaml`.
2. **Compare the upstream dynamic plugin configuration at both refs.** Fetch the upstream `app-config.dynamic.yaml` (or equivalent) at the old and new `repo-ref` values. Compare mount point definitions, `module` references, and translation resources. If upstream added, changed, or removed `module:` fields, `appConfigExamples` here must follow. If upstream has no such file, do not conclude nothing changed — go to step 3.
3. **Verify module layout.** Check the upstream `package.json` `exports` and the Scalprum `exposedModules` at the new ref. If upstream added modules (`Legacy`, `Alpha`), moved exports between them, or changed the default, confirm every `importName` in `appConfigExamples` names the right `module`. A component moved out of `PluginRoot` needs `module: Legacy`, or the plugin loads and the component never appears.
4. **Check E2E config consistency.** If the workspace has `e2e-tests/tests/config/dynamic-plugins.yaml`, it must reflect the same module and mount point changes. If it has none — the recommended default — the framework generates config from `metadata/*.yaml`, which makes `appConfigExamples` the authority and means no separate E2E update is needed.
5. **Do not trust the upstream changelog alone.** Release notes may claim backward compatibility while the reference config says otherwise. The global-header v1 to v2 update ([#3059](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/3059)) is the case study: the changelog said no config changes were needed, and the upstream `app-config.dynamic.yaml` had added `module: Legacy` to every OFS mount point.

A major update that builds and even passes smoke tests can still render nothing. Verify the config alignment.

## Backstage version consistency

Four values must agree within a workspace:

1. `backstage.json` `version` — if the file exists; it is an optional override created by `/override-backstage`.
2. `source.json` `repo-backstage-version`.
3. `metadata/*.yaml` `spec.backstage.supportedVersions`.
4. The `bs_` prefix in `metadata/*.yaml` `spec.dynamicArtifact` tags — the `1.54.5` in `bs_1.54.5__0.15.0`.

A mismatch means either a partially applied `/override-backstage` or a manual edit gone wrong. The classic shape: `backstage.json` and `source.json` both say `1.54.5` while metadata still reads `1.54.4` in `supportedVersions` and in its OCI tags.

Flag any per-workspace inconsistency for the author. Do not approve across mismatched Backstage versions.

`backstage.json`, when present, must equal `versions.json` `backstage` for the target branch — `main`, or the branch's own `versions.json` on a `release-x.y`. `/publish` rejects a workspace where they disagree, with `Backstage-incompatible workspace: <name> at X vs target Y`. That is a 3+ hour round trip of failed publish, investigation, fix, and re-publish, so catching it at review time is worth the check. Medium severity: it does not break production, it blocks the pipeline.

Note that `source.json` `repo-backstage-version` legitimately differs from `backstage.json` `version` — the upstream targets its own Backstage version while the build overrides to the branch target. Do not flag that gap.

## Reviewing `versions.json` changes

`versions.json` is the repo's central version configuration. Its fields propagate to every workspace build:

- **`backstage`** — used by `generate-catalog-index.yaml` for the catalog index version, by `auto-publish-pr.yaml` for the export build environment, and by `bootstrapPluginBuilds.py` to tag OCI artifacts. Every workspace's OCI tags contain it.
- **`node`** — the build container's Node runtime in `auto-publish-pr.yaml`. Affects every export and publish job.
- **`cli`** / **`cliPackage`** — the `@red-hat-developer-hub/cli` version that packages every dynamic plugin as an OCI image, passed to `export-workspaces-as-dynamic.yaml` as `janus-cli-version`.

Treat a `versions.json` PR as an infrastructure change, not a mechanical bump.

**CLI major bumps (`cli`) carry the most risk**, because that tool builds everything. A breaking change can fail every OCI image build at once.

1. Compare old and new values; a rising first component is a major bump.
2. Read the CLI package's changelog or release notes for breaking changes: removed or renamed commands, changed argument syntax, dropped Node support, altered output formats.
3. Check that CLI arguments passed through `plugins-list.yaml` still exist — search for workspaces using custom `--export-args` or other flags.
4. Confirm the `backstage` field sits inside the new CLI's supported range.
5. Ask for `/publish` and `/smoketest` on at least one workspace before merge, plus `/test` where E2E exists.

**Backstage bumps (`backstage`):**

1. Check workspace compatibility — each `source.json` `repo-backstage-version` must work with the new value, or OCI tag resolution and builds break.
2. Confirm metadata OCI tags will still resolve.
3. Confirm the current `cli` supports the new Backstage version, especially across majors.

**Node bumps (`node`):**

1. Confirm the current `cli` supports the new Node version — check its `engines` field or release notes.
2. Check upstream plugin build requirements; some pin Node in their build config, and a mismatch fails the export.
3. Watch major boundaries (`18.x` to `20.x`), which drop older APIs and often force dependency updates.

## Security-relevant configuration changes

When a fix touches a security control — dependency quarantine, authentication, CORS, access control, rate limiting, TLS — prefer the narrowest targeted exemption over disabling the control. A global disable removes protection for everyone, not just the consumer that needed the exemption.

The principle: identify what the control protects, check whether the tool offers a scoped exemption, and use the narrowest option that solves the problem. Disable wholesale only as a last resort, with an explicit justification for why no scoped option exists.

1. **Identify the control and its purpose.** A fix that disables something without understanding what it prevents cannot weigh the trade-off.
2. **Search the documentation for granular mechanisms.** Most controls offer allowlists, per-package exemptions, per-origin policies, or per-route bypasses.
3. **Prefer the narrowest exemption**, even when a global disable is simpler to implement.
4. **If you must disable entirely**, say so in the PR description and commit message, naming the protection lost and why the trade-off is acceptable.

The example from this repo: Yarn 4.17 introduced supply-chain quarantine (`npmMinimalAgeGate`) that blocked `yarn install` for newly published packages. Two fixes were proposed:

- `npmMinimalAgeGate: 0` — disables quarantine for every package, removing supply-chain protection wholesale.
- `npmPreapprovedPackages: ["@red-hat-developer-hub/e2e-test-utils"]` — exempts only the team's own first-party package and keeps quarantine for everything else.

Both unblocked the install. Only one kept the protection.

Where this recurs:

- **CORS** — specific origin allowlists rather than `*`.
- **Authentication** — scoped bypasses for named endpoints rather than disabling checks globally.
- **Dependency policies** — per-package exemptions rather than turning off version or audit policies.
- **Network policies** — named ports or CIDRs rather than all traffic.
- **Linter and scanner rules** — inline suppression of a specific finding rather than disabling the rule project-wide.
