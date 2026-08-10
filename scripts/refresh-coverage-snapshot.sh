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
# Requires: node, npm, nyc (npx), jq, and the workspace's coverage-anchors/
# present. jq is only needed when SOURCE is a URL, to tell a coverage map from
# an error page.

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
  # Checked up front because the failure is otherwise disguised: `if ! jq` reads
  # a missing binary's 127 as "not JSON", drops every file, and the run reports
  # a server or listing problem instead of a missing tool.
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required to download coverage from a URL (see header)." >&2
    exit 1
  fi
  if ! listing=$(curl -sf "$SOURCE"); then
    echo "ERROR: could not fetch $SOURCE (bad URL or network)" >&2
    exit 1
  fi
  # Names come from the collector in e2e-test-utils and have changed shape
  # before: they were `<testId>-<timestamp>.json`, all hex, and are now
  # `w<worker>-page<n>.json`. A hex-only pattern silently carved `e0.json` out
  # of `w0-page0.json` and "found" a file that does not exist, so do not guess
  # the alphabet.
  #
  # Read the link targets rather than scanning the page: a bare `.json` pattern
  # would also match anything the listing happens to mention in prose or in an
  # inline script, and each false name costs a request whose failure arrives as
  # a 200 (see below). Taking the last path segment is what keeps the directory
  # prefix in the href out of the filename.
  files=$(echo "$listing" \
    | grep -oE 'href="[^"]*\.json"' \
    | grep -oE '[^"/]+\.json' \
    | sort -u || true)
  if [[ -z "$files" ]]; then
    echo "[INFO] No coverage JSONs at $SOURCE (backend-only or uninstrumented run) — nothing to snapshot."
    exit 0
  fi
  for f in $files; do
    # -f alone is not enough: gcsweb answers a missing file with HTTP 200 and an
    # HTML error page, so the failure arrives as a well-formed response. Verify
    # what landed is really a coverage map, or a stray name from the listing
    # becomes an unparseable file that `nyc merge` skips and an empty snapshot
    # nobody can explain.
    if ! curl -sf -o "$JSON_DIR/$f" "${SOURCE%/}/$f"; then
      echo "ERROR: failed to download $f from $SOURCE" >&2
      exit 1
    fi
    if ! jq -e 'type == "object"' "$JSON_DIR/$f" >/dev/null 2>&1; then
      echo "[WARN] $f is not JSON (server likely returned an error page) — ignoring." >&2
      rm -f "$JSON_DIR/$f"
    fi
  done
  if ! compgen -G "$JSON_DIR/*.json" >/dev/null; then
    echo "ERROR: $SOURCE listed .json files but none of them downloaded as JSON." >&2
    echo "       The listing format may have changed — check the coverage URL by hand." >&2
    exit 1
  fi
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
