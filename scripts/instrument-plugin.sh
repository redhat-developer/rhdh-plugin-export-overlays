#!/usr/bin/env bash
#
# Instrument a production dynamic plugin OCI image with Istanbul coverage.
#
# Instead of rebuilding the plugin from source (which diverges from production),
# this script pulls the already-published production image, extracts the JS
# bundles, instruments them with nyc, and commits a new coverage image.
# This guarantees that the instrumented code is identical to what ships.
#
# Usage:
#   ./scripts/instrument-plugin.sh <source-image> <coverage-image> <plugin-path>
#
# Arguments:
#   source-image   — production OCI image ref (e.g., ghcr.io/.../plugin:tag)
#   coverage-image — output image ref with -coverage suffix
#   plugin-path    — top-level directory inside the image (e.g., backstage-community-plugin-tech-radar)
#
# Example:
#   ./scripts/instrument-plugin.sh \
#     ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-tech-radar:bs_1.49.4__1.5.0 \
#     ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-community-plugin-tech-radar-coverage:bs_1.49.4__1.5.0 \
#     backstage-community-plugin-tech-radar
#
# Requires: podman, npx (nyc)

set -euo pipefail

SOURCE_IMAGE="${1:?Usage: $0 <source-image> <coverage-image> <plugin-path>}"
COVERAGE_IMAGE="${2:?Usage: $0 <source-image> <coverage-image> <plugin-path>}"
PLUGIN_PATH="${3:?Usage: $0 <source-image> <coverage-image> <plugin-path>}"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "=== Instrumenting production image for E2E coverage ==="
echo "  Source:      $SOURCE_IMAGE"
echo "  Coverage:    $COVERAGE_IMAGE"
echo "  Plugin path: $PLUGIN_PATH"

# Step 1: Pull production image
echo ""
echo "--- Step 1: Pulling production image ---"
podman pull "$SOURCE_IMAGE"

# Step 2: Create container (not started) and extract JS bundles
echo ""
echo "--- Step 2: Extracting JS bundles ---"
CID=$(podman create "$SOURCE_IMAGE")

podman cp "$CID:$PLUGIN_PATH/dist" "$WORK_DIR/dist-original"
echo "  Extracted dist/ from $PLUGIN_PATH/dist"

# Step 3: Instrument with nyc
echo ""
echo "--- Step 3: Instrumenting with nyc ---"
npx --yes nyc instrument "$WORK_DIR/dist-original" "$WORK_DIR/dist-instrumented" --source-map 2>&1 | tail -5

# Step 4: Copy instrumented files back and commit
echo ""
echo "--- Step 4: Committing coverage image ---"
podman cp "$WORK_DIR/dist-instrumented/." "$CID:$PLUGIN_PATH/dist/"
podman commit "$CID" "$COVERAGE_IMAGE"
podman rm "$CID"

# Step 5: Verify instrumentation
echo ""
echo "--- Verification ---"
INSTRUMENTED_FILES=$(grep -r "__coverage__" "$WORK_DIR/dist-instrumented/" --include="*.js" -l 2>/dev/null | wc -l | tr -d ' ')
if [[ "$INSTRUMENTED_FILES" -gt 0 ]]; then
  echo "  Istanbul instrumentation: $INSTRUMENTED_FILES JS files contain __coverage__"

  WEBPACK_SRCS=$(grep -roh 'webpack://[^"]*\./src/[^"]*' "$WORK_DIR/dist-instrumented/" --include="*.map" 2>/dev/null | sort -u)
  SRC_COUNT=$(echo "$WEBPACK_SRCS" | grep -c . 2>/dev/null || echo "0")
  echo "  Source map references: $SRC_COUNT original source files"
  if [[ "$SRC_COUNT" -gt 0 ]]; then
    echo ""
    echo "  Source files covered:"
    echo "$WEBPACK_SRCS" | sed 's|webpack://[^/]*/||' | head -20
  fi
else
  echo "  WARNING: No __coverage__ found — nyc instrument may have failed" >&2
  exit 1
fi

echo ""
echo "=== Done ==="
echo "  Coverage image ready: $COVERAGE_IMAGE"
echo "  Push with: podman push $COVERAGE_IMAGE"
