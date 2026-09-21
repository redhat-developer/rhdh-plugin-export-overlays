[![Target Backstage Compatibility Badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fredhat-developer%2Frhdh-plugin-export-overlays%2Frefs%2Fheads%2Fmetadata%2Fincompatible-workspaces.json&style=flat&cacheSeconds=60)](https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki/Backstage-Compatibility-Report)

[![Publish Images Badge](https://img.shields.io/github/actions/workflow/status/redhat-developer/rhdh-plugin-export-overlays/publish-workspace-plugins.yaml?branch=main&event=push&label=Publish%20RHDH%20Next%20Release%20Dynamic%20Plugin%20Images)](https://github.com/redhat-developer/rhdh-plugin-export-overlays/actions/workflows/publish-workspace-plugins.yaml?query=event%3Apush)

## What is the rhdh-plugin-export-overlays repository?

The `rhdh-plugin-export-overlays` repository serves as a metadata and automation hub for managing dynamic plugins for Red Hat Developer Hub (RHDH).

This repository:

- References a wide range of Backstage plugins that can or should be published as dynamic plugins for use in RHDH.

- Tracks plugin versions to ensure compatibility with the 2 latest RHDH releases, as well as the upcoming RHDH release.

- Defines how to drive, customize, and automate the publishing process.

Additionally, it contains workflows to:

- Discover eligible Backstage plugins.

- Package them as OCI images for use as dynamic plugins.

- Publish these images to the GitHub Container Registry for easy integration with RHDH.

## Branching Strategy and Repository Structure

The content in this repository is structured by workspaces and branches to manage plugins across different RHDH releases effectively.

### Workspaces

Each plugin set is organized in a dedicated folder that represents a workspace—typically aligned with a monorepo hosted in a third-party GitHub repository (e.g., `@backstage-community`, `@roadiehq`, `@red-hat-developer-hub`).

### Branching

- **`main` branch**: This is the primary development branch where all new workspaces and plugins are introduced. It hosts upcoming changes and is tied to the next RHDH release. All pull requests for adding new plugins must target `main`.

- **Release branches (`release-x.y`)**: These are long-running branches, each corresponding to a specific RHDH release (e.g., `release-1.6`).
  - They are created from `main` when a new RHDH release is released (or about to be released).
  - After creation, they only receive pull requests for updates to existing plugins. No new workspace will be automatically added to a release branch.

## Backstage Compatibility

Ensuring plugin compatibility with the version of Backstage bundled in RHDH is crucial. This repository has automated checks and processes for this.

### Target Backstage Compatibility Check

A automated check runs, both in the main branch and in PRs, to verify if a set of mandatory plugins have backstage versions compatible with the target Backstage version (used in RHDH). This check acts as a gate for creating new release branches. A new `release-x.y` branch can only be created if all mandatory plugins are compatible with the target Backstage version for that RHDH release.

The compatibility status is displayed by the badge at the top of this README.

### Best-Effort Version Matching

When searching for plugin versions compatible with the target Backstage version, the automation isn't strictly limited to the exact Backstage version (e.g. `1.39.0` for a `1.39.1` target backstage version). It performs a best-effort search to find the closest compatible version (newest plugin version available that is less than or equal to the target Backstage version), which could still be `1.38.0` for a `1.39.1` target backstage version.

However, best-effort backstage version matches involve some risk. When a pull request is created with a plugin version that isn't a perfect match for the target Backstage version, a comment is automatically added to the PR. This comment details the potential risks and the requirement to deeply test the plugin with the target backstage version, providing precise case-by-case guidance.

## How to use the workflows in this repository to create OCI images for your plugins

### 1. Create or look for a Pull Request for your plugins

A GitHub workflow runs **daily on the `main` branch** to automatically update existing workspaces and discover new plugins.

The workflow operates in two complementary modes:

1. **Overlay-first package enumeration** — All existing workspaces are enumerated directly from the overlay repository. Their source repos are scanned to discover plugin package names, regardless of npm scope. Published versions are then fetched from npm (`npm view`) and checked for Backstage compatibility. This means plugins outside the auto-discovery scopes (e.g., `@immobiliarelabs/`, `@pagerduty/`) are updated automatically once their workspace exists.

2. **npm search discovery** — Plugins under the auto-discovery scopes (`@backstage-community`, `@red-hat-developer-hub`, `@roadiehq`) are also discovered via `npm search` to detect newly-published packages of workspaces not yet in the overlay. New workspaces can be proposed on `main`.

> **Release branches (`release-x.y`)** do not have scheduled automatic updates. To update a workspace on a release branch, trigger the workflow manually with `workspace-path` and `single-branch`.

If you can't find a PR for your plugin, you can manually trigger one as explained below.

#### Create a PR using the "Update plugins repository references" workflow

> [!IMPORTANT]
> Write access to this repository is required to run this workflow.

- Navigate to https://github.com/redhat-developer/rhdh-plugin-export-overlays/actions/workflows/update-plugins-repo-refs.yaml
- For "use workflow from" select `main`.
- To **update an existing workspace**, use "workspace-path" (e.g., `workspaces/gitlab`). This works for any workspace regardless of npm scope.
- To **add a new workspace**, use "regexps" with `allow-workspace-addition` enabled. Specify the regular expression or single-quoted literal package name matching the plugins you want to add. For example, to add all RBAC plugins, the regexp would be `@backstage-community/plugin-rbac`.
- For "single-branch", specify the branch you want to update. If you want to add a new workspace, you would enter `main`. 
- Running the workflow will generate PRs against the single branch you specified.

### Manually Creating a PR

You can also create PRs manually. For adding a **new workspace**, your PR should target the `main` branch.

To add a new workspace with plugins:

1. Create a new workspace in the overlay repository.
2. Add a `plugins-list.yaml` file that lists all plugins included in the target workspace of the source repository. ([See example](./workspaces/adoption-insights/plugins-list.yaml))
3. Add a `source.json` file with the following fields ([See example](./workspaces/adoption-insights/source.json)):
   - `repo`: URL of the source repository (only `https://github.com/xxx` URLs are supported for now)
   - `repo-ref`: Specific tag or commit for the target plugin/workspace version
   - `repo-flat`:
     - `false` if the plugins are inside a workspace (e.g., `backstage/community-plugins`)
     - `true` if the plugins are at the root level (e.g., `backstage/backstage`)
   - `repo-backstage-version`: The backstage version of the source repository. This is used to check if the plugin is compatible with the target backstage version.

### 2. Add a CODEOWNERS Entry

Add an entry for your new workspace in [`.github/CODEOWNERS`](./.github/CODEOWNERS) so that pull requests touching the workspace require review from the right team or individuals. The list is alphabetically ordered.

```
/workspaces/<name>                                                      @your-team @your-username
```

### 3. Add Additional Dynamic Plugin Export Information (If Needed)

Sometimes, additional configuration is required in the PR:

- **Frontend plugins** may need:
   - `app-config.dynamic.yaml` (Eg: [techdocs plugin](./workspaces/backstage/plugins/techdocs/app-config.dynamic.yaml))
   - `scalprum-config.json` (Eg: [api-docs-module-protoc-gen-doc plugin](./workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/scalprum-config.json))

- **Any plugin** may need:
   - Overlay source files in an `overlay` directory
  (e.g., [`api-docs-module-protoc-gen-doc`](./workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/overlay))
  - Patches (`*.patch`) in the `patches` directory of the workspace folder, to modify the workspace source code before the whole build and packaging process. (Example: [roadie backstage plugins](./workspaces/roadie-backstage-plugins/patches/1-avoid-double-wildcards.patch))

> **Overlay vs. Patch**
> - **Overlay**: Replaces or adds entire files during the packaging process.
> - **Patch**: Applies precise, line-by-line changes to existing source files.


To add this additional configuration (excluding the patches, since the patch files are placed and applied at the workspace [monorepo] level):
- Create a `plugins/` folder within the appropriate `workspace/`
- Inside `plugins/`, create one folder per plugin you wish to enhance with additional information

### 4. Test the OCI image against an RHDH instance

Plugin testing can be performed automatically via CI workflows or manually in your own RHDH environment.

#### Automatic Testing

The repository includes an automated smoke testing workflow that verifies plugins load correctly in RHDH.

**Prerequisites:**
- PR must touch exactly one workspace
- At least one published plugin in the workspace must have runnable metadata in `workspaces/<modified_workspace>/metadata/`
- Published plugins without runnable metadata are skipped individually

**Triggering smoke tests:**
- After `/publish`: Smoke tests run automatically upon successful publish completion
- Manual testing: Use one of these comments on the PR to rerun smoke tests using the latest published artifacts:
  - `/smoketest` (default image derived from PR target branch)
  - `/smoketest <tag>` (uses `quay.io/rhdh-community/rhdh:<tag>`)
    - Allowed tags: `pr-4907`, `pr-4929-90eff067`, `next`, `next-1.10-244a2755`, `next-8a0d43e7`
  - A previous successful `/publish` run is required

**Smoke testing workflow steps:**
1. **Resolve metadata**: Retrieves published OCI references and PR metadata from the `published-exports` artifact
2. **Prepare test config**: Generates `dynamic-plugins.test.yaml` from any runnable plugin metadata it finds (each plugin's `spec.appConfigExamples[0].content` is placed under `pluginConfig`) and copies other configuration files - base (`smoke-tests/app-config.yaml` and workspace-specific `app-config.test.yaml` app-config and `test.env`). Published plugins without runnable metadata are skipped; if none are runnable, smoke tests are skipped. Each generated `package` line uses `oci://…/image:<tag>` only (no `!package-id` suffix). If a published export tag still includes a legacy `!<plugin reference>` suffix matching the normalized `spec.packageName` (scope stripped, `/` → `-`), the workflow removes that suffix before writing the file.
3. **Run smoke tests**: Starts RHDH container with layered configuration, installs dynamic plugins from OCI artifacts, and verifies each plugin included in the generated config loads successfully
4. **Report results**: Posts test status as a commit status check and PR comment with pass/fail results and links to the workflow run

**Environment Variables in Smoke Tests:**
If your plugin configuration (in `metadata/*.yaml`) uses environment variables (e.g., `${API_TOKEN}`), you must provide them in a `test.env` file located at `workspaces/<workspace>/smoke-tests/test.env`.
- If the `test.env` file is missing but required, smoke tests are skipped.
- If the `test.env` file exists but is missing variables, the workflow fails.

- **Results** are reported via PR comment and in the status check. The complete container logs are also available, in the `smoke-tests/run` step.

#### Overriding Backstage Compatibility

When a workspace's upstream Backstage version (in `source.json`) differs from the RHDH target version (in `versions.json`), you need to override the compatibility before publishing. Comment on your PR:

```
/override-backstage
```

This creates `backstage.json` with the target version and updates all metadata OCI tags to match. After the override completes, run `/publish` to build the images.

#### Manual Testing

- To trigger a build of the OCI image for the plugins in a PR, comment: `/publish`.
- This runs a GitHub workflow to build and publish **test OCI artifacts**. A bot will comment with the generated OCI image references, tagged as `pr_<pr_number>__<plugin_version>`, and may also include a list of plugins for which the generation failed.
- Use these OCI references to manually test the plugins in your own RHDH instance.
- If you cannot test the generated images immediately, a good practice is to label the PR with `help wanted to test`.

#### Once Testing Is Complete:
- If the plugin works with RHDH (either via automatic or manual testing), **change the label** to `tested`
- Once the PR is merged, the final OCI artifact will be published with the tag: `bs_<backstage_version>__<plugin_version>`

## E2E coverage anchors

Workspaces with E2E tests collect Istanbul coverage from the instrumented plugin running inside RHDH. That coverage reaches this repository's Codecov project (one `e2e-<workspace>` flag per workspace) through a committed snapshot that is seeded to `main` — not by uploading directly from the PR e2e run (see below).

Each `workspaces/<workspace>/coverage-anchors/` directory holds empty, static files named after the webpack remotes a deployed plugin can publish under — one per plugin for each of the two builds that can serve it, since Scalprum and Module Federation name the remote differently and which one RHDH loads is not visible from the manifest. Codecov only keeps coverage for paths that exist in this repository's git tree, but the plugins' real sources live upstream — so `scripts/remap-coverage.cjs` concatenates each plugin's coverage onto its anchor (line ranges shifted; the aggregated percentage is preserved exactly). Only the path's existence matters; file content and length are never validated.

These anchors never change with plugin versions. Regenerate them only when a new plugin gains a metadata `Package` entity:

```bash
./scripts/generate-coverage-anchors.sh <workspace>
```

See `scripts/generate-coverage-anchors.sh` and `codecov.yml` for the full mechanism.

### Populating the `main` branch

Coverage is produced only by the Prow PR e2e jobs — they deploy the instrumented `__coverage` plugin images that `/publish` builds. Those jobs emit per-test coverage **as run artifacts**; they do not upload to Codecov directly. (A PR-head upload would be pointless anyway: squash-merge creates a fresh `main` commit the upload never reaches, and Codecov's carryforward can't cross the squash.)

Instead, coverage reaches the dashboard through `main`: `coverage-snapshots/<workspace>.lcov` holds the latest captured coverage for each rolled-out workspace, and `.github/workflows/seed-coverage-main.yaml` uploads them to the current `main` commit (via the Codecov CLI `--sha`), one `e2e-<workspace>` flag each (every 6h, on snapshot change, or manually). This is the **only** path that uploads to *this repository's* Codecov project, so the dashboard only ever reflects `main` — no orphan flags on PR-head commits. (A workspace whose sources live in a repo with its own Codecov project can additionally be published there, per file — see below.)

**A red seed run means a flag is stale.** Uploading is that job's only purpose, so it runs strict: if any workspace fails to reach Codecov — a failed upload or a missing token — the run goes red instead of leaving a carried-forward number behind a green check. Uploads retry once, so a red run means a real outage rather than a blip. Re-running the workflow is the fix.

**Snapshots refresh themselves.** When the e2e bot reports a passed run on a PR, `.github/workflows/refresh-coverage-snapshot.yaml` regenerates that workspace's snapshot from the run's coverage artifacts and commits it back to the PR. On merge, the seed picks it up — so the dashboard tracks every workspace change with no manual step, including the daily upstream repo-ref bumps (`update-plugins-repo-refs.yaml`) that re-run e2e when plugin code changes upstream. One intrinsic limit: coverage only exists after an e2e actually runs on the cluster, so a workspace's number updates when its e2e is triggered (`/test e2e-ocp-helm`) — the refresh then happens automatically.

**Fork PRs need the second path.** That per-PR refresh checks out the PR head and pushes the snapshot back to it, so it skips forks outright — neither is safe or possible against a fork. Measured on 2026-08-05, 16 of 37 recent merged PRs touching a workspace came from forks: their e2e ran, coverage was collected, and the result was discarded while the flag kept publishing an older number. `.github/workflows/refresh-stale-coverage-snapshots.yaml` closes that. It runs daily, uses `scripts/find-stale-snapshots.sh` to find snapshots that no longer match their workspace, refreshes each from the most recent **merged** PR's coverage artifacts, and opens a single PR. Merged-only is deliberate: coverage from an unmerged PR describes code nobody accepted. It never checks out a fork and never pushes to one — every script runs from `main`'s own checkout.

Not every workspace can be refreshed this way. A backend-only workspace produces no browser coverage at all and is excluded by construction, and a run whose instrumented bundle tripped the zip-bomb guard in `instrument-plugin.sh` yields no coverage JSONs — the refresh treats both as a no-op rather than a failure.

To refresh a snapshot by hand (e.g. from a run the workflow didn't pick up):

```bash
# point at the run's gcsweb .../artifacts/e2e-test-results/coverage/ directory
./scripts/refresh-coverage-snapshot.sh <workspace> <coverage-dir-or-gcsweb-url>
git add coverage-snapshots/<workspace>.lcov
```

A snapshot's number only moves when it's refreshed — which is also the only time the coverage itself changes, since a workspace's coverage is fixed until its plugin code changes (and code changes come through PRs that re-run e2e). This keeps the dashboard effectively current without a separate coverage run: the nightly stays entirely on the shipped `{{inherit}}`/Konflux builds and is not involved in coverage.

### Publishing the same coverage upstream, per file

The anchor keeps the percentage and loses the detail: you cannot click into a plugin and see which files are untested, because the sources are not in this repository. `scripts/upload-coverage-upstream.sh` publishes the *same* measurements to the repository the sources actually live in, where Codecov resolves every path and the report becomes browsable file by file. This **complements** the anchor path and never replaces it — most workspaces have nowhere else to publish, and are skipped with a message rather than an error.

```bash
# a local coverage dir, or the run's gcsweb .../artifacts/e2e-test-results/coverage/
./scripts/upload-coverage-upstream.sh <workspace> <coverage-dir-or-gcsweb-url> --dry-run
```

`.github/workflows/publish-coverage-upstream.yaml` runs it from CI, on every push to `main` that touches a workspace. It resolves the merged PR, reads the e2e bot's PASSING comment, and takes the artifact URL from the build-log link already in that comment — the same place `refresh-stale-coverage-snapshots.yaml` reads it from. Only a passing run publishes, and a run whose comment predates the merged commit is skipped rather than attributed to a tree it never measured. `workflow_dispatch` is kept for backfilling a specific run by hand.

The input is the run's **raw** coverage JSONs, which live in that Prow run's artifacts. It cannot read `coverage-snapshots/<ws>.lcov`, which is already anchor-mapped down to a single entry.

After each upload the script checks that the session it just sent is on the commit, through the uploads endpoint — which paginates. Codecov accepts an upload and returns before processing it, so "queued for processing" is a receipt rather than a result, and without this check a run could publish nothing and still report success. An unconfirmed upload is raised as a run annotation, never a failure: a slow processing queue is not a failed publish.

A landed upload is still not a *visible* one. A Codecov admin can delete a flag, and the deletion is soft: uploads keep being accepted, the coverage stays in the report, and the REST listing the session check reads still returns the flag — only the UI hides it, because the GraphQL resolver behind every UI surface filters deleted flags while the REST one does not. So the script also asks the GraphQL endpoint, once per run, whether the flag is actually in the list the dashboard renders. That is how `e2e-orchestrator` was found: two green publishes, coverage present on `main` HEAD, and absent from the flag picker for four days. Also a run annotation, for the same reason — a deleted flag needs a Codecov admin, not a red merge.

Five things make this work, each of which is easy to get wrong:

- **The upload must run from a checkout of the target repo at the pinned ref.** The Codecov CLI builds the file network it sends from the git repo in the *current working directory* and resolves report paths against it; `--slug` and `--sha` do not change that. Uploading from this checkout sends this repo's file list and the report is rejected as `REPORT_EMPTY` even though every path is valid upstream. The script does the shallow clone for you.
- **Coverage is uploaded twice: to the pinned `repo-ref` and to the source repo's default-branch HEAD.** The pinned ref is what the tested plugin was built from, so it is the exactly-attributed copy — but a report on a historical commit is never reachable from the default branch. Carryforward inherits from the parent commit's finalised report, and every commit between the pinned ref and now was finalised without the flag. Measured 2026-08-10: `e2e-orchestrator` has a report at its pinned ref and `files=0` on all ~30 `main` commits processed *after* that upload landed, while the unit-test flag carries forward normally on those same commits. The HEAD copy is the one anyone sees.
- **The HEAD copy trades exactness for visibility.** It attributes coverage to code that has drifted since the measurement, because Codecov matches by path plus line number and does not rebase. Measured across the workspaces: 0–14% of files had shifted lines, and the share does not track the pinned ref's age — churn does, so `adoption-insights` at 9.6 days drifted 0% while `intelligent-assistant` at 10.1 days drifted 14%. Use `--pinned-only` to publish just the exact copy; note that it is then visible nowhere.
- **Only repos with an active Codecov project are eligible** — today just `redhat-developer/rhdh-plugins`, which covers 11 of the workspaces that have E2E tests.
- **The flag is `e2e-<workspace>`, except where Codecov has deleted that name.** Deleting a flag is a soft delete with no inverse: the API exposes `deleteFlag` and nothing that undoes it, and the name cannot be reused. The data is not lost — it stays in the report and in the v2 REST flag listing — but every UI surface hides it, because the GraphQL resolver behind them filters `deleted__isnot=True` while REST does not. That is why `e2e-orchestrator` published green twice (2026-08-13 and 2026-08-17) with 142 files at `main` HEAD and was still absent from the dashboard's flag picker. `upstream_flag_for()` in the script holds the replacements. Each one wants a matching `flag_management.individual_flags` entry in the destination repo's `codecov.yml` — without it the flag still publishes, it just falls back to `default_rules` and loses the path scoping every other `e2e-*` flag has, so land the upstream entry first rather than registering an unscoped flag on a project we do not administer. Orchestrator's is `redhat-developer/rhdh-plugins#4436`. The visibility check above is what confirms a replacement worked: the first publish under the new name either reports the flag visible, or says it is not — which for a name that has never existed means the upstream entry is still missing rather than that anything was deleted. Note the scope: flags are per project, and this repo's own `e2e-orchestrator` is healthy — do not mirror a replacement into `scripts/upload-coverage.sh` or `scripts/seed-main-coverage.sh`.

Resolution is by unique suffix match against the pinned ref's tree. Several plugins in one workspace ship the same relative path — `src/index.ts`, `src/plugin.ts`, `src/api/index.ts` — so a name alone is not always enough. The tie is broken by the plugin the coverage came from: every entry carries its webpack remote, and each plugin declares that remote in its own `package.json` (`scalprum.name`), so the remap maps remote to plugin directory against the checkout and prefers that plugin's copy. A unique workspace-wide match still wins outright, which is what keeps a sibling package's file (`<pkg>-common/src/x.ts`) resolving even though it sits outside the owning plugin.

The owner is not only a tie-break. A single match is accepted only when the owning plugin could legitimately have produced it — its own copy, or a path that names the package it lives in. A bare `src/x.ts` resolving into a sibling package means the owner does not ship that file at this ref, and taking it would write one plugin's coverage onto another plugin's file with real line numbers. Anything else is dropped rather than guessed, under three distinguishable reasons: `not-in-tree` points at the pinned ref, `not-in-owner` at a moved or newly added file, `ambiguous` at plugins sharing a name with no owner to settle it. Measured after the tie-break, both published workspaces drop nothing: `intelligent-assistant` resolves 105 of 105 and `adoption-insights` 45 of 45.

That tie-break is not cosmetic. Before it, `adoption-insights` lost `src/api/index.ts` (48 of 55 lines covered) to a clash with `analytics-module-adoption-insights`, and the plugin repo's `codecov.yml` deliberately keeps nested `index.ts` under `api/` in the denominator — so unlike the `src/index.ts` and `src/plugin.ts` cases, that one was a real loss rather than a file that would have been ignored anyway.

The remap prints what it dropped and warns when the share of lost lines exceeds the usual wiring-file noise.

Verified end to end on 2026-08-10 with the Prow run of PR #3200: 103 files resolved, and `e2e-intelligent-assistant` went from `files=0` to `files=99` at `rhdh-plugins` `main` HEAD — browsable per file, with that commit's own coverage moving 58.52 → 58.74. (103 becomes 99 because Codecov then applies the plugin repo's `ignore:` rules.)

**This needs its own secret.** Codecov upload tokens are per project, so the workflow reads `CODECOV_RHDH_PLUGINS_TOKEN` — not the `CODECOV_TOKEN` the anchor path uses, which belongs to this repository's own project. Its value is the same one `redhat-developer/rhdh-plugins` already holds as its `CODECOV_TOKEN`; it has to be copied here because GitHub secrets do not cross repositories. The secret is named for the project rather than for "upstream" because a Codecov token authorises exactly one destination, and a generic name would suggest it covers more. Without it the job fails fast rather than uploading nothing behind a green check.
