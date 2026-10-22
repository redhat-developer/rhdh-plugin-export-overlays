# Code Quality

Conventions for shell and Python in this repo's scripts, so code stays clean under ShellCheck and SonarCloud while authoring, not after CI. Migrated from the former `.cursor/rules/` — apply them in any harness.

## Shell conventions (ShellCheck)

Follow ShellCheck when generating or editing shell scripts. Prefer patterns that keep `shellcheck` clean locally (`shellcheck path/to/script.sh`).

## Required habits

- Quote expansions: `"$var"`, `"${array[@]}"`, not bare `$var` in paths/args.
- Prefer `[[ ]]` over `[ ]` for bash tests.
- Use `readarray`/`mapfile` or `while IFS= read -r` instead of unquoted `for f in $(...)`.
- Declare locals: `local var` inside functions; avoid leaking globals.
- Check command success explicitly when ignoring failure is intentional: `cmd || true` with a brief comment why.
- Prefer `printf` over `echo -e` when portability or escape clarity matters; if using `echo -e`, keep it intentional.
- For associative arrays / arrays, initialize before use: `declare -A map=()` / `declare -a list=()`.
- Avoid `cd` without checking: `cd dir || exit 1` (or return in functions).
- Do not disable ShellCheck broadly; use `# shellcheck disable=SCxxxx` only for a single justified line.

## Common rules to satisfy up front

- SC2086: quote variables
- SC2155: separate declare and assign when capturing `$(...)` exit status matters
- SC2207 / SC2044: avoid word-splitting from command substitution into arrays
- SC2164: `cd` failure must abort
- SC2034: no unused variables
- SC2154: referenced variables must be assigned

## After writing new shell code

If ShellCheck is available, run it on touched scripts and fix findings before finishing.
---

## Python conventions (SonarCloud)

Write Python that stays clean under common SonarCloud rules (especially maintainability). Prefer fixing smells while authoring, not after CI.

## Duplicated string literals (python:S1192)

If the same non-trivial string literal appears **3+ times**, define a module-level constant and reuse it.

```python
ALL_YAML_FILENAME = "all.yaml"
# ...
if f.name == ALL_YAML_FILENAME:
    continue
path = dir_path / ALL_YAML_FILENAME
```

Short separators (`"/"`, `":"`, `"\n"`) are fine as literals.

## Other high-frequency smells to avoid

- **Unused imports / variables** — do not leave dead code.
- **Cognitive complexity** — extract helpers instead of deeply nested blocks.
- **Identical branches / duplicated blocks** — share a function.
- **Bare `except:`** — catch specific exceptions (or at least `Exception`) and log/re-raise when appropriate.
- **Collapsible ifs** — merge nested `if` when conditions can be combined.
- **Mutable default args** — use `None` then assign inside the function.

## After writing new Python

Prefer running the local unit tests for the touched module. If a Sonar issue is known from a recent PR (e.g. duplicated literals), fix it in the same change.
---
