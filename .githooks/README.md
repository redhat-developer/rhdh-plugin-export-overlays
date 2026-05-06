# Git Hooks

This directory contains git hooks that run the same code quality checks as CI.

## Setup

Run once after cloning:

```bash
git config core.hooksPath .githooks
```

## Available Hooks

### pre-commit

Runs **ESLint**, **Prettier**, and **TypeScript** checks on staged `workspaces/*/e2e-tests/**` files. Uses the same shared script as the [E2E Code Quality](../.github/workflows/e2e-code-quality.yaml) CI workflow.

- Auto-fixes ESLint and Prettier issues and re-stages the fixed files
- Stashes unstaged changes before running fixers, restoring them after — this protects partially staged files from being fully staged
- TypeScript type-checking runs in check-only mode (no auto-fix available)
- Only triggers when e2e-tests files are staged (zero overhead otherwise)
- Automatically installs dependencies via `yarn install --immutable`
- Skip with `git commit --no-verify` for WIP commits

## Combining with Your Own Hooks

Setting `core.hooksPath` overrides the default hook directory. The repo hook handles this automatically — after its own checks pass, it chains to your existing pre-commit hook by checking (in order):

1. **Global `core.hooksPath`** — if you have `git config --global core.hooksPath` set (e.g., `~/.config/git/hooks/`), that directory's `pre-commit` is executed
2. **`.git/hooks/pre-commit`** — the default per-repo hook location

If you prefer to keep your own hook directory as primary instead, source the repo hook from your pre-commit:

```bash
# Run repo e2e code quality checks
REPO_HOOK="$(git rev-parse --show-toplevel)/.githooks/pre-commit"
if [[ -x "$REPO_HOOK" ]]; then
  "$REPO_HOOK"
fi
```
