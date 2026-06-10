#!/usr/bin/env bash
#
# Merge per-test Istanbul coverage JSONs, generate lcov, and upload to Codecov.
#
# Usage:
#   ./scripts/report-coverage.sh <workspace> [workspace...]
#
# Example:
#   E2E_COLLECT_COVERAGE=true ./run-e2e.sh -w tech-radar
#   ./scripts/report-coverage.sh tech-radar
#
# The script:
#   1. Merges per-test coverage JSONs (written by the _coverageCollector fixture)
#      into a single coverage-final.json using nyc merge
#   2. Generates lcov and text-summary reports via nyc report
#   3. Uploads lcov to Codecov for each workspace with cross-repo attribution
#
# Required environment:
#   CODECOV_TOKEN  - Codecov upload token (org-level for cross-repo uploads)

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <workspace> [workspace...]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACES=("$@")

COVERAGE_JSON_DIR="node_modules/.cache/e2e-test-results/coverage"

if ! compgen -G "$REPO_ROOT/$COVERAGE_JSON_DIR/*.json" >/dev/null 2>&1; then
  echo "[INFO] No coverage data found (no instrumented plugins loaded?)"
  exit 0
fi

echo ""
echo "[INFO] Merging coverage data with nyc..."
mkdir -p "$REPO_ROOT/.nyc_output"
npx nyc@18.0.0 merge "$REPO_ROOT/$COVERAGE_JSON_DIR" "$REPO_ROOT/.nyc_output/out.json"

# Remap bundle coverage back to source and emit lcov.
#
# Plugins are instrumented post-build (on the `dist/` and `dist-scalprum/`
# bundles), so the collected coverage is keyed by bundle paths that only existed
# in the publish job's temp dir. `nyc report` cannot resolve those paths here and
# would report 0/0. remap-coverage.cjs applies the source maps nyc embedded
# (`--source-map`) to map coverage onto the original source files and write lcov.
#
# The istanbul libraries are installed into a throwaway prefix so they never land
# in the repo or a workspace's node_modules. Keep these pins in sync with the
# istanbul API that remap-coverage.cjs relies on.
echo "[INFO] Remapping bundle coverage to source and generating lcov..."
REMAP_DEPS_DIR=$(mktemp -d)
if ! { npm install --prefix "$REMAP_DEPS_DIR" --no-save --no-audit --no-fund --loglevel=error \
    istanbul-lib-coverage@3.2.2 \
    istanbul-lib-source-maps@5.0.6 \
    istanbul-lib-report@3.0.1 \
    istanbul-reports@3.2.0 \
  && (cd "$REPO_ROOT" && NODE_PATH="$REMAP_DEPS_DIR/node_modules" \
      node "$SCRIPT_DIR/remap-coverage.cjs" "$REPO_ROOT/.nyc_output/out.json" coverage); }; then
  echo "[WARN] Coverage remap/report failed (non-fatal); skipping upload" >&2
  rm -rf "$REMAP_DEPS_DIR"
  exit 0
fi
rm -rf "$REMAP_DEPS_DIR"

if [[ ${#WORKSPACES[@]} -gt 1 ]]; then
  echo "[WARN] Multi-workspace coverage upload is not supported." >&2
  echo "[WARN] Coverage is merged across workspaces but uploaded with per-workspace flags." >&2
  echo "[WARN] This produces misleading coverage percentages in Codecov." >&2
  echo "[WARN] Skipping upload. Run report-coverage.sh once per workspace to upload." >&2
else
  echo "[INFO] Uploading E2E coverage to Codecov..."
  for ws in "${WORKSPACES[@]}"; do
    if [[ -f "$REPO_ROOT/workspaces/$ws/source.json" ]]; then
      "$SCRIPT_DIR/upload-coverage.sh" "$ws" || \
        echo "[WARN] Coverage upload failed for $ws (non-fatal)"
    fi
  done
fi
