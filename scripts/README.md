# Scripts

Shared tooling for this repository: TypeScript CLIs that validate and maintain
plugin metadata, plus older Python, shell, and Node helpers that have not moved
into workspaces yet.

The TypeScript CLIs live in Yarn workspaces and use [Vite+](https://viteplus.dev/).

## Workspaces

| Workspace                                                         | Description                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`validate-app-config-examples`](./validate-app-config-examples/) | Validates Package metadata appConfigExamples: structural checks (RHIDP-12590) plus semantic validation against each plugin's published config schema (RHIDP-13509). |

## Development

Install the `vp` CLI from the [Vite+ guide](https://viteplus.dev/guide#install-vp-globally);
it can download the Node.js and Yarn versions this directory expects. Then, from
here:

```bash
vp install   # install dependencies (via Yarn)
vp check     # format, lint, and type-check
vp test      # workspace unit tests
```

Run a workspace CLI after install:

```bash
vp exec <workspace-name> --help
```

See each workspace README for CLI-specific flags and behavior.
