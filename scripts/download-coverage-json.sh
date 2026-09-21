#!/usr/bin/env bash
#
# Download a Prow run's per-test Istanbul coverage JSONs from a gcsweb artifact
# listing into a local directory.
#
# Usage:
#   ./scripts/download-coverage-json.sh <https-listing-url> <dest-dir>
#
# Exits 0 with an EMPTY <dest-dir> when the run legitimately produced no
# coverage (a backend-only or uninstrumented run, which a passing e2e can
# produce) — turning that into a red job would punish runs that did nothing
# wrong. Exits non-zero when the listing could not be read, when a listed file
# fails to download, or when the listing advertised JSONs and none of them
# survived: those mean the artifacts or the listing format moved, and reporting
# success for an empty result is exactly how that stays invisible.
#
# Callers decide what an empty result means for them.
#
# Extracted from refresh-coverage-snapshot.sh so the upstream upload path reuses
# the same hardened download instead of carrying a second copy. Every guard below
# is here because of a failure that actually happened; see the comments.
#
# Requires: curl, jq. jq is what tells a coverage map from an error page.

set -euo pipefail

SOURCE="${1:?Usage: $0 <https-listing-url> <dest-dir>}"
DEST="${2:?Usage: $0 <https-listing-url> <dest-dir>}"

# Plaintext HTTP is refused because the artifacts decide what coverage gets
# published, so a tampered listing is a real concern — except on loopback, where
# there is no network to intercept. That exception is what lets the tests drive
# this against a local HTTP server instead of asserting on a slice of the source
# text, which is how they used to pin the previous inline version.
if [[ "$SOURCE" =~ ^http://(127\.0\.0\.1|localhost)([:/]|$) ]]; then
  : # loopback, no transport to protect
elif [[ ! "$SOURCE" =~ ^https:// ]]; then
  echo "ERROR: refusing to download over insecure HTTP; use HTTPS" >&2
  exit 1
fi

# Checked up front because the failure is otherwise disguised: `if ! jq` reads a
# missing binary's 127 as "not JSON", drops every file, and the run reports a
# server or listing problem instead of a missing tool.
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to download coverage from a URL (see header)." >&2
  exit 1
fi

mkdir -p "$DEST"

echo "[INFO] Downloading coverage JSONs from $SOURCE"
if ! listing=$(curl -sf "$SOURCE"); then
  echo "ERROR: could not fetch $SOURCE (bad URL or network)" >&2
  exit 1
fi

# Names come from the collector in e2e-test-utils and have changed shape before:
# they were `<testId>-<timestamp>.json`, all hex, and are now
# `w<worker>-page<n>.json`. A hex-only pattern silently carved `e0.json` out of
# `w0-page0.json` and "found" a file that does not exist, so do not guess the
# alphabet.
#
# Read the link targets rather than scanning the page: a bare `.json` pattern
# would also match anything the listing happens to mention in prose or in an
# inline script, and each false name costs a request whose failure arrives as a
# 200 (see below). Taking the last path segment is what keeps the directory
# prefix in the href out of the filename.
files=$(echo "$listing" \
  | grep -oE 'href="[^"]*\.json"' \
  | grep -oE '[^"/]+\.json' \
  | sort -u || true)

if [[ -z "$files" ]]; then
  echo "[INFO] No coverage JSONs at $SOURCE (backend-only or uninstrumented run)."
  exit 0
fi

# Read line by line rather than `for f in $files`: word-splitting would turn a
# filename containing a space into two names that do not exist, and gcsweb
# answers a missing file with HTTP 200 and an error page — so the damage would
# arrive disguised as the very failure the checks below exist to catch.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  # -f alone is not enough: gcsweb answers a missing file with HTTP 200 and an
  # HTML error page, so the failure arrives as a well-formed response. Verify
  # what landed is really a coverage map, or a stray name from the listing
  # becomes an unparseable file that `nyc merge` skips and an empty report
  # nobody can explain.
  if ! curl -sf -o "$DEST/$f" "${SOURCE%/}/$f"; then
    echo "ERROR: failed to download $f from $SOURCE" >&2
    exit 1
  fi
  if ! jq -e 'type == "object"' "$DEST/$f" >/dev/null 2>&1; then
    echo "[WARN] $f is not JSON (server likely returned an error page) — ignoring." >&2
    rm -f "$DEST/$f"
  fi
done <<<"$files"

if ! compgen -G "$DEST/*.json" >/dev/null; then
  echo "ERROR: $SOURCE listed .json files but none of them downloaded as JSON." >&2
  echo "       The listing format may have changed — check the coverage URL by hand." >&2
  exit 1
fi

echo "[INFO] Downloaded $(find "$DEST" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ') coverage JSON(s)"
