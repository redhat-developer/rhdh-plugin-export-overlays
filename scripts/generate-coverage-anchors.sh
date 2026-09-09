#!/usr/bin/env bash
#
# Generate the Codecov anchor files for a workspace.
#
# Usage:
#   ./scripts/generate-coverage-anchors.sh <workspace-name>
#
# Why this exists:
#   E2E coverage is uploaded to this repo's Codecov project (see
#   upload-coverage.sh), but Codecov only keeps report entries whose paths
#   exist in the repo's git tree at the uploaded commit — anything else is
#   dropped at processing time (errorCode REPORT_EMPTY when nothing matches).
#   The plugins' real sources live in the upstream repo, so remap-coverage.cjs
#   concatenates each plugin's coverage onto a single committed ANCHOR file:
#
#     workspaces/<workspace>/coverage-anchors/<webpack-remote>
#
#   Codecov validates the path's existence but not its content or length, so
#   the anchors are empty and STATIC: they never need regenerating when the
#   workspace's repo-ref is bumped. Re-run this script only when a NEW plugin
#   gains a metadata Package entity (the remap warns when a covered plugin has
#   no anchor). Idempotent — regenerates the anchor set from scratch.
#
#   An anchor is named after a webpack remote — the name that keys the coverage
#   source maps. A plugin gets one anchor per remote it can publish under,
#   because the two builds that can serve it name that remote differently; see
#   scripts/print-plugin-remotes.sh for the derivation and why emitting only one
#   silently cost app-defaults every byte of its coverage.
#
# Requires: gh (authenticated), jq

set -euo pipefail

WORKSPACE="${1:?Usage: $0 <workspace-name>}"

# The name is interpolated into paths that get wiped and regenerated — reject
# anything that could escape workspaces/<name>/.
if [[ "$WORKSPACE" == */* || "$WORKSPACE" == .* ]]; then
  echo "ERROR: invalid workspace name '$WORKSPACE'" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$REPO_ROOT/workspaces/$WORKSPACE"

for f in source.json plugins-list.yaml; do
  if [[ ! -f "$WORKSPACE_DIR/$f" ]]; then
    echo "ERROR: $WORKSPACE_DIR/$f not found" >&2
    exit 1
  fi
done

REPO_URL=$(jq -r '.repo // empty' "$WORKSPACE_DIR/source.json")
REPO_REF=$(jq -r '.["repo-ref"] // empty' "$WORKSPACE_DIR/source.json")
REPO_FLAT=$(jq -r '.["repo-flat"] // false' "$WORKSPACE_DIR/source.json")
SLUG=$(echo "$REPO_URL" | sed 's|https://github.com/||; s|\.git$||')

if [[ -z "$SLUG" || -z "$REPO_REF" ]]; then
  echo "ERROR: could not read repo/repo-ref from source.json" >&2
  exit 1
fi

# Plugins live at the repo root when repo-flat, otherwise inside the source
# repo's workspace directory (same name as the overlay workspace by convention).
if [[ "$REPO_FLAT" == "true" ]]; then
  SRC_PREFIX=""
else
  SRC_PREFIX="workspaces/$WORKSPACE/"
fi

# Only deployed plugins (those with a metadata Package entity) produce
# coverage — skip the rest to keep the anchor set minimal.
DEPLOYED_PACKAGES=$(grep -rh "packageName:" "$WORKSPACE_DIR/metadata/" 2>/dev/null \
  | sed 's/.*packageName:[[:space:]]*//; s/"//g; s/'"'"'//g' | sort -u)
if [[ -z "$DEPLOYED_PACKAGES" ]]; then
  echo "ERROR: no packageName found in $WORKSPACE_DIR/metadata/" >&2
  exit 1
fi

OUT_ROOT="$WORKSPACE_DIR/coverage-anchors"
rm -rf "$OUT_ROOT"
mkdir -p "$OUT_ROOT"

echo "=== Generating coverage anchor files ==="
echo "  Workspace: $WORKSPACE"
echo "  Source:    $SLUG @ $REPO_REF"
echo "  Output:    $OUT_ROOT"

GENERATED=0
# Which plugin claimed each anchor name, so a second plugin deriving the same one
# is reported rather than silently skipped. Declared associative: without this
# bash treats the subscript as arithmetic and every key collapses onto index 0.
declare -A ANCHOR_OWNER=()

# plugins-list.yaml keys are plugin paths relative to the source workspace
# (e.g. `plugins/theme:`), optionally with export args as values. Quotes are
# stripped in case a key is ever quoted YAML.
while IFS= read -r plugin_path; do
  PKG_JSON=$(gh api "repos/$SLUG/contents/${SRC_PREFIX}${plugin_path}/package.json?ref=$REPO_REF" \
    -H "Accept: application/vnd.github.raw" 2>/dev/null) || {
    echo "  [WARN] $plugin_path: no package.json at ref — skipping" >&2
    continue
  }
  PKG_NAME=$(echo "$PKG_JSON" | jq -r '.name // empty')

  if ! grep -qxF "$PKG_NAME" <<<"$DEPLOYED_PACKAGES"; then
    echo "  [SKIP] $plugin_path ($PKG_NAME): no metadata Package entity (not deployed)"
    continue
  fi

  # A plugin can reach the browser through either of two builds, which name the
  # webpack remote differently, and which one serves it is not visible from
  # here. Both names get an anchor; they are empty files, so covering both costs
  # nothing. See scripts/print-plugin-remotes.sh for the derivation and why emitting
  # only one silently cost app-defaults every byte of its coverage.
  DECLARED_NAME=$(echo "$PKG_JSON" | jq -r '.scalprum.name // empty')

  # Command substitution, not `< <(...)`: process substitution discards the
  # helper's exit status even under `set -e`, so a failing derivation would
  # produce no anchors, no warning and a green run — the silent drop this whole
  # change exists to remove.
  REMOTES=$("$SCRIPT_DIR/print-plugin-remotes.sh" "$PKG_NAME" "$DECLARED_NAME")

  while IFS= read -r anchor; do
    if [[ -e "$OUT_ROOT/$anchor" ]]; then
      # Two causes, and only one is benign. A plugin whose two forms coincide
      # (`foo` derives to `foo` both ways) writes one file and moves on. Two
      # DIFFERENT plugins deriving one name — `@scope/a-b` and `@scope/a_b` both
      # give `scope__a_b` — is a real ambiguity, and swallowing it is how
      # coverage goes missing without anyone noticing.
      if [[ "${ANCHOR_OWNER[$anchor]:-}" != "$plugin_path" ]]; then
        echo "  [WARN] $plugin_path ($PKG_NAME): anchor '$anchor' already claimed by ${ANCHOR_OWNER[$anchor]} — its coverage cannot be told apart" >&2
      fi
      continue
    fi
    : > "$OUT_ROOT/$anchor"
    ANCHOR_OWNER[$anchor]="$plugin_path"
    echo "  [OK]   $plugin_path ($PKG_NAME) -> coverage-anchors/$anchor"
    GENERATED=$((GENERATED + 1))
  done <<<"$REMOTES"
done < <(grep -E '^[^ #].*:' "$WORKSPACE_DIR/plugins-list.yaml" | sed "s/:.*//; s/[\"']//g")

# No per-workspace README is written: the anchor mechanism is documented once
# in this script's header, in codecov.yml, and in the "E2E coverage anchors"
# section of the repository README.

if [[ $GENERATED -eq 0 ]]; then
  echo "ERROR: no anchor file generated" >&2
  exit 1
fi

echo "=== Done: $GENERATED anchor file(s) ==="
