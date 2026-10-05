# Managing E2E Secrets

Start with the [upstream Secrets API documentation](https://redhat-developer.github.io/rhdh-e2e-test-utils/api/secrets.html) for authentication, CLI usage, and secret lifecycle operations. This guide describes the collection, naming conventions, and test entry points used by this repository.

## Repository Collection and Secret Names

Use the collection ID `rhdh-plugin-export-overlays`. The repository's [e2e-secrets.profile.json](https://github.com/redhat-developer/rhdh-plugin-export-overlays/blob/main/e2e-secrets.profile.json) selects secrets by these paths:

| Secret path | Loaded for | Environment variable |
|-------------|------------|----------------------|
| `global/VAULT_<NAME>` | Every secrets-enabled test run | `VAULT_<NAME>` |
| `workspaces/<workspace>/VAULT_<NAME>` | Runs selecting that workspace | `VAULT_<NAME>` |

Keep the `VAULT_` prefix and the environment-variable spelling expected by the workspace's tests and configuration. Names without the `VAULT_` prefix after the path prefix are ignored. Global and selected workspace secrets must map to distinct environment variables; duplicate names cause a collision rather than overriding one another.

The workspace selector is already templated in the profile, so adding a secret under an existing workspace path does not require a profile change. Workspace secrets are optional; a workspace with no matching secrets can use the global secrets alone. The profile contains selectors, not secret values.

## Running Tests with Secrets

Complete the [upstream local-command prerequisites](https://redhat-developer.github.io/rhdh-e2e-test-utils/api/secrets.html#local-command) and the usual E2E cluster setup before running tests.

From the repository root:

```bash
./run-e2e.sh --secrets -w backstage
./run-e2e.sh --secrets -w backstage -w quay
```

Use `-w` to select which workspace secrets are loaded. Without `-w`, the runner selects all workspaces with E2E tests. Playwright options such as `--project` filter tests but do not narrow the secret selection.

For a single workspace with its dependencies installed:

```bash
yarn --cwd workspaces/backstage/e2e-tests test:secrets
```

Both entry points use the shared profile and the `rhdh-e2e-secrets` executable supplied by the workspace's `@red-hat-developer-hub/e2e-test-utils` dependency. Additional Playwright arguments can be appended to either command.

## Creating, Rotating, and Removing Secrets

Follow the [upstream mutation procedures](https://redhat-developer.github.io/rhdh-e2e-test-utils/api/secrets.html#mutations), using `--collection rhdh-plugin-export-overlays` and a secret path from the table above. The shared tool manages the paired Bitwarden and Google Secret Manager values.

For the provider-specific steps, use the upstream instructions for:

- [Google Secret Manager authentication](https://redhat-developer.github.io/rhdh-e2e-test-utils/api/secrets.html#gsm-authentication).
- [Listing paths and inspecting metadata](https://redhat-developer.github.io/rhdh-e2e-test-utils/api/secrets.html#gsm-read-commands).
- [Temporary secret files and cleanup](https://redhat-developer.github.io/rhdh-e2e-test-utils/api/secrets.html#temporary-secret-files).

## CI Compatibility

The `VAULT_*` names are the existing environment-variable contract used by the workspace tests and configuration. Local secrets-enabled runs populate those variables from Bitwarden; CI continues to inject them through its existing secret configuration.

Use the environment-based execution provided by the repository's scripts, since the workspace consumers read `VAULT_*` variables. For a newly required secret, use the same variable name in the secret path, workspace configuration, and CI secret mapping.
