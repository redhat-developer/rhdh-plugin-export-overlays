#!/usr/bin/env bash
#
# Merge per-test Istanbul coverage JSONs, generate lcov, and upload to Codecov.
#
# Usage:
#   ./scripts/report-coverage.sh <workspace> [workspace...]
#
# Example:
#   E2E_COLLECT_COVERAGE=1 ./run-e2e.sh -w tech-radar
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

if ! ls "$REPO_ROOT/$COVERAGE_JSON_DIR"/*.json &>/dev/null; then
  echo "[INFO] No coverage data found (no instrumented plugins loaded?)"
  exit 0
fi

echo ""
echo "[INFO] Merging coverage data with nyc..."
mkdir -p "$REPO_ROOT/.nyc_output"
npx nyc merge "$REPO_ROOT/$COVERAGE_JSON_DIR" "$REPO_ROOT/.nyc_output/out.json"
(cd "$REPO_ROOT" && npx nyc report --reporter=lcov --reporter=text-summary --report-dir coverage)

if [[ ${#WORKSPACES[@]} -gt 1 ]]; then
  echo "[WARN] Coverage data is merged across all ${#WORKSPACES[@]} workspaces."
  echo "[WARN] For clean per-workspace coverage, run with a single -w flag."
fi

echo "[INFO] Uploading E2E coverage to Codecov..."
for ws in "${WORKSPACES[@]}"; do
  if [[ -f "$REPO_ROOT/workspaces/$ws/source.json" ]]; then
    "$SCRIPT_DIR/upload-coverage.sh" "$ws" || \
      echo "[WARN] Coverage upload failed for $ws (non-fatal)"
  fi
done
