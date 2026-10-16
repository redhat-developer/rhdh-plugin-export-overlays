# close-obsolete-update-prs

Automated queue hygiene tool that scans open pull requests in `rhdh-plugin-export-overlays`
targeting `main`, compares requested plugin versions in `source.json` and package metadata
against upstream releases on `main` and the npm registry using semver, and detects and
closes obsolete update PRs.

Part of **RHIDP-18023** under Epic **RHIDP-17788**.

## Purpose

Automated workflows (`update-plugins-repo-refs.yaml`) periodically open pull requests
to bump upstream plugin repository references from `@backstage`, `@backstage-community`,
and `@red-hat-developer-hub`. When subsequent releases occur upstream, older update PRs can
linger unmerged for months.

These obsolete PRs consume CI runner minutes, trigger notification churn, and clutter
maintainer reviews. This tool identifies and closes them automatically.

## Detection Rules

A PR is identified as obsolete if:

1. It is open and targets `main`.
2. It modifies a workspace's `source.json` and package metadata.
3. It does not modify framework dependencies (`versions.json`).
4. At least one package requested in the PR is strictly older than what is already released
   on `main` in `rhdh-plugin-export-overlays` or published to npm.
5. No package in the PR is strictly newer than what is available upstream.
6. Package renames (e.g. `@red-hat-developer-hub/backstage-plugin-dynamic-home-page` -> `@red-hat-developer-hub/backstage-plugin-homepage`) and workspace renames (e.g. `marketplace` -> `extensions`) are resolved automatically.

If a PR is determined to be obsolete:

- Adds the `superseded` label.
- Posts an explanatory markdown comment with a comparison table linking to newer versions.
- Closes the pull request.
- When `--dry-run` is active, previews the action without modifying GitHub resources.

## Usage

From the `scripts/` directory:

```bash
# Preview closures across all open update PRs targeting main (safe dry-run)
vp exec close-obsolete-update-prs --repo redhat-developer/rhdh-plugin-export-overlays --dry-run

# Evaluate a single PR
vp exec close-obsolete-update-prs --repo redhat-developer/rhdh-plugin-export-overlays --pr 3989 --dry-run

# Live run (closes and labels obsolete PRs)
vp exec close-obsolete-update-prs --repo redhat-developer/rhdh-plugin-export-overlays
```

### Options

| Option                 | Description                                         | Default                        |
| ---------------------- | --------------------------------------------------- | ------------------------------ |
| `--repo <owner/repo>`  | Target GitHub repository                            | `$GITHUB_REPOSITORY`           |
| `--base <branch>`      | Base branch to check PRs for                        | `main`                         |
| `--pr <number>`        | Specific PR number to evaluate                      | (all open candidate PRs)       |
| `--dry-run`            | Preview candidate closures without applying changes | `false`                        |
| `--token <token>`      | GitHub token                                        | `$GITHUB_TOKEN` or `$GH_TOKEN` |
| `--npm-registry <url>` | Custom npm registry URL                             | `https://registry.npmjs.org`   |
| `--verbose`            | Enable verbose diagnostic logging                   | `false`                        |

## Maintaining Workspace & Package Renames

Whenever a workspace directory is renamed or merged under `workspaces/` (e.g. `marketplace` -> `extensions`),
or when an exported package is renamed upstream (e.g. `@red-hat-developer-hub/backstage-plugin-dynamic-home-page` ->
`@red-hat-developer-hub/backstage-plugin-homepage`), add an entry to `WORKSPACE_RENAMES` or `PACKAGE_RENAMES` in
`src/renames.ts`.

This enables the detector to correlate older update PRs referencing the legacy workspace or package
names with their modern counterparts on `main` and npm.
