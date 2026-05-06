#!/usr/bin/env bash
#
# Build an Istanbul-instrumented version of a dynamic plugin for E2E coverage collection.
#
# Usage:
#   ./scripts/instrument-plugin.sh <workspace-name> [plugin-name]
#
# Example:
#   ./scripts/instrument-plugin.sh tech-radar
#   ./scripts/instrument-plugin.sh bulk-import backstage-plugin-bulk-import
#
# The script:
#   1. Reads source.json for the upstream repo URL and git ref
#   2. Clones the upstream repo at that ref
#   3. Builds the plugin normally (backstage-cli + janus-cli export-dynamic)
#   4. Post-processes the webpack output with nyc instrument to add Istanbul coverage
#   5. Outputs the instrumented bundle to .instrumented/<workspace>/
#
# The source maps in the webpack output reference original source files (e.g., RadarPage.tsx),
# enabling coverage remapping back to the actual plugin source code.

set -euo pipefail

WORKSPACE="${1:?Usage: $0 <workspace-name> [plugin-name]}"
PLUGIN_NAME="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$REPO_ROOT/workspaces/$WORKSPACE"
OUTPUT_DIR="$REPO_ROOT/.instrumented/$WORKSPACE"
CLONE_DIR="$REPO_ROOT/.instrumented/.sources/$WORKSPACE"

if [[ ! -f "$WORKSPACE_DIR/source.json" ]]; then
  echo "ERROR: $WORKSPACE_DIR/source.json not found" >&2
  exit 1
fi

REPO_URL=$(jq -r '.repo' "$WORKSPACE_DIR/source.json")
REPO_REF=$(jq -r '.["repo-ref"]' "$WORKSPACE_DIR/source.json")
REPO_FLAT=$(jq -r '.["repo-flat"] // false' "$WORKSPACE_DIR/source.json")

echo "=== Instrumenting plugin for workspace: $WORKSPACE ==="
echo "  Upstream repo: $REPO_URL"
echo "  Ref: $REPO_REF"
echo "  Flat repo: $REPO_FLAT"

# Step 1: Clone upstream repo at the exact ref
echo ""
echo "--- Step 1: Cloning upstream repo ---"
rm -rf "$CLONE_DIR"
mkdir -p "$CLONE_DIR"

git clone --depth 1 "$REPO_URL" "$CLONE_DIR" 2>&1 || {
  echo "Shallow clone failed, falling back to full clone" >&2
  rm -rf "$CLONE_DIR"
  git clone "$REPO_URL" "$CLONE_DIR"
}
cd "$CLONE_DIR"
git fetch --depth 1 origin "$REPO_REF" 2>/dev/null || git fetch origin "$REPO_REF"
git checkout "$REPO_REF"

# Step 2: Navigate to the plugin workspace
echo ""
echo "--- Step 2: Finding plugin workspace ---"
if [[ "$REPO_FLAT" == "true" ]]; then
  PLUGIN_WORKSPACE_DIR="$CLONE_DIR"
else
  PLUGIN_WORKSPACE_DIR="$CLONE_DIR/workspaces/$WORKSPACE"
fi

if [[ ! -d "$PLUGIN_WORKSPACE_DIR" ]]; then
  echo "ERROR: Plugin workspace not found at $PLUGIN_WORKSPACE_DIR" >&2
  echo "Available workspaces:" >&2
  ls "$CLONE_DIR/workspaces/" 2>/dev/null || echo "  (none)" >&2
  exit 1
fi

cd "$PLUGIN_WORKSPACE_DIR"
echo "  Plugin workspace: $PLUGIN_WORKSPACE_DIR"

# Step 3: Find the frontend plugin package (first frontend-plugin match wins)
echo ""
echo "--- Step 3: Finding frontend plugin package ---"
if [[ -n "$PLUGIN_NAME" ]]; then
  PLUGIN_PKG_DIR=$(find "$PLUGIN_WORKSPACE_DIR" -name "package.json" -path "*/$PLUGIN_NAME/*" -not -path "*/node_modules/*" | head -1 | xargs dirname)
else
  PLUGIN_PKG_DIR=$(find "$PLUGIN_WORKSPACE_DIR" -name "package.json" -not -path "*/node_modules/*" -not -path "*/e2e-*/*" -not -path "*/backend*/*" -not -path "*/module-*/*" -not -path "$PLUGIN_WORKSPACE_DIR/package.json" | while read -r pkg; do
    if jq -e '.backstage.role == "frontend-plugin"' "$pkg" >/dev/null 2>&1; then
      dirname "$pkg"
      break
    fi
  done)
fi

if [[ -z "$PLUGIN_PKG_DIR" ]]; then
  echo "ERROR: Could not find frontend plugin package" >&2
  echo "Hint: specify the plugin name as the second argument" >&2
  exit 1
fi

echo "  Plugin package: $PLUGIN_PKG_DIR"
PLUGIN_PKG_NAME=$(jq -r '.name' "$PLUGIN_PKG_DIR/package.json")
echo "  Plugin npm name: $PLUGIN_PKG_NAME"

# Step 4: Install dependencies
echo ""
echo "--- Step 4: Installing dependencies ---"
cd "$PLUGIN_WORKSPACE_DIR"

if [[ -f "yarn.lock" ]]; then
  yarn install --no-immutable 2>&1 | tail -5
elif [[ -f "package-lock.json" ]]; then
  npm install 2>&1 | tail -5
fi

# Step 5: Build the plugin (standard build, no instrumentation at this stage)
echo ""
echo "--- Step 5: Building plugin ---"
cd "$PLUGIN_WORKSPACE_DIR"

# Generate TypeScript declarations
npx tsc --build 2>&1 | tail -5 || true

cd "$PLUGIN_PKG_DIR"
if command -v backstage-cli &>/dev/null; then
  backstage-cli package build 2>&1 | tail -5
else
  npx --yes @backstage/cli package build 2>&1 | tail -5
fi

# Step 6: Export as dynamic plugin (webpack + module federation)
echo ""
echo "--- Step 6: Exporting as dynamic plugin ---"
cd "$PLUGIN_PKG_DIR"

if command -v janus-cli &>/dev/null; then
  janus-cli package export-dynamic-plugin 2>&1 | tail -5
elif npx --yes @janus-idp/cli package export-dynamic-plugin --help &>/dev/null 2>&1; then
  npx @janus-idp/cli package export-dynamic-plugin 2>&1 | tail -5
elif npx --yes @red-hat-developer-hub/cli package export-dynamic-plugin --help &>/dev/null 2>&1; then
  npx @red-hat-developer-hub/cli package export-dynamic-plugin 2>&1 | tail -5
else
  echo "ERROR: No dynamic plugin CLI found (janus-cli / @janus-idp/cli / @red-hat-developer-hub/cli)" >&2
  exit 1
fi

# Step 7: Post-process with nyc instrument
# webpack's module federation externalizes shared modules, causing babel-plugin-istanbul
# (applied pre-webpack) to be stripped. Instead, we instrument the FINAL webpack output,
# which contains all the plugin's compiled code in the exposed-PluginRoot chunk.
echo ""
echo "--- Step 7: Instrumenting webpack output with nyc ---"

DIST_SCALPRUM=$(find . -path "*/dist-dynamic/dist-scalprum" -o -path "*/dist-scalprum" | grep -v node_modules | head -1)
if [[ -z "$DIST_SCALPRUM" ]]; then
  echo "ERROR: No dist-scalprum directory found after export" >&2
  exit 1
fi

STATIC_DIR="$DIST_SCALPRUM/static"
if [[ ! -d "$STATIC_DIR" ]]; then
  echo "ERROR: No static/ directory in dist-scalprum" >&2
  exit 1
fi

INSTRUMENTED_STATIC="${STATIC_DIR}-instrumented"
npx --yes nyc instrument "$STATIC_DIR" "$INSTRUMENTED_STATIC" --source-map 2>&1 | tail -3

# Replace original static/ with instrumented version
rm -rf "$STATIC_DIR"
mv "$INSTRUMENTED_STATIC" "$STATIC_DIR"

# Step 8: Copy output
echo ""
echo "--- Step 8: Copying instrumented bundle ---"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp -r "$DIST_SCALPRUM"/* "$OUTPUT_DIR/"

# Also copy package.json for metadata
cp "$PLUGIN_PKG_DIR/package.json" "$OUTPUT_DIR/package.json" 2>/dev/null || true

echo ""
echo "=== Done ==="
echo "  Instrumented bundle: $OUTPUT_DIR/"
echo "  Source repo: $REPO_URL"
echo "  Source ref:  $REPO_REF"

# Verify instrumentation
echo ""
echo "--- Verification ---"
INSTRUMENTED_FILES=$(grep -r "__coverage__" "$OUTPUT_DIR/" --include="*.js" -l 2>/dev/null | wc -l | tr -d ' ')
if [[ "$INSTRUMENTED_FILES" -gt 0 ]]; then
  echo "  Istanbul instrumentation: $INSTRUMENTED_FILES files instrumented"

  WEBPACK_SRCS=$(grep -roh 'webpack://[^"]*\./src/[^"]*' "$OUTPUT_DIR/" --include="*.map" 2>/dev/null | sort -u)
  SRC_FILES=$(echo "$WEBPACK_SRCS" | grep -c . 2>/dev/null || echo "0")
  echo "  Source map references: $SRC_FILES original source files"
  echo ""
  echo "  Source files covered:"
  echo "$WEBPACK_SRCS" | sed 's|webpack://[^/]*/||' | head -20
else
  echo "  WARNING: No __coverage__ instrumentation found!" >&2
  echo "  nyc instrument may have failed." >&2
  exit 1
fi
