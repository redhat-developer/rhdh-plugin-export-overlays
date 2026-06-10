#!/usr/bin/env bash
#
# Generate the Codecov placeholder source tree for a workspace.
#
# Usage:
#   ./scripts/generate-coverage-sources.sh <workspace-name>
#
# Why this exists:
#   E2E coverage is uploaded to this repo's Codecov project (see
#   upload-coverage.sh), but Codecov only keeps report entries whose paths
#   exist in the repo's git tree at the uploaded commit — anything else is
#   dropped at processing time (errorCode REPORT_EMPTY when nothing matches).
#   The plugins' real sources live in the upstream repo, so this script
#   mirrors each deployed plugin's `src/` file tree as EMPTY placeholder
#   files under:
#
#     workspaces/<workspace>/coverage-sources/<scalprum-name>/src/...
#
#   remap-coverage.cjs emits lcov paths pointing at this tree (keyed by the
#   webpack remote, which is the plugin's scalprum name), so Codecov can
#   resolve every file and compute the per-flag percentage. File CONTENT is
#   irrelevant to the percentage — only the path needs to exist — hence
#   empty files.
#
#   Run this whenever a workspace's repo-ref changes (the file tree must
#   match the built plugin version). Intended to be wired into the
#   version-bump automation; safe to run manually at any time (idempotent:
#   regenerates the tree from scratch).
#
# Requires: gh (authenticated), jq

set -euo pipefail

WORKSPACE="${1:?Usage: $0 <workspace-name>}"
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
# coverage — skip the rest to keep the placeholder tree minimal.
DEPLOYED_PACKAGES=$(grep -rh "packageName:" "$WORKSPACE_DIR/metadata/" 2>/dev/null \
  | sed 's/.*packageName:[[:space:]]*//; s/"//g; s/'"'"'//g' | sort -u)
if [[ -z "$DEPLOYED_PACKAGES" ]]; then
  echo "ERROR: no packageName found in $WORKSPACE_DIR/metadata/" >&2
  exit 1
fi

OUT_ROOT="$WORKSPACE_DIR/coverage-sources"
rm -rf "$OUT_ROOT"
mkdir -p "$OUT_ROOT"

echo "=== Generating coverage placeholder tree ==="
echo "  Workspace: $WORKSPACE"
echo "  Source:    $SLUG @ $REPO_REF"
echo "  Output:    $OUT_ROOT"

TOTAL_FILES=0
GENERATED_PLUGINS=0

# plugins-list.yaml keys are plugin paths relative to the source workspace
# (e.g. `plugins/theme:`), optionally with export args as values.
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

  # The webpack remote in the coverage source maps is the plugin's scalprum
  # name: explicit `scalprum.name`, or the default `<scope>.<name>` derived
  # from the package name.
  SCALPRUM_NAME=$(echo "$PKG_JSON" | jq -r '.scalprum.name // empty')
  if [[ -z "$SCALPRUM_NAME" ]]; then
    SCALPRUM_NAME=$(echo "$PKG_NAME" | sed 's|^@||; s|/|.|')
  fi

  # Mirror the plugin's src/ tree (code files only) as empty files.
  FILES=$(gh api "repos/$SLUG/git/trees/$REPO_REF:${SRC_PREFIX}${plugin_path}/src?recursive=1" \
    --jq '.tree[] | select(.type=="blob") | .path' 2>/dev/null \
    | grep -E '\.[cm]?[jt]sx?$' || true)
  if [[ -z "$FILES" ]]; then
    echo "  [WARN] $plugin_path ($PKG_NAME): no src/ code files found — skipping" >&2
    continue
  fi

  COUNT=0
  while IFS= read -r rel; do
    DEST="$OUT_ROOT/$SCALPRUM_NAME/src/$rel"
    mkdir -p "$(dirname "$DEST")"
    : > "$DEST"
    COUNT=$((COUNT + 1))
  done <<<"$FILES"

  echo "  [OK]   $plugin_path ($PKG_NAME) -> coverage-sources/$SCALPRUM_NAME ($COUNT files)"
  TOTAL_FILES=$((TOTAL_FILES + COUNT))
  GENERATED_PLUGINS=$((GENERATED_PLUGINS + 1))
done < <(grep -E '^[^ #].*:' "$WORKSPACE_DIR/plugins-list.yaml" | sed 's/:.*//')

cat > "$OUT_ROOT/README.md" <<EOF
# Coverage placeholder tree (auto-generated — do not edit)

Empty files mirroring each deployed plugin's \`src/\` tree in the upstream
source repo ($SLUG @ $REPO_REF). Codecov only keeps coverage for paths that
exist in this repo's git tree, and the E2E lcov produced by
\`scripts/remap-coverage.cjs\` points here. Content is intentionally empty —
only the paths matter for the per-flag coverage percentage.

Regenerate after a repo-ref bump:

\`\`\`bash
./scripts/generate-coverage-sources.sh $WORKSPACE
\`\`\`
EOF

if [[ $GENERATED_PLUGINS -eq 0 ]]; then
  echo "ERROR: no plugin produced a placeholder tree" >&2
  exit 1
fi

echo "=== Done: $GENERATED_PLUGINS plugin(s), $TOTAL_FILES placeholder file(s) ==="
