# Native (Docker-free) smoke harness

Validates RHDH dynamic **backend** plugins in-process — install via the published
`install-dynamic-plugins` CLI, then boot with `startTestBackend` — with **no Docker
container and no cluster**. About **20x faster** than the per-workspace `docker run rhdh`
smoke-test it replaces for that scope.

**Tickets:** RHIDP-15075, RHIDP-15076, RHIDP-13530 (epic RHIDP-13501);
RHIDP-13510 for the support-level sweep (epic RHIDP-13497).

## Why

The repo's container smoke-test boots RHDH in Docker (`docker run rhdh …`) just to check a
plugin loads. An earlier native attempt (PR #2231) was closed because it was 694 lines of
bespoke OCI parsing and predated the npm CLI. Now that `install-dynamic-plugins` is
published — and RHDH already uses it in-process in `plugin-dynamic-loading.spec.ts`
(PR #4967) — that extraction collapses to one CLI call, so the smoke validation runs
in-process with no container.

## What it does

```
install CLI (extract OCI → dynamic-plugins-root, run with cwd=root)
  → discoverPlugins()         # scan install dirs, classify by package.json backstage.role
  → loadBackendPlugins()      # require() each, assert default BackendFeature
  → startTestBackend()        # boot core + loaded features in-process (+ rootConfig)
  → validateBackendBundle()   # configSchema shipped — the one fault booting cannot reveal
  → validateFrontendBundle()  # both manifests usable; configSchema shipped (not executed)
  → findConfigKeyMismatches() # workspace mode: configured keys vs Scalprum bundle names
  → results.json + exit code
```

### Frontend bundle validation (both frontend systems)

The check recognizes both packagings and records which one(s) each plugin ships in
`results.json` (`frontend.bundles[].systems`):

| System                                  | Required artifacts                                                        | Example plugin           |
| --------------------------------------- | ------------------------------------------------------------------------- | ------------------------ |
| Legacy (Scalprum)                       | `dist-scalprum/` + `plugin-manifest.json`                                 | most current plugins     |
| New frontend system (module federation) | `dist/mf-manifest.json` (the asset it names need not be `remoteEntry.js`) | `app-auth` (new-FE only) |
| Dual                                    | both layouts                                                              | `tech-radar`             |

A present-but-incomplete layout fails even if the other system's layout is valid.

Both halves validate the manifest's **shape**, not just its presence, and separately the
bundle is required to ship the config schema it declares. Presence is what let two silent
customer bugs through — RHDHBUGS-2180 on the manifests, RHDHBUGS-1157 on the schema. In
each, the artifact is there, the app boots, nothing errors, and the plugin is either absent
or running on its defaults.

#### Scalprum manifest (`frontend.bundles[].scalprum`)

`dist-scalprum/plugin-manifest.json` is parsed and checked against what the host needs
(RHDHBUGS-2180):

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | the host registers the remote under this, and RHDH matches app-config `dynamicPlugins.frontend.<key>` against it. Missing ⇒ **fails**: no mount point can be addressed                                                                                                                                                                                                                                     |
| `loadScripts`        | the assets the host fetches to initialise the plugin. Not an array, empty, carrying an entry that is not a non-empty asset name, escaping `dist-scalprum/`, or naming something the bundle does not contain as a file ⇒ **fails**: the host fetches a 404, the registration callback never runs, every configured route answers 404. Escaping and absent get different messages, as they do on the MF side |
| `missingScripts`     | the `loadScripts` entries with no usable asset behind them — the evidence for the row above                                                                                                                                                                                                                                                                                                                |
| `extensionCount`     | how many extensions the manifest declares. **Reported, never failed on** — see below. `null` when the field is not an array at all, which does fail                                                                                                                                                                                                                                                        |
| `registrationMethod` | `callback` for everything RHDH publishes                                                                                                                                                                                                                                                                                                                                                                   |

`extensionCount: 0` is the normal shape, not a defect: `@red-hat-developer-hub/cli` constructs
its `DynamicRemotePlugin` with a literal `extensions: []`, so all 76 published frontend
bundles report 0, and the SDK's own manifest schema permits it (`z.array(...)` with no
`.nonempty()`, while `loadScripts` is `.nonempty()`). With `registrationMethod: "callback"`
the plugin registers at runtime and RHDH drives its surfaces from app-config mount points,
so a static extension list is not where anything is declared. Failing on it would fail the
entire catalogue and could never go green.

#### Configured key vs bundle name (`frontend.configKeyMismatches`)

The other half of the `name` row above. RHDH matches the app-config key
`dynamicPlugins.frontend.<key>` against the `name` the bundle's Scalprum manifest reports;
when they disagree the plugin loads and **every mount point configured under that key is
ignored, with nothing logged** — the same user-visible outcome as RHDHBUGS-2180, reached a
different way. A present, well-formed manifest passes every check above and still delivers
nothing.

Workspace mode only: the keys come from `spec.appConfigExamples[].content.dynamicPlugins.frontend`
in `workspaces/<name>/metadata/*.yaml`, which the other modes have no equivalent of. The
field is **absent** rather than `[]` there, because "not checked here" and "checked and
clean" must not read the same.

Two things keep it from crying wolf:

- **The keys come from the packages actually installed**, not from the workspace's metadata
  at large. `collectWorkspaceRefs` returns them alongside the refs for exactly this reason:
  a `--support` sweep installs a subset, and a key belonging to a filtered-out package would
  otherwise match no installed bundle — the check would go red precisely on the runs that
  validate less. Packages whose artifact is a local `./dynamic-plugins/dist/…` path are left
  out for the same reason: nothing is installed for them.
- **RHDH's own built-in keys are excluded.** `default.main-menu-items` names no plugin; RHDH
  filters it out by scope in `ignoreStaticPlugins`
  (`packages/app/src/utils/dynamicUI/initializeRemotePlugins.ts`) before asking Scalprum for
  anything, and its docs describe the `default.` prefix as required for main menu items.
  This is a constant mirroring RHDH, not a tracked exclusion: the exclusions file exists for
  defects that carry a ticket and get deleted when fixed, and a permanent product fact
  filed there would make "every entry has a ticket" a lie.

The comparison is **set-based** — does any bundle in the run report the name — rather than
tied to the bundle of the package that declares the key. One OCI image can carry several
plugins (`cost-management` is two packages behind one ref), so a per-package mapping would
not survive the catalogue as it actually is.

Measured across the published catalogue: 49 workspaces configure frontend keys, 73 keys in
total, and **every one matches** once the built-in is excluded. Emptying the built-in list
yields exactly one finding, the `global-header` one — so the exclusion suppresses that and
nothing else, and global-header's own plugin key is still checked.

#### Config schema (`frontend.bundles[].configSchema`, `backend.bundles[].configSchema`)

A bundle that declares configuration must ship the schema for it, or Backstage has nothing
to match the plugin's app-config keys against and drops them without a word — the plugin
runs on its defaults while the operator's settings look applied (RHDHBUGS-1157).

This is the one check that runs on **both** halves. Nothing about the defect is
frontend-specific, and on the backend side it is the only artifact fault the boot cannot
reveal: such a plugin `require()`s, exposes its BackendFeature and starts, just on its
defaults. Loading and booting is a stronger check than any file inspection for everything
else a backend bundle must satisfy, which is why the backend record carries this and
nothing more.

The consumer is `gatherDynamicPluginsSchemas` in
`@backstage/backend-dynamic-feature-service`, and **RHDH overrides its locator**
(`rhdh:packages/backend/src/index.ts`):

```ts
schemaLocator(pluginPackage) {
  const platform = PackageRoles.getRoleInfo(pluginPackage.manifest.backstage.role).platform;
  return path.join(platform === "node" ? "dist" : "dist-scalprum", "configSchema.json");
},
```

The locator is keyed on the package's **role**, so which file matters depends on the half:
`getRoleInfo("frontend-plugin").platform` is `"web"`, while both backend roles are `"node"`
(verified by executing `@backstage/cli-node`, not inferred). Neither is
`dist/.config-schema.json`, which is only the upstream default. The export writes one file
per consumer, which is why there are two:

| Role                                       | RHDH reads                        | Upstream default reads     |
| ------------------------------------------ | --------------------------------- | -------------------------- |
| `frontend-plugin`                          | `dist-scalprum/configSchema.json` | `dist/.config-schema.json` |
| `backend-plugin` / `backend-plugin-module` | `dist/configSchema.json`          | `dist/.config-schema.json` |

Note how close the backend row is: RHDH's file and the upstream default are **siblings in
`dist/`, differing only by filename**. A check written against `.config-schema.json` — the
name that appears in the gatherer's own default locator — passes an artifact whose config
RHDH drops in silence.

Only RHDH's path is failed on, and it is checked **whether or not its directory exists** —
its absence is the fault. Gating it on the directory left an NFS-only bundle, which ships no
`dist-scalprum/` at all, passing while RHDH dropped its config in silence. The upstream copy
is reported with `consumer: "upstream-default"` and never failed: rejecting an artifact over
a file this platform ignores would be a false positive.

The gatherer drops a schema in four ways, which is what the states below mirror:

```js
if (!await fs.pathExists(schemaLocation)) continue;   // missing -> silent
if (!serialized) continue;                            // null    -> silent
if (isEmpty(serialized)) continue;                    // {}      -> silent
if (serialized?.backstageConfigSchemaVersion === 1) { // wrapped form: merged first,
  serialized = mergeConfigSchemas(serialized.schemas.map(_ => _.value)); //  not modelled here
}
if (!serialized?.$schema || serialized?.type !== "object") {
  logger.error("Serialized configuration schema is invalid for plugin ...");
  continue;                                           // invalid -> logged
}
```

Only the last is not silent, and a line in a backend log is not much louder than nothing for
an artifact published weeks earlier — the config is dropped either way. The wrapped form is
not modelled here: `export-dynamic-plugin` never writes it, and judging it would mean
reimplementing the merge.

`declared` is `configSchema` on the shipped `package.json`, Backstage's own signal, with
`declaredError` beside it for when `package.json` could not be read at all — a failure to
look must not be published as `declared: false`, the same reason `mf.nfsFeaturesError`
exists. `files` carries one entry per path `export-dynamic-plugin` writes for this package —
RHDH's own, per the table above, plus the upstream default when a `dist/` exists to hold
it — each tagged with its `consumer` and carrying a state of `ok`, `missing`, `unreadable`,
`empty` or `invalid`, plus its `propertyCount`.

Note what `ok` does and does not establish. The export writes the schema MERGED across the
package and its filtered dependency tree, so `ok` means some schema survived, not that this
plugin's own keys did — a declaring package whose `config.d.ts` was lost still reports `ok`
as soon as one dependency contributed a property (11 of the 76 published packages ship a
schema built purely from dependencies). Proving the plugin's own keys survived would mean
compiling its `config.d.ts`, which is the export's job. The check catches the total loss,
which is what RHDHBUGS-1157 was.

**Only `declared: true` — or a `package.json` that could not be read at all — can fail.** The export merges the package's own `configSchema` with
every one it finds in the dependency tree, so an empty schema means "declares nothing" for
most packages and "the declaration was lost" only for the ones that declare: 33 of 76
frontend packages declare, 32 ship an empty schema, and only the intersection is a finding.
Failing on an empty schema alone would accuse 32 packages of a bug they do not have, so the
messages keep "declares no configuration" and "declares configuration and shipped no
schema" apart.

The backend half splits the same way, and the gate matters just as much there. Over all 107
published backend artifacts this repo lists — every tier, `backend-plugin` and
`backend-plugin-module` — 54 declare `configSchema` and all 54 ship a usable
`dist/configSchema.json`; of the 53 that declare nothing, 40 ship `{}` and 13 ship a
non-empty schema contributed entirely by dependencies. So the check finds nothing today,
and it would have accused 40 packages had it failed on the empty schema alone.

#### Module-federation manifest (`frontend.bundles[].mf`)

Presence is not enough here either: the remotes router in
`@backstage/backend-dynamic-feature-service` logs and `continue`s past a manifest missing
any field it needs, so `GET /.backstage/dynamic-features/remotes` still answers `200 []`
and the browser gets an app that boots cleanly with no plugins.

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | `mf-manifest.json` `name` — the host registers the remote under this                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `remoteEntry`        | `metaData.remoteEntry.name` — must exist on disk, under `metaData.remoteEntry.path` when that is set and contained within `dist/`. A missing or escaping asset is a **bundle** fault, not a router one — `servable` stays true, because the router resolves its own entry from `name` alone and never reads `path`. The router itself serves the manifest as the entry (its default `getRemoteEntryType()` is `"manifest"`); this asset is what the MF runtime fetches after reading it |
| `exposes`            | module names the remote exposes; every entry must carry a `name`, but an empty list is valid                                                                                                                                                                                                                                                                                                                                                                                            |
| `nfsFeatures`        | entry points whose `backstage.features` type the new frontend system mounts                                                                                                                                                                                                                                                                                                                                                                                                             |
| `nfsFeaturesExposed` | the subset of `nfsFeatures` the manifest actually exposes. Empty while `nfsFeatures` is not means NFS will definitively mount nothing; both empty means metadata cannot say (see below)                                                                                                                                                                                                                                                                                                 |
| `servable`           | whether the **router** will serve the remote rather than skipping it — set only by the router's own guards, so a broken bundle does not flip it                                                                                                                                                                                                                                                                                                                                         |

`servable` and the feature fields are reported apart because they are two different
problems and both are silent at runtime. `servable: false` is an artifact defect and
**fails** the run. A served remote that may contribute nothing **warns**, and the two
cases read differently on purpose:

- **declares NFS entry points but does not expose them** — `nfsModuleFilter` installs a
  filter that keeps no modules, so NFS mounts nothing. Definitive.
- **declares no `backstage.features` at all** — `nfsModuleFilter` returns no resolver, so
  every exposed module is advertised and the frontend loader decides at runtime by each
  module's `$$type`. Whether anything mounts **cannot be told from metadata**, and the
  harness says so rather than guessing.

Nine published frontend packages are in the second state today (`argocd`, `qe-theme`, the
six `@roadiehq/*`, and `@backstage/plugin-techdocs-module-addons-contrib`). Failing either would turn six
workspaces red for work that belongs upstream. See [`docs/nfs-e2e-triage.md`](../docs/nfs-e2e-triage.md).

`src/loader.ts` and `src/{module-resolution,plugin-config}.ts` are ported from RHDH
PR #4967; `discoverPlugins()` replaces RHDH's `loadManifest()` because this CLI version
lays out one dir per plugin instead of emitting a `manifest.json`.

## What it deliberately does NOT do

It does **not render frontend UI**. `startTestBackend` is backend-only. UI-behaviour tests
(the 24 overlay `e2e-tests`, which are ~all Playwright `uiHelper`-driven) need a real
frontend — that is the **NFS / app-next** path (RHIDP-15082), intentionally out of scope.

## Run

Requires Node 24 and Yarn 4 (matching the repo's `versions.json` and the sibling
`workspaces/*/e2e-tests`), plus registry access to pull the OCI plugin images.

`better-sqlite3` is opted into building via `dependenciesMeta` in `package.json`: Yarn
4.17.1 made `enableScripts: false` the default, and without its native binding every
`startTestBackend()` boot fails with `Could not locate the bindings file`. The opt-in is
per package rather than a blanket `enableScripts: true`, so nothing else in the tree runs
install scripts.

```bash
yarn install

cat > dp.yaml <<'YAML'
plugins:
  - package: oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/<plugin>:<tag>!<name>
YAML
yarn smoke --dynamic-plugins dp.yaml
```

Three mutually exclusive plugin sources: `--dynamic-plugins <file>` (above),
`--workspace <name>` and `--catalog-index <dynamic-plugins.default.yaml>`.

### Workspace mode

Validate ALL published plugins of a workspace together — the same unit the Docker
smoke covers:

```bash
yarn smoke --workspace mcp-integrations
```

It resolves every `oci://` `spec.dynamicArtifact` from
`workspaces/<name>/metadata/*.yaml` and installs/boots them in one run. Metadata
whose artifact is a local `./dynamic-plugins/dist/…` path (plugin bundled inside the
RHDH image, no published OCI artifact — e.g. `scaffolder-backend-module-kubernetes`)
is skipped with a warning and recorded in `results.json`
(`workspace.skippedMetadata`); a workspace with no `oci://` refs at all reports
`status: error` (nothing to validate). `--workspace`, `--dynamic-plugins` and `--catalog-index` are
mutually exclusive.

Workspace mode also auto-discovers the workspace's Docker-smoke test config —
`workspaces/<name>/smoke-tests/app-config.test.yaml` and `smoke-tests/test.env` —
when present. Explicit `--app-config`/`--test-env` flags win over discovered files.

### Catalog-index mode

Validate every package a generated catalog index declares — the upstream half of RHDH's
cluster-free plugin sanity check (RHIDP-13508):

```bash
# Against an index this repo is about to publish
yarn smoke --catalog-index ../catalog-index/dynamic-plugins.default.yaml

# Against an index that is already published
../scripts/extractCatalogIndex.sh quay.io/rhdh/plugin-catalog-index:next /tmp/dpdy.yaml
yarn smoke --catalog-index /tmp/dpdy.yaml --exclusions catalog-index-sanity-excludes.txt
```

RHDH's check has to `skopeo copy` the published `plugin-catalog-index` image and walk its
layers just to recover `dynamic-plugins.default.yaml`. Run from
`scripts/update-index.sh --sanity-check`, that file is already on disk and the failure
lands **before** the image is built rather than a day after it shipped.

Two deliberate differences from feeding the index straight to the install CLI:

- **The index's `enabled:` flags are ignored.** It ships most packages `enabled: false` —
  RHDH's out-of-the-box default, which says nothing about whether the artifact works.
  Honouring them would validate almost nothing, so this generates an enable-everything
  config, the same thing RHDH's `populate-catalog-index.sh` does and for the same reason.
- **`pluginConfig` blocks are dropped.** They carry `${SEGMENT_WRITE_KEY}`-style
  placeholders for env vars that exist in a deployed RHDH and nowhere here, and a plugin
  that validates config at boot fails on the empty substitution. The harness's own dummy
  root config (`src/plugin-config.ts`) plus `--app-config` cover that instead.

`./dynamic-plugins/dist/…` packages are skipped: they ship inside the RHDH image and have
no artifact to pull. `results.json` records the split in `catalogIndex`
(`declared` / `refCount` / `inImage` / `enabledInIndex`), so a pass cannot hide that most
of the index was never installed.

Exclusions for this mode live in `catalog-index-sanity-excludes.txt` and are written
against the **OCI image name** (`backstage-community-plugin-quay`), because a catalog index
carries no npm names. `candidateNames()` in `src/exclusions.ts` normalizes an installed
package.json name to the same form, so one pattern is valid at both `install` and `boot`
scope.

On a schedule this runs as `.github/workflows/catalog-index-sanity.yaml` (04:00 UTC, plus
`workflow_dispatch` with a `catalog_index_image` input for RC verification). The static,
network-free half — refs that do not resolve, digest drift, fallback tags, a registry leak
— is `scripts/validateCatalogIndex.py`, which runs on every index generation.

### Support-level sweep (RHIDP-13510)

Community-supported plugins are **not in the RHDH image** — RHIDP-13262 removed them from
`default.packages.yaml` — so they exist only as artifacts this repo publishes to ghcr.io,
and nothing else validated them. The catalog index, by design, carries only
generally-available `quay.io/rhdh` packages: zero overlap with this sweep. The index side
is covered separately, by catalog-index mode above.

`yarn sweep` closes that gap by selecting packages from metadata and driving the harness
once per workspace:

```bash
yarn sweep --support community --shards 6 --plan      # print the shard plan, run nothing
yarn sweep --support community --shards 6 --shard 0   # run one shard
yarn sweep --support community                        # run everything in one shard
yarn aggregate --in results --summary summary.md \
  --expect-shards 6                                   # merge; fail if a shard is missing
```

The selection reads `spec.support` from the workspace metadata rather than the
repo-root `rhdh-community-packages.txt` that AGENTS.md describes: the metadata is what
the build actually publishes from, and the two disagree today (41 workspaces carry a
community package; the txt file names 20).

**`spec.support` is the classifier, not the npm scope.** `@backstage-community/plugin-topology`
and `-tech-radar` are generally-available; `quay`, `tekton` and `3scale` are community.
Selecting by npm org resolves the wrong set. Because selection is metadata-driven, a new
workspace is covered the day its metadata lands rather than when someone hand-writes a
smoke test — which matters given that 15 of the 41 community workspaces have neither
`smoke-tests/` nor `e2e-tests/`.

The workspace is the unit of work: its plugins share the `smoke-tests/` config the harness
auto-discovers, and it is the unit the Docker smoke already uses. Each workspace runs as
its own harness **process**, so a plugin that crashes Node costs one workspace's result
rather than the shard's. `planShards` balances on package count and is deterministic, so
the planning job and each sharded job compute the same plan without passing lists around.

#### What this sweep can and cannot assert

The operative requirement for this tier is **"the published artifact installs and boots"**
(rhdh's `docs/testing-requirements-matrix.md`, reworded in rhdh#5212 — the old phrasing, "loads
without error in a default RHDH instance", was orphaned when community plugins left the
image).

| Scope                             | Coverage                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------- |
| All community packages            | OCI install + dynamic-plugin layout validation                                   |
| Community backend packages        | real boot via `startTestBackend`                                                 |
| Catalog-extending backend modules | install + bundle layout, no boot — see `plugin-sweep-excludes.txt` (RHIDP-16017) |
| Community frontend packages       | bundle-layout validation only                                                    |

**This is breadth, not depth.** Frontend plugins get no UI render — that is RHIDP-16009,
blocked on RHIDP-15082. The layout check stays because it costs nothing extra (the install
already produces it) and it is the only automated detector of a half-migrated frontend
plugin: it fails a present-but-incomplete layout even when the other system's layout is
valid.

#### Frontend-system migration panel

Every run records which system each frontend bundle ships (`frontend.bundles[].systems`),
and `yarn aggregate` rolls that up into legacy-only / new-frontend-system-only / dual
counts. Run on a schedule, that gives the NFS migration a continuously refreshed view
across the community frontend packages — data the migration has no other automated source
for today.

**Read the new-frontend-system count with its qualifier.** `systems` gains
`new-frontend-system` from the presence of `dist/mf-manifest.json` — module-federation
_layout_, which RHDH also uses to ship legacy Scalprum plugins — so on its own it
overstates. Beside the counts the panel prints a `nfsSupport` split, also recorded per
package in `aggregate.json`:

|                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed`    | the remote is servable and exposes an NFS entry point it declares                                                                                                                                                                                                                                                                                                                                                                                              |
| `undetermined` | no `backstage.features` was read, so `nfsModuleFilter` installs no filter, every exposed module is advertised, and the host decides at runtime — not knowable without executing the bundle. Two causes, and the count does not separate them: the package declares none, or reading it failed. `mf.nfsFeaturesError` in `aggregate.json` tells them apart, and the per-package prose stays silent on a read failure rather than reporting it as declaring none |
| `none`         | unservable, or it declares entry points the remote never exposes                                                                                                                                                                                                                                                                                                                                                                                               |

Quote `confirmed` as migration progress. The 2026-08-21 community sweep was 46 dual, of
which 19 confirmed and 27 undetermined — and ten of those 27 expose an `alpha` module, so
calling them legacy would be as wrong as calling them migrated. Before reading an
`undetermined` count as "declares nothing", check `nfsFeaturesError` on those packages:
any that failed to read are "we could not look", which is a different problem.

#### Tracked exclusions

`plugin-sweep-excludes.txt` lists packages the sweep skips, following the discipline of
RHDH's `e2e-tests/local-harness/plugin-sanity-excludes.txt` (PR #4967): **every entry
carries a `TODO(TICKET)`, and a pattern with no ticket is a parse error.** The goal is to
delete entries, not accumulate them.

Two scopes, because collapsing them would throw away coverage that costs nothing:

- `install` — the artifact is not pulled at all. Loses everything.
- `boot` — the artifact **is** pulled and layout-validated; the plugin is just not loaded
  into `startTestBackend`. Loses only the boot signal.

Patterns match the npm package name, and see through the dynamic export's `-dynamic`
suffix so one pattern is valid at both scopes (metadata says `@scope/plugin-a`, the
installed `package.json` says `@scope/plugin-a-dynamic`).

### Test config (parity with the Docker smoke)

Workspaces that ship `smoke-tests/app-config.test.yaml` and/or `smoke-tests/test.env`
(consumed by the Docker smoke as an extra `--config` mount and `docker run --env-file`)
are supported via two optional flags:

```bash
yarn smoke --dynamic-plugins dp.yaml \
  --app-config ../workspaces/<name>/smoke-tests/app-config.test.yaml \
  --test-env   ../workspaces/<name>/smoke-tests/test.env
```

- `--test-env`: `KEY=VALUE` lines loaded into the process env. Variables already set
  (e.g. real CI secrets) win over the committed placeholders. (Named `--test-env`
  because Node claims `--env-file` for itself even after the script path.)
- `--app-config`: extra app-config layer, deep-merged over the harness's built-in dummy
  config (the file wins). `${VAR}` / `${VAR:-default}` are substituted from the env with
  the Backstage config loader's semantics: `$$` escapes to a literal `$`, and a value
  referencing an unset variable with no default is dropped (with a warning), not
  replaced by an empty string.

`yarn test` runs the unit tests (`node:test` over `src/*.test.ts` — workspace and
support-level resolution, shard planning, exclusion parsing, path containment, report
schema guards, config merging, aggregation and Markdown rendering, env/app-config
substitution, frontend bundle matrix); `yarn check` runs `tsc --noEmit` + lint +
prettier + the tests.

The two CLIs keep their logic in `src/sweep-plan.ts` and `src/aggregate-report.ts`
rather than beside their entry points: a module ending in `process.exit(main())` cannot
be imported by a test, so anything living there is untestable by construction. This is a standalone tool dir, not a
`workspaces/*/e2e-tests` one, so it is outside `e2e-code-quality.yaml` (which only scans
`workspaces/*/e2e-tests/**`).

### CI

`.github/workflows/native-smoke.yaml` runs the harness two ways:

- **`pull_request`** (paths `smoke-tests-native/**`): validates the harness itself on every
  change here, against a known-good pure-backend plugin.
- **`workflow_dispatch`**: Actions → "Native Smoke Harness" → Run workflow, with an optional
  `plugin_ref` (single ref) or `workspace` (all of a workspace's published plugins)
  to validate on demand.

It installs skopeo, builds, runs `yarn smoke`, uploads `results.json`, and fails the job on
a non-passing plugin.

`.github/workflows/community-plugin-sweep.yaml` runs the sweep daily at 03:00 UTC (and on
demand, with a `support` / `shards` choice). Three jobs: `plan` resolves the shard matrix
from metadata and pulls nothing, `sweep` runs the shards with `fail-fast: false` so one bad
plugin cannot hide the verdict on the rest, and `aggregate` merges the shard summaries into
one step summary — it runs unless the run was cancelled (`!cancelled()`), since the aggregate report is
most useful exactly when shards failed — but a cancelled sweep is not a failed one.

Exit code `0` = pass; non-zero with `results.json` detailing `fail-load` / `fail-start` /
`fail-bundle`.

## Best fit (from the 64-workspace analysis, RHIDP-15076)

Of the 12 pure-backend workspaces, validated empirically:

- **Covered now (4)**: `mcp-integrations` (3 plugins boot together), `github-notifications`,
  `scaffolder-backend-module-{servicenow,sonarqube}` — load + backend start via their
  published OCI refs.
- **Catalog-gated (6)**: `3scale, ai-integrations, apiconnect, keycloak, pingidentity,
scaffolder-relation-processor` — blocked by the upstream catalog-backend boot issue
  (see the caveat at the bottom); they stay on the Docker smoke for now.
- **No published OCI artifact (2)**: `scaffolder-backend-module-{kubernetes,regex}` —
  their released `dynamicArtifact` is a local `./dynamic-plugins/dist/…` path (plugin
  ships inside the RHDH image), so there is nothing for this harness to pull.

Beyond those:

- **32 smoke-tests** → replace the Docker container with this harness (backend start +
  frontend bundle/registration check).
- **24 UI e2e-tests** → NOT this harness; need the NFS/app-next render harness.

## Status of validation

- ✅ Install CLI interface confirmed: `@red-hat-developer-hub/cli-module-install-dynamic-plugins@0.3.0`
  (`install <dynamic-plugins-root>`), fetchable via `npx`.
- ✅ Harness logic ported from the **already-green** RHDH nightly test (PR #4967).
- ✅ Builds clean (esbuild → `dist/native-smoke.mjs`, run with plain `node`); `tsc --noEmit` passes.
- ✅ `patchModuleResolution()` ported (`src/module-resolution.ts`) so extracted plugins
  resolve their `@backstage/*` peers against this harness's `node_modules`. Requires a
  node-modules linker — see `.yarnrc.yml`.
- ✅ End-to-end run done locally (Node 24) against a real catalog-index plugin: `pass`,
  backend loaded 1/1, `startTestBackend` booted — see the Benchmark section below.

## Module resolution

Extracted plugins live under a temp dir with no `node_modules` of their own, so their bare
`@backstage/*` imports must resolve against this harness. `patchModuleResolution()` (ported
from RHDH PR #4967) extends `Module._nodeModulePaths` to append `HARNESS_NODE_MODULES`
before any plugin is `require`d. This is why the package uses `nodeLinker: node-modules`
(`.yarnrc.yml`) rather than Yarn PnP — the patch needs a real `node_modules` directory to
point at.

## Benchmark: native vs Docker (real run)

Same plugin both ways: `roadiehq-scaffolder-backend-module-http-request`
(`bs_1.49.4__5.6.0`), from the real catalog index
`quay.io/rhdh-community/plugin-catalog-index:1.11-bs_1.49.4`. Same minimal app-config
(sqlite `:memory:` + guest). Node 24. The RHDH base image (`quay.io/rhdh-community/rhdh:next`,
6.55 GB) was pre-pulled and is excluded from the Docker timing (one-time infra, amortized
across all workspaces in a CI run).

| Approach                                            | What it does                                                                                                                          | Wall-clock               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Native (this harness)**                           | skopeo pull plugin → load → `startTestBackend` boot                                                                                   | **5 s cold, 3–4 s warm** |
| **Docker smoke** (`run-workspace-smoke-tests.yaml`) | container start → in-container `install-dynamic-plugins` (pulls same plugin) → full `node packages/backend` boot → `/healthcheck` 200 | **104 s**                |

Roughly **20× faster cold, ~25–35× warm.** Both confirm the plugin loads; the Docker run
additionally boots the entire RHDH backend (that extra work is exactly the overhead the
in-process approach removes). Note the comparison is per-workspace — the Docker smoke boots
one container per workspace, which is the unit this harness replaces.

Caveat: the native harness currently boots a minimal backend scoped to the plugin's needs
(e.g. scaffolder for scaffolder modules). Catalog-extending modules need the catalog core,
which does not yet boot cleanly standalone — see the coreFeatures note in `src/native-smoke.ts`.
