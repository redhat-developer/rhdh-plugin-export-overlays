#!/usr/bin/env bash
#
# Instrument frontend plugin OCI images with Istanbul coverage.
#
# Usage:
#   echo "image1\nimage2" | ./scripts/instrument-plugin.sh <workspace-path>
#   ./scripts/instrument-plugin.sh <workspace-path> < images.txt
#
# Example:
#   echo "ghcr.io/repo/plugin:pr_123__1.0.0" | ./scripts/instrument-plugin.sh workspaces/tech-radar
#
# The script:
#   1. Reads OCI image refs from stdin (one per line)
#   2. For each frontend plugin image:
#      - Pulls the production image
#      - Extracts plugin path from OCI labels (io.backstage.dynamic-packages)
#      - Extracts plugin bundle from the container
#      - Instruments JavaScript with nyc (Istanbul)
#      - Builds a new coverage image with instrumented files
#      - Pushes the coverage image with __coverage tag suffix

set -euo pipefail

WORKSPACE="${1:?Usage: $0 <workspace-path>}"

if [[ ! -d "$WORKSPACE" ]]; then
  echo "ERROR: Workspace directory not found: $WORKSPACE" >&2
  exit 1
fi

if [[ ! -d "$WORKSPACE/metadata" ]]; then
  echo "ERROR: No metadata directory found in workspace: $WORKSPACE/metadata" >&2
  exit 1
fi

echo "=== Instrumenting published plugin images for E2E coverage ==="
echo "Workspace: $WORKSPACE"
echo ""

INSTRUMENTED_COUNT=0
SKIPPED_COUNT=0

# Process each published image (format: plain image refs, one per line)
while IFS= read -r PROD_IMAGE; do
  [[ -z "$PROD_IMAGE" ]] && continue

  echo "--- Processing: $PROD_IMAGE ---"

  # Extract plugin name from image ref
  PLUGIN_NAME=$(basename "${PROD_IMAGE%%:*}")
  echo "  Plugin: $PLUGIN_NAME"

  # Find metadata file for this plugin
  # The metadata filename matches the OCI image name (e.g., backstage-community-plugin-acs.yaml)
  METADATA_FILE="${WORKSPACE}/metadata/${PLUGIN_NAME}.yaml"

  if [[ ! -f "$METADATA_FILE" ]]; then
    echo "  ⚠️  No metadata file found at $METADATA_FILE - skipping"
    ((SKIPPED_COUNT++))
    continue
  fi

  # Check if this is a frontend plugin (only frontend plugins need instrumentation)
  PLUGIN_ROLE=$(yq -r '.spec.backstage.role // ""' "$METADATA_FILE")
  if [[ "$PLUGIN_ROLE" != "frontend-plugin" ]]; then
    echo "  Skipping $PLUGIN_ROLE (only frontend plugins need browser coverage)"
    ((SKIPPED_COUNT++))
    continue
  fi

  # Pull production image first (needed to inspect labels)
  if ! podman pull "$PROD_IMAGE" 2>&1 | grep -v "WARNING: image platform"; then
    echo "  ❌ Failed to pull image - skipping"
    ((SKIPPED_COUNT++))
    continue
  fi

  # Extract plugin path from OCI image labels (preferred method)
  # The io.backstage.dynamic-packages label contains base64-encoded JSON
  # with plugin metadata including the directory path inside the container
  PACKAGES_LABEL=$(podman inspect "$PROD_IMAGE" --format '{{index .Labels "io.backstage.dynamic-packages"}}' 2>/dev/null || echo "")

  PLUGIN_PATH=""
  if [[ -n "$PACKAGES_LABEL" && "$PACKAGES_LABEL" != "<no value>" ]]; then
    # Decode base64 and extract first plugin name
    # Expected JSON: [{"name":"backstage-community-plugin-acs","version":"0.2.0",...}]
    # The "name" field is the directory path inside the container
    PLUGIN_PATH=$(echo "$PACKAGES_LABEL" | base64 -d 2>/dev/null | jq -r '.[0].name // empty' 2>/dev/null || echo "")
    if [[ -n "$PLUGIN_PATH" ]]; then
      echo "  Plugin path (from OCI label): $PLUGIN_PATH"
    fi
  fi

  # Fallback: Extract from dynamicArtifact in metadata if label doesn't exist
  if [[ -z "$PLUGIN_PATH" ]]; then
    echo "  No io.backstage.dynamic-packages label - using metadata fallback"
    DYNAMIC_ARTIFACT=$(yq -r '.spec.dynamicArtifact // ""' "$METADATA_FILE")

    # Format: "oci://image:tag!path" or "oci://image:tag"
    if [[ "$DYNAMIC_ARTIFACT" =~ !(.+)$ ]]; then
      PLUGIN_PATH="${BASH_REMATCH[1]}"
      echo "  Plugin path (from metadata): $PLUGIN_PATH"
    else
      # No explicit path — use plugin name as path
      PLUGIN_PATH="$PLUGIN_NAME"
      echo "  Plugin path (default): $PLUGIN_PATH"
    fi
  fi

  if [[ -z "$PLUGIN_PATH" ]]; then
    echo "  ⚠️  Could not determine plugin path - skipping"
    ((SKIPPED_COUNT++))
    continue
  fi

  # Create temp container and extract plugin bundle
  WORK_DIR=$(mktemp -d)
  CID=$(podman create "$PROD_IMAGE")

  if ! podman cp "$CID:$PLUGIN_PATH/dist" "$WORK_DIR/dist-original"; then
    echo "  ❌ Failed to extract plugin bundle from container - skipping"
    podman rm "$CID" || true
    rm -rf "$WORK_DIR"
    ((SKIPPED_COUNT++))
    continue
  fi

  podman rm "$CID"

  # Instrument with nyc (pinned version for reproducibility)
  # Must run from work directory to avoid "outside project root" errors
  echo "  Instrumenting with Istanbul/nyc..."
  if ! (cd "$WORK_DIR" && npx --yes nyc@15.1.0 instrument dist-original dist-instrumented --source-map); then
    echo "  ❌ Instrumentation failed - skipping"
    rm -rf "$WORK_DIR"
    ((SKIPPED_COUNT++))
    continue
  fi

  # Verify instrumentation
  JS_COUNT=$(grep -r "__coverage__" "$WORK_DIR/dist-instrumented/" --include="*.js" -l 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$JS_COUNT" -eq 0 ]]; then
    echo "  ❌ No __coverage__ found in instrumented files - skipping"
    rm -rf "$WORK_DIR"
    ((SKIPPED_COUNT++))
    continue
  fi
  echo "  ✓ Instrumented $JS_COUNT JS files"

  # Build coverage image (copy instrumented files over production image)
  cat > "$WORK_DIR/Containerfile" <<EOF
FROM $PROD_IMAGE
COPY dist-instrumented/ $PLUGIN_PATH/dist/
EOF

  # Generate coverage image tag: append __coverage suffix to tag
  # Example: plugin:pr_123__1.2.3 → plugin:pr_123__1.2.3__coverage
  IMAGE_BASE="${PROD_IMAGE%:*}"
  IMAGE_TAG="${PROD_IMAGE##*:}"
  COVERAGE_IMAGE="${IMAGE_BASE}:${IMAGE_TAG}__coverage"

  if ! podman build -t "$COVERAGE_IMAGE" -f "$WORK_DIR/Containerfile" "$WORK_DIR"; then
    echo "  ❌ Failed to build coverage image - skipping"
    rm -rf "$WORK_DIR"
    ((SKIPPED_COUNT++))
    continue
  fi

  # Push coverage image
  if ! podman push "$COVERAGE_IMAGE"; then
    echo "  ❌ Failed to push coverage image"
    rm -rf "$WORK_DIR"
    ((SKIPPED_COUNT++))
    continue
  fi

  echo "  ✓ Published: $COVERAGE_IMAGE"

  # Cleanup
  rm -rf "$WORK_DIR"
  echo ""

  ((INSTRUMENTED_COUNT++))

done

echo "=== Instrumentation complete ==="
echo "  Instrumented: $INSTRUMENTED_COUNT plugins"
echo "  Skipped:      $SKIPPED_COUNT plugins"

if [[ $INSTRUMENTED_COUNT -eq 0 ]]; then
  echo ""
  echo "[WARN] No plugins were instrumented"
  echo "[INFO] This may be expected if there are no frontend plugins in this workspace"
fi
