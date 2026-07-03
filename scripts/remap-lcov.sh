#!/usr/bin/env bash
#
# Merge per-test Istanbul coverage JSONs and remap them onto the committed
# coverage anchors, writing <report-dir>/<workspace>/lcov.info (one per
# workspace that contributed coverage) plus the combined <report-dir>/lcov.info.
#
# Used by refresh-coverage-snapshot.sh (rebuild a committed snapshot from a
# passing e2e run's coverage) so the istanbul pins and the merge/remap pipeline
# live in one place. Keep these pins in sync with the API remap-coverage.cjs
# relies on.
#
# Usage:
#   ./scripts/remap-lcov.sh <coverage-json-dir> <report-dir>

set -euo pipefail

JSON_DIR="${1:?Usage: $0 <coverage-json-dir> <report-dir>}"
REPORT_DIR="${2:?Usage: $0 <coverage-json-dir> <report-dir>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# The istanbul libraries are installed into a throwaway prefix so they never
# land in the repo or a workspace's node_modules. The trap cleans them up on
# any exit path (including a mid-pipeline failure under set -e).
DEPS_DIR="$(mktemp -d)"
NYC_OUT="$(mktemp -d)"
trap 'rm -rf "$DEPS_DIR" "$NYC_OUT"' EXIT

npm install --prefix "$DEPS_DIR" --no-save --no-audit --no-fund --loglevel=error \
  istanbul-lib-coverage@3.2.2 \
  istanbul-lib-source-maps@5.0.6 \
  istanbul-lib-report@3.0.1 \
  istanbul-reports@3.2.0

npx nyc@18.0.0 merge "$JSON_DIR" "$NYC_OUT/out.json"

# remap-coverage.cjs discovers each plugin's owning workspace from the committed
# anchors (workspaces/*/coverage-anchors/<scalprum-name>), so it must run from
# the repo root.
( cd "$REPO_ROOT" && NODE_PATH="$DEPS_DIR/node_modules" \
    node "$SCRIPT_DIR/remap-coverage.cjs" "$NYC_OUT/out.json" "$REPORT_DIR" )
