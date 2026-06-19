#!/usr/bin/env bash
#
# Refresh a workspace's committed coverage snapshot from a real e2e run's
# coverage data, so scripts/seed-main-coverage.sh uploads an up-to-date number.
#
# Usage:
#   ./scripts/refresh-coverage-snapshot.sh <workspace> <coverage-source>
#
#   <coverage-source> is either:
#     - a local directory containing the per-test coverage JSON files, or
#     - a gcsweb URL to a Prow run's `.../artifacts/e2e-test-results/coverage/`
#       directory (the files are downloaded automatically).
#
# Example (from a passing PR e2e run — open its Playwright/Prow artifacts and
# copy the coverage/ directory URL):
#   ./scripts/refresh-coverage-snapshot.sh global-header \
#     'https://gcsweb-ci.../artifacts/e2e-test-results/coverage/'
#
# Writes coverage-snapshots/<workspace>.lcov. Commit the result. The snapshot
# only needs refreshing when a workspace's coverage actually changes (i.e. when
# a PR touches that workspace and re-runs its e2e).
#
# Requires: node, npm, nyc (npx), and the workspace's coverage-anchors/ present.

set -euo pipefail

WORKSPACE="${1:?Usage: $0 <workspace> <coverage-source>}"
SOURCE="${2:?Usage: $0 <workspace> <coverage-source>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -d "$REPO_ROOT/workspaces/$WORKSPACE/coverage-anchors" ]]; then
  echo "ERROR: no coverage-anchors for '$WORKSPACE' — run generate-coverage-anchors.sh first" >&2
  exit 1
fi

JSON_DIR=""
CLEANUP_DIR=""
if [[ "$SOURCE" =~ ^https?:// ]]; then
  JSON_DIR="$(mktemp -d)"
  CLEANUP_DIR="$JSON_DIR"
  echo "[INFO] Downloading coverage JSONs from $SOURCE"
  files=$(curl -s "$SOURCE" | grep -oE '[a-f0-9-]+\.json' | sort -u)
  if [[ -z "$files" ]]; then
    echo "ERROR: no coverage JSON files found at $SOURCE" >&2
    rm -rf "$CLEANUP_DIR"
    exit 1
  fi
  for f in $files; do curl -s -o "$JSON_DIR/$f" "${SOURCE%/}/$f"; done
else
  JSON_DIR="$SOURCE"
fi

if ! compgen -G "$JSON_DIR/*.json" >/dev/null; then
  echo "ERROR: no *.json coverage files in $JSON_DIR" >&2
  [[ -n "$CLEANUP_DIR" ]] && rm -rf "$CLEANUP_DIR"
  exit 1
fi

DEPS_DIR="$(mktemp -d)"
NYC_OUT="$(mktemp -d)"
npm install --prefix "$DEPS_DIR" --no-save --no-audit --no-fund --loglevel=error \
  istanbul-lib-coverage@3.2.2 \
  istanbul-lib-source-maps@5.0.6 \
  istanbul-lib-report@3.0.1 \
  istanbul-reports@3.2.0 >/dev/null

npx nyc@18.0.0 merge "$JSON_DIR" "$NYC_OUT/out.json" >/dev/null 2>&1

REPORT_DIR="$(mktemp -d)"
( cd "$REPO_ROOT" && NODE_PATH="$DEPS_DIR/node_modules" \
    node "$SCRIPT_DIR/remap-coverage.cjs" "$NYC_OUT/out.json" "$REPORT_DIR" )

mkdir -p "$REPO_ROOT/coverage-snapshots"
if [[ ! -f "$REPORT_DIR/$WORKSPACE/lcov.info" ]]; then
  echo "ERROR: remap produced no lcov for workspace '$WORKSPACE' — wrong coverage source?" >&2
  rm -rf "$DEPS_DIR" "$NYC_OUT" "$REPORT_DIR" ${CLEANUP_DIR:+"$CLEANUP_DIR"}
  exit 1
fi

cp "$REPORT_DIR/$WORKSPACE/lcov.info" "$REPO_ROOT/coverage-snapshots/$WORKSPACE.lcov"
anchors=$(grep -c '^SF:' "$REPO_ROOT/coverage-snapshots/$WORKSPACE.lcov")
rm -rf "$DEPS_DIR" "$NYC_OUT" "$REPORT_DIR" ${CLEANUP_DIR:+"$CLEANUP_DIR"}

echo "[OK] Wrote coverage-snapshots/$WORKSPACE.lcov ($anchors plugin anchor(s)). Commit it."
