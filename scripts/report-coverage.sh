#!/usr/bin/env bash
#
# Merge per-test Istanbul coverage JSONs, generate lcov, and upload to Codecov.
# Coverage is attributed to this overlay repo's commit, flagged per workspace
# (see upload-coverage.sh for the attribution model).
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
#   2. Remaps bundle coverage onto committed anchor files and writes one
#      coverage/<workspace>/lcov.info per workspace (remap-coverage.cjs)
#   3. Uploads each workspace's lcov to Codecov under its e2e-<workspace> flag
#
# Required environment:
#   CODECOV_TOKEN  - Codecov upload token for this repo's project

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

# Merge the per-test coverage JSONs and remap them onto the committed anchors,
# producing coverage/<workspace>/lcov.info (one per workspace that contributed)
# plus the combined coverage/lcov.info. remap-coverage.cjs resolves bundle paths
# back to source via the source maps nyc embedded; the anchors keep lcov paths
# resolvable in this repo's git tree — Codecov drops paths it can't resolve.
# The shared remap-lcov.sh holds the istanbul pins + merge/remap pipeline.
#
# Wipe previous output first: a stale coverage/<ws>/lcov.info from an earlier
# local run would otherwise be uploaded below, attributed to today's commit.
echo ""
echo "[INFO] Merging and remapping coverage to per-workspace lcov..."
rm -rf "$REPO_ROOT/coverage"
if ! "$SCRIPT_DIR/remap-lcov.sh" "$REPO_ROOT/$COVERAGE_JSON_DIR" "$REPO_ROOT/coverage"; then
  echo "[WARN] Coverage remap/report failed (non-fatal); skipping upload" >&2
  exit 0
fi

# Upload every per-workspace lcov the remap produced, each under its own
# e2e-<workspace> flag. Iterating what was PRODUCED (not what was requested)
# means coverage attributed to a workspace outside this run's -w list is still
# uploaded rather than silently orphaned; upload-coverage.sh validates the
# workspace name. Requested workspaces with no lcov produced no browser
# coverage (backend-only plugins, or uninstrumented images) — note them
# without failing, the nightly legitimately includes such workspaces.
echo "[INFO] Uploading E2E coverage to Codecov..."
shopt -s nullglob
for WS_LCOV in "$REPO_ROOT"/coverage/*/lcov.info; do
  ws=$(basename "$(dirname "$WS_LCOV")")
  "$SCRIPT_DIR/upload-coverage.sh" "$ws" "$WS_LCOV" || \
    echo "[WARN] Coverage upload failed for $ws (non-fatal)"
done
shopt -u nullglob
for ws in "${WORKSPACES[@]}"; do
  if [[ ! -f "$REPO_ROOT/coverage/$ws/lcov.info" ]]; then
    echo "[INFO] No coverage collected for workspace '$ws' — skipping upload"
  fi
done
