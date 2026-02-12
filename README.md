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

GitHub workflows runs **daily** to automatically generate or update PRs for plugins under the following scopes: `@backstage-community`, `@red-hat-developer-hub` and `@roadiehq`. These PRs are created **per workspace, per release branch** for plugin updates.

- When run on release branches, the workflow will only create PRs that propose updates to existing workspaces.
- When run on the `main` branch, the workflow will also create PRs that add newly-discovered workspaces.

If you can't find a PR for your plugin, you can manually trigger one as explained below.

#### Create a PR using the "Update plugins repository references" workflow

> [!IMPORTANT]
> Write access to this repository is required to run this workflow.

- Navigate to https://github.com/redhat-developer/rhdh-plugin-export-overlays/actions/workflows/update-plugins-repo-refs.yaml
- For "use workflow from" select `main`.
- For "regexps", specify the regular expression matching the plugins you want to package. For example, to package all RBAC plugins, the regexp would be "@backstage-community/plugin-rbac".
- For "single-branch", specify the branch you want to update. if you want to add a new workspace, you would enter `main`. 
- Running the workflow will generate PRs against the single branch you specified.

### Manually Creating a PR

You can also create PRs manually. For adding a **new workspace**, your PR should target the `main` branch.

To add a new workspace with plugins:

1. Create a new workspace in the overlay repository.
2. Add a `plugins-list.yaml` file that lists all plugins included in the target workspace of the source repository. ([See example](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/main/workspaces/adoption-insights/plugins-list.yaml))
3. Add a `source.json` file with the following fields ([See example](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/main/workspaces/adoption-insights/source.json)):
   - `repo`: URL of the source repository (only `https://github.com/xxx` URLs are supported for now)
   - `repo-ref`: Specific tag or commit for the target plugin/workspace version
   - `repo-flat`:
     - `false` if the plugins are inside a workspace (e.g., `backstage/community-plugins`)
     - `true` if the plugins are at the root level (e.g., `backstage/backstage`)
   - `repo-backstage-version`: The backstage version of the source repository. This is used to check if the plugin is compatible with the target backstage version.

### 2. Add Additional Dynamic Plugin Export Information (If Needed)

Sometimes, additional configuration is required in the PR:

- **Frontend plugins** may need:
   - `app-config.dynamic.yaml` (Eg: [techdocs plugin](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/release-1.5/workspaces/backstage/plugins/techdocs/app-config.dynamic.yaml))
   - `scalprum-config.json` (Eg: [api-docs-module-protoc-gen-doc plugin](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/release-1.5/workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/scalprum-config.json))

- **Any plugin** may need:
   - Overlay source files in an `overlay` directory
  (e.g., [`api-docs-module-protoc-gen-doc`](https://github.com/redhat-developer/rhdh-plugin-export-overlays/tree/release-1.5/workspaces/backstage/plugins/api-docs-module-protoc-gen-doc/overlay))
  - Patches (`*.patch`) in the `patches` directory of the workspace folder, to modify the workspace source code before the whole build and packaging process. (Example: [roadie backstage plugins](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/150c9d98830039315df6b4f23bf9f85b1cf5ae55/workspaces/roadie-backstage-plugins/patches/1-avoid-double-wildcards.patch))

> **Overlay vs. Patch**
> - **Overlay**: Replaces or adds entire files during the packaging process.
> - **Patch**: Applies precise, line-by-line changes to existing source files.


To add this additional configuration (excluding the patches, since the patch files are placed and applied at the workspace [monorepo] level):
- Create a `plugins/` folder within the appropriate `workspace/`
- Inside `plugins/`, create one folder per plugin you wish to enhance with additional information

### 3. Test the OCI image against an RHDH instance

Plugin testing can be performed automatically via CI workflows or manually in your own RHDH environment.

#### Automatic Testing

The repository includes an automated integration testing workflow that verifies plugins load correctly in RHDH.

**Prerequisites:**
- PR must touch exactly one workspace
- Each plugin must have its own metadata file in `workspaces/<modified_workspace>/metadata/`

**Triggering smoke tests:**
- After `/publish`: Smoke tests run automatically upon successful publish completion
- Manual testing: Use `/smoketest` comment on the PR to rerun the smoke tests using the latest published artifacts
  - For `/smoketest` command, a previous successful `/publish` run is required

**Smoke testing workflow steps:**
1. **Resolve metadata**: Retrieves published OCI references and PR metadata from the `published-exports` artifact
2. **Prepare test config**: Generates `dynamic-plugins.test.yaml` from plugin metadata and copies other configuration files (`smoke-tests/app-config.yaml`, workspace-specific `app-config.test.yaml` and `test.env`)
3. **Run smoke tests**: Starts RHDH container with layered configuration, installs dynamic plugins from OCI artifacts, and verifies each plugin loads successfully
4. **Report results**: Posts test status as a commit status check and PR comment with pass/fail results and links to the workflow run

**Environment Variables in Smoke Tests:**
If your plugin configuration (in `metadata/*.yaml`) uses environment variables (e.g., `${API_TOKEN}`), you must provide them in a `test.env` file located at `workspaces/<workspace>/smoke-tests/test.env`.
- If the `.env` file is missing but required, smoke tests are skipped.
- If the `.env` file exists but is missing variables, the workflow fails.

- **Results** are reported via PR comment and in the status check. The complete container logs are also available, in the `smoke-tests/run` step.

#### Manual Testing

- To trigger a build of the OCI image for the plugins in a PR, comment: `/publish`.
- This runs a GitHub workflow to build and publish **test OCI artifacts**. A bot will comment with the generated OCI image references, tagged as `pr_<pr_number>__<plugin_version>`, and may also include a list of plugins for which the generation failed.
- Use these OCI references to manually test the plugins in your own RHDH instance.
- If you cannot test the generated images immediately, a good practice is to label the PR with `help wanted to test`.

#### Once Testing Is Complete:
- If the plugin works with RHDH (either via automatic or manual testing), **change the label** to `tested`
- Once the PR is merged, the final OCI artifact will be published with the tag: `bs_<backstage_version>__<plugin_version>`
