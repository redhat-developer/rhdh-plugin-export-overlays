#!/usr/bin/env bash
#
# Print every webpack remote a plugin can publish under, one per line.
#
# Usage:
#   ./scripts/print-plugin-remotes.sh <package-name> [declared-scalprum-name]
#
# A plugin reaches the browser through one of two builds, and they name the
# remote differently:
#
#   Scalprum (`dist-scalprum/`) uses the name as written — the declared
#     `scalprum.name`, or `<scope>.<name>` derived from the package.
#   Module Federation (`dist/`) needs a valid JS identifier, so it sanitises:
#     `@` dropped, `/` -> `__`, `-` -> `_`.
#
# Which build serves a given plugin is not visible from its manifest —
# app-defaults and adoption-insights have identical-looking ones and land on
# opposite sides — so both names are printed and both get an anchor.
#
# Its own script so the derivation has ONE definition on the shell side and can
# be checked against remotesOf() in scripts/upstream-paths.cjs, which derives the
# same pair for the upstream tie-break. An anchor name is the key
# findAnchorWorkspace matches, so the two must agree — see
# scripts/tests/test_plugin_remotes.py.

set -euo pipefail

PACKAGE_NAME="${1:?Usage: $0 <package-name> [declared-scalprum-name]}"
DECLARED_NAME="${2:-}"

UNSCOPED="${PACKAGE_NAME#@}"

# The declared name replaces the derived scalprum form, not the MF one: MF
# sanitises the package name whatever the manifest says.
if [[ -n "$DECLARED_NAME" ]]; then
  printf '%s\n' "$DECLARED_NAME"
else
  printf '%s\n' "${UNSCOPED//\//.}"
fi

MF_NAME="${UNSCOPED//\//__}"
printf '%s\n' "${MF_NAME//-/_}"
