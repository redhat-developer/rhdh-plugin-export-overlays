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

# Count *.js files under $2 whose contents match grep pattern $1. The `|| true`
# keeps a no-match grep (exit 1) from tripping set -e / pipefail.
count_files_matching() {
  { grep -rl "$1" "$2" --include="*.js" 2>/dev/null || true; } | wc -l | tr -d ' '
}

# Drop the current plugin's work dir and count it as skipped. Only call this
# after WORK_DIR has been created for the current iteration.
cleanup_and_skip() {
  rm -rf "$WORK_DIR"
  SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
}

# Process each published image (format: plain image refs, one per line)
while IFS= read -r PROD_IMAGE; do
  [[ -z "$PROD_IMAGE" ]] && continue

  echo "--- Processing: $PROD_IMAGE ---"

  # Extract plugin name from image ref
  PLUGIN_NAME=$(basename "${PROD_IMAGE%%:*}")
  echo "  Plugin: $PLUGIN_NAME"

  # Find the metadata file for this plugin by matching its packageName to the
  # image name, NOT by assuming the filename matches the image. The published
  # image name is the packageName with '@' stripped and '/' replaced by '-'
  # (e.g. @red-hat-developer-hub/backstage-plugin-quickstart ->
  # red-hat-developer-hub-backstage-plugin-quickstart). Some workspaces name
  # their metadata files differently (e.g. rhdh-bsp-quickstart.yaml), so a
  # filename-based lookup silently skipped them and never built the __coverage
  # image — the e2e run then failed pulling a manifest that doesn't exist.
  METADATA_FILE=""
  for candidate in "${WORKSPACE}"/metadata/*.yaml; do
    [[ -f "$candidate" ]] || continue
    candidate_pkg=$(yq -r '.spec.packageName // ""' "$candidate")
    [[ -z "$candidate_pkg" ]] && continue
    candidate_image=$(echo "$candidate_pkg" | sed 's|^@||; s|/|-|g')
    if [[ "$candidate_image" == "$PLUGIN_NAME" ]]; then
      METADATA_FILE="$candidate"
      break
    fi
  done

  if [[ -z "$METADATA_FILE" ]]; then
    echo "  ⚠️  No metadata file with packageName matching '$PLUGIN_NAME' in ${WORKSPACE}/metadata/ - skipping"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi
  echo "  Metadata: $METADATA_FILE"

  # Check if this is a frontend plugin (only frontend plugins need instrumentation)
  PLUGIN_ROLE=$(yq -r '.spec.backstage.role // ""' "$METADATA_FILE")
  if [[ "$PLUGIN_ROLE" != "frontend-plugin" ]]; then
    echo "  Skipping $PLUGIN_ROLE (only frontend plugins need browser coverage)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Pull production image first (needed to inspect labels)
  if ! podman pull "$PROD_IMAGE" 2>&1 | grep -v "WARNING: image platform"; then
    echo "  ❌ Failed to pull image - skipping"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Extract plugin path from OCI image labels (preferred method)
  # The io.backstage.dynamic-packages label contains base64-encoded JSON
  # with plugin metadata including the directory path inside the container
  PACKAGES_LABEL=$(podman inspect "$PROD_IMAGE" --format '{{index .Labels "io.backstage.dynamic-packages"}}' 2>/dev/null || echo "")

  PLUGIN_PATH=""
  if [[ -n "$PACKAGES_LABEL" && "$PACKAGES_LABEL" != "<no value>" ]]; then
    # Decode base64 and extract the plugin directory path inside the container.
    # Actual JSON shape: [{"<dir-name>": {"name":"@scope/pkg-dynamic","version":...}}]
    # The directory path is the OBJECT KEY, not a "name" field. (An older `.[0].name`
    # read returned empty and only worked because of the metadata fallback below.)
    # Fall back to `.[0].name` for any legacy flat-shaped labels.
    PLUGIN_PATH=$(echo "$PACKAGES_LABEL" | base64 -d 2>/dev/null | jq -r '.[0] as $p | (if ($p.name | type) == "string" then $p.name else ($p | keys[0]) end) // empty' 2>/dev/null || echo "")
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
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Create temp container to extract the plugin bundle(s)
  WORK_DIR=$(mktemp -d)
  # Plugin images are static bundles with no CMD/ENTRYPOINT, so we provide a dummy command
  CID=$(podman create "$PROD_IMAGE" /bin/true)

  # RHDH ships up to two frontend bundles per plugin and which one it actually
  # serves/executes at runtime depends on the deployment: the Module Federation
  # bundle (`dist/`) for the new frontend system and the Scalprum bundle
  # (`dist-scalprum/`) for the legacy loader. Instrumenting only `dist/` leaves
  # `window.__coverage__` undefined whenever the browser runs the Scalprum bundle,
  # so we instrument every bundle that exists and overlay them all.
  BUNDLE_DIRS=(dist dist-scalprum)
  COPY_LINES=""
  TOTAL_JS_COUNT=0

  for BUNDLE in "${BUNDLE_DIRS[@]}"; do
    # Not every plugin ships every bundle; quietly skip the absent ones.
    if ! podman cp "$CID:$PLUGIN_PATH/$BUNDLE" "$WORK_DIR/orig-$BUNDLE" 2>/dev/null; then
      echo "  No $BUNDLE/ in image - skipping that bundle"
      continue
    fi

    # Instrument with nyc (pinned version for reproducibility).
    # Must run from work directory to avoid "outside project root" errors.
    echo "  Instrumenting $BUNDLE/ with Istanbul/nyc..."
    if ! (cd "$WORK_DIR" && npx --yes nyc@18.0.0 instrument "orig-$BUNDLE" "inst-$BUNDLE" --source-map); then
      echo "  ❌ Instrumentation of $BUNDLE/ failed - skipping that bundle"
      continue
    fi

    # Fix NYC's global access pattern for modern browsers.
    # NYC emits `new Function("return this")()`, which RHDH's CSP (no unsafe-eval)
    # blocks — leaving coverage uncollected. Replace it with `globalThis`.
    # `|| true` so a single sed failure doesn't abort the whole job (set -e); the
    # UNFIXED_COUNT check below still catches any file the fix missed.
    find "$WORK_DIR/inst-$BUNDLE" -name "*.js" -type f -exec sed -i \
      's/var global=new Function("return this")();/var global=globalThis;/g' {} \; || true

    # Loudly flag any file where the global-scope fix did not apply: a silent miss
    # means coverage runs but never reaches window.__coverage__.
    UNFIXED_COUNT=$(count_files_matching 'new Function("return this")' "$WORK_DIR/inst-$BUNDLE")
    if [[ "$UNFIXED_COUNT" -ne 0 ]]; then
      echo "  ⚠️  $UNFIXED_COUNT file(s) in $BUNDLE/ still use new Function(\"return this\") after the fix"
    fi

    BUNDLE_JS_COUNT=$(count_files_matching "__coverage__" "$WORK_DIR/inst-$BUNDLE")
    if [[ "$BUNDLE_JS_COUNT" -eq 0 ]]; then
      echo "  ❌ No __coverage__ found in instrumented $BUNDLE/ - skipping that bundle"
      continue
    fi
    echo "  ✓ Instrumented $BUNDLE_JS_COUNT JS files in $BUNDLE/"
    TOTAL_JS_COUNT=$((TOTAL_JS_COUNT + BUNDLE_JS_COUNT))
    COPY_LINES+="COPY inst-$BUNDLE/ $PLUGIN_PATH/$BUNDLE/"$'\n'
  done

  # `|| true` so a podman hiccup removing the throwaway container never aborts
  # the whole job (set -e) and loses instrumentation for the remaining plugins.
  podman rm "$CID" || true

  if [[ "$TOTAL_JS_COUNT" -eq 0 ]]; then
    echo "  ❌ No bundles could be instrumented - skipping"
    cleanup_and_skip
    continue
  fi
  echo "  ✓ Instrumented $TOTAL_JS_COUNT JS files total"

  # Build coverage image (overlay every instrumented bundle over the production image)
  {
    echo "FROM $PROD_IMAGE"
    printf '%s' "$COPY_LINES"
  } > "$WORK_DIR/Containerfile"

  # Generate coverage image tag: append __coverage suffix to tag
  # Example: plugin:pr_123__1.2.3 → plugin:pr_123__1.2.3__coverage
  IMAGE_BASE="${PROD_IMAGE%:*}"
  IMAGE_TAG="${PROD_IMAGE##*:}"
  COVERAGE_IMAGE="${IMAGE_BASE}:${IMAGE_TAG}__coverage"

  # CRITICAL: --squash-all flattens the result into a SINGLE layer.
  # RHDH's install-dynamic-plugins (image-cache.ts: downloadAndLocateTarball)
  # only ever extracts manifest.layers[0] — it assumes dynamic-plugin images are
  # single-layer. A plain `FROM prod + COPY` produces a multi-layer image whose
  # FIRST layer is the original (uninstrumented) base, so RHDH would serve the
  # original code and ignore our instrumented overlay layers. Squashing merges
  # the overlays into one layer (instrumented files win), so layers[0] carries
  # the instrumentation that actually reaches the browser.
  if ! podman build --squash-all -t "$COVERAGE_IMAGE" -f "$WORK_DIR/Containerfile" "$WORK_DIR"; then
    echo "  ❌ Failed to build coverage image - skipping"
    cleanup_and_skip
    continue
  fi

  # Verify the image is single-layer so RHDH's layers[0]-only extraction sees the
  # instrumented filesystem. Refuse to push a multi-layer image: it would deploy
  # and run fine but silently serve the ORIGINAL (uninstrumented) base layer —
  # exactly the failure mode this script exists to avoid — so fail loudly instead.
  LAYER_COUNT=$(podman inspect "$COVERAGE_IMAGE" --format '{{len .RootFS.Layers}}' 2>/dev/null || echo "?")
  if [[ "$LAYER_COUNT" != "1" ]]; then
    echo "  ❌ Coverage image has $LAYER_COUNT layers (expected 1); RHDH only reads layers[0] so coverage would not load - refusing to push"
    cleanup_and_skip
    continue
  fi
  echo "  ✓ Coverage image squashed to a single layer"

  # Push coverage image
  if ! podman push "$COVERAGE_IMAGE"; then
    echo "  ❌ Failed to push coverage image"
    cleanup_and_skip
    continue
  fi

  echo "  ✓ Published: $COVERAGE_IMAGE"

  # Cleanup
  rm -rf "$WORK_DIR"
  echo ""

  INSTRUMENTED_COUNT=$((INSTRUMENTED_COUNT + 1))

done

echo "=== Instrumentation complete ==="
echo "  Instrumented: $INSTRUMENTED_COUNT plugins"
echo "  Skipped:      $SKIPPED_COUNT plugins"

if [[ $INSTRUMENTED_COUNT -eq 0 ]]; then
  echo ""
  echo "[WARN] No plugins were instrumented"
  echo "[INFO] This may be expected if there are no frontend plugins in this workspace"
fi
