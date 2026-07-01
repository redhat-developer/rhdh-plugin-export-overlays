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

# Clean up temp dirs on any exit path (including a mid-pipeline failure).
DOWNLOAD_DIR=""
REPORT_DIR=""
cleanup() { rm -rf ${DOWNLOAD_DIR:+"$DOWNLOAD_DIR"} ${REPORT_DIR:+"$REPORT_DIR"}; }
trap cleanup EXIT

JSON_DIR=""
if [[ "$SOURCE" =~ ^https:// ]]; then
  DOWNLOAD_DIR="$(mktemp -d)"
  JSON_DIR="$DOWNLOAD_DIR"
  echo "[INFO] Downloading coverage JSONs from $SOURCE"
  # Distinguish a genuine fetch failure (bad URL / network — fatal) from a
  # valid-but-empty coverage dir (backend-only or uninstrumented run, which a
  # passed e2e legitimately produces — non-fatal, nothing to snapshot).
  if ! listing=$(curl -sf "$SOURCE"); then
    echo "ERROR: could not fetch $SOURCE (bad URL or network)" >&2
    exit 1
  fi
  files=$(echo "$listing" | grep -oE '[a-f0-9-]+\.json' | sort -u || true)
  if [[ -z "$files" ]]; then
    echo "[INFO] No coverage JSONs at $SOURCE (backend-only or uninstrumented run) — nothing to snapshot."
    exit 0
  fi
  # -f so a 404/HTML error page fails loudly instead of being written as a
  # bogus .json that would silently skew the snapshot.
  for f in $files; do
    curl -sf -o "$JSON_DIR/$f" "${SOURCE%/}/$f" || {
      echo "ERROR: failed to download $f from $SOURCE" >&2
      exit 1
    }
  done
elif [[ "$SOURCE" =~ ^http:// ]]; then
  echo "ERROR: refusing to download over insecure HTTP; use HTTPS" >&2
  exit 1
else
  JSON_DIR="$SOURCE"
fi

if ! compgen -G "$JSON_DIR/*.json" >/dev/null; then
  echo "[INFO] No *.json coverage files in $JSON_DIR — nothing to snapshot."
  exit 0
fi

REPORT_DIR="$(mktemp -d)"
"$SCRIPT_DIR/remap-lcov.sh" "$JSON_DIR" "$REPORT_DIR"

mkdir -p "$REPO_ROOT/coverage-snapshots"
if [[ ! -f "$REPORT_DIR/$WORKSPACE/lcov.info" ]]; then
  # The run had coverage, but none mapped to this workspace's anchors (a
  # backend-only run, or the wrong coverage source for a manual invocation).
  # Either way there is nothing to snapshot — non-fatal.
  echo "[INFO] No coverage mapped to workspace '$WORKSPACE' — nothing to snapshot."
  exit 0
fi

cp "$REPORT_DIR/$WORKSPACE/lcov.info" "$REPO_ROOT/coverage-snapshots/$WORKSPACE.lcov"
anchors=$(grep -c '^SF:' "$REPO_ROOT/coverage-snapshots/$WORKSPACE.lcov" || true)

echo "[OK] Wrote coverage-snapshots/$WORKSPACE.lcov ($anchors plugin anchor(s)). Commit it."
