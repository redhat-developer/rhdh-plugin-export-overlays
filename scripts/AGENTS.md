<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Workspace notes

This directory is the Yarn + Vite+ workspaces root for TypeScript CLIs under
`scripts/`. Install and run tooling from here (`vp install`, `vp check`,
`vp test`, `vp exec`), not from individual workspace directories.

See [README.md](./README.md) for the workspace list and how to invoke each CLI.

Workspaces are pure TypeScript CLIs shipped as source (`bin` points at a `.ts`
entry). Do not add a Vite+ `build` or `dev` step; use `vp check`, `vp test`,
and `vp exec <workspace-name>`.

# Migrating legacy scripts

Root-level Python, shell, and CJS helpers under `scripts/` are being migrated
into TypeScript workspaces. Prefer that shape for new work: a workspace
directory, Yarn workspace entry, and `vp exec`.

If a human asks you to change legacy Python, bash, or CJS that is not yet a
workspace, tell them to follow the boy scout rule: leave the area cleaner than
you found it. When the change is more than a tiny fix, propose porting the tool
to TypeScript as a new workspace (same pattern as
`validate-app-config-examples`) instead of deepening the legacy path. Do not
silently expand Python/shell/CJS; surface the migration option and wait for
direction when the scope is unclear.
