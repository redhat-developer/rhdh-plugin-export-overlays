#!/usr/bin/env bash
#
# Publish a workspace's E2E coverage to the Codecov project of the repository
# the plugin SOURCES live in, browsable file by file.
#
# Usage:
#   ./scripts/upload-coverage-upstream.sh <workspace> <coverage-json-dir> [--dry-run]
#
# This complements scripts/upload-coverage.sh; it never replaces it. That one
# publishes to this repo's own project against a committed anchor, which keeps
# the percentage for every workspace but loses the per-file detail (the sources
# are not here). This one publishes the same measurements upstream, where every
# path resolves.
#
# Three constraints shape the whole script, each easy to get wrong:
#
#   1. The Codecov CLI builds the file network it sends from the git repo in the
#      CURRENT WORKING DIRECTORY, and resolves report paths against it. `--slug`
#      and `--sha` do NOT change that. Uploading from this checkout sends this
#      repo's file list and the report comes back REPORT_EMPTY even though every
#      path is valid upstream. So the upload runs from inside a shallow clone of
#      the source repo. This is why the clone exists — not convenience.
#
#   2. The input is the run's RAW nyc JSONs, not a committed
#      coverage-snapshots/<ws>.lcov. Those snapshots are already anchor-mapped:
#      every source file has been concatenated onto one entry, so the per-file
#      detail this path exists to publish is gone before it starts. Raw JSONs
#      live in the Prow run's artifacts, which is why this cannot be a periodic
#      re-seed the way seed-main-coverage.sh is.
#
#   3. Coverage is attributed to the workspace's pinned `repo-ref`, because that
#      is the commit the tested plugin was built from. It is ALSO uploaded to the
#      source repo's current main HEAD, because a report on a historical commit
#      is never reachable from the default branch: Codecov's carryforward
#      inherits from the parent commit's finalised report, and every commit
#      between the pinned ref and now was finalised without this flag. Measured
#      2026-08-10: e2e-orchestrator has a report at its pinned ref and files=0 on
#      all ~30 main commits processed after that upload landed. The HEAD copy is
#      the only one anyone sees; the pinned-ref copy is the exactly-attributed
#      one. Source drift between the two was 0-14% per workspace.
#
# Required environment:
#   CODECOV_UPSTREAM_TOKEN - Codecov upload token for the SOURCE repo's project.
#                            This is NOT the CODECOV_TOKEN used by
#                            upload-coverage.sh: tokens are per project, and
#                            reusing this repo's would upload nothing anywhere
#                            useful. Not needed for --dry-run.
#
# Test seams (scripts/tests/test_upload_coverage_upstream.py):
#   CODECOV_BIN            - path to the Codecov CLI, so tests stub it instead of
#                            downloading and calling the real one.
#   UPSTREAM_CLONE_DIR     - reuse an existing checkout instead of cloning, so
#                            tests never reach GitHub.
#   REMAP_BIN              - path to the remap step. remap-lcov.sh npm-installs
#                            the istanbul libraries on every run, which is too
#                            heavy and too networked for a unit test; the remap
#                            itself is covered separately against a fixture.

set -euo pipefail

WORKSPACE="${1:?Usage: $0 <workspace> <coverage-json-dir> [--dry-run]}"
JSON_DIR="${2:?Usage: $0 <workspace> <coverage-json-dir> [--dry-run]}"
DRY_RUN="false"
if [[ "${3:-}" == "--dry-run" ]]; then
  DRY_RUN="true"
elif [[ -n "${3:-}" ]]; then
  echo "ERROR: unknown argument '$3' (expected --dry-run)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# The workspace name becomes the Codecov flag verbatim — validate it so a typo
# cannot create a ghost e2e-<typo> flag that carryforward then keeps alive in a
# shared project we do not administer.
if [[ ! "$WORKSPACE" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "ERROR: invalid workspace name '$WORKSPACE'" >&2
  exit 1
fi
readonly FLAG="e2e-$WORKSPACE"

SOURCE_JSON="$REPO_ROOT/workspaces/$WORKSPACE/source.json"
if [[ ! -f "$SOURCE_JSON" ]]; then
  echo "ERROR: no $SOURCE_JSON — unknown workspace '$WORKSPACE'." >&2
  exit 1
fi

if [[ ! -d "$JSON_DIR" ]]; then
  echo "ERROR: coverage JSON directory not found: $JSON_DIR" >&2
  exit 1
fi

SOURCE_REPO_URL="$(jq -r '.repo // empty' "$SOURCE_JSON")"
PINNED_REF="$(jq -r '."repo-ref" // empty' "$SOURCE_JSON")"

if [[ -z "$SOURCE_REPO_URL" || -z "$PINNED_REF" ]]; then
  echo "ERROR: $SOURCE_JSON has no 'repo' / 'repo-ref'." >&2
  exit 1
fi

# github.com/<owner>/<name> in any of the forms source.json uses.
SLUG="$(sed -E 's#^.*github\.com[:/]+##; s#\.git$##; s#/+$##' <<<"$SOURCE_REPO_URL")"
if [[ ! "$SLUG" =~ ^[^/]+/[^/]+$ ]]; then
  echo "ERROR: could not derive an owner/name slug from '$SOURCE_REPO_URL'." >&2
  exit 1
fi

# Only repos with an active Codecov project are eligible. Uploading elsewhere
# creates a project nobody watches, in an org we may not administer — and a flag
# carryforward then drags forward with no way for us to remove it. Skipping is
# not an error: most workspaces legitimately have nowhere upstream to publish.
readonly ELIGIBLE_SLUGS=("redhat-developer/rhdh-plugins")
eligible="false"
for candidate in "${ELIGIBLE_SLUGS[@]}"; do
  [[ "$SLUG" == "$candidate" ]] && eligible="true"
done
if [[ "$eligible" != "true" ]]; then
  echo "[SKIP] $SLUG has no Codecov project configured for upstream uploads."
  echo "       Workspace '$WORKSPACE' keeps its anchor upload only."
  exit 0
fi

if [[ ! "$PINNED_REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: 'repo-ref' is not a 40-char SHA: '$PINNED_REF'." >&2
  echo "       Codecov needs a commit that exists on GitHub." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "true" && -z "${CODECOV_UPSTREAM_TOKEN:-}" ]]; then
  echo "ERROR: CODECOV_UPSTREAM_TOKEN is not set — the upload would reach" >&2
  echo "       nothing. Use --dry-run to exercise the remap without it." >&2
  exit 1
fi

echo "=== Upstream E2E coverage: $WORKSPACE ==="
echo "  Source repo: $SLUG"
echo "  Pinned ref:  $PINNED_REF"
echo "  Flag:        $FLAG"

WORK_DIR="$(mktemp -d)"
CLONE_DIR="${UPSTREAM_CLONE_DIR:-$WORK_DIR/src}"
REPORT_DIR="$WORK_DIR/report"
# Keep the clone when it was handed to us: deleting a caller's checkout (or a
# test fixture) is not ours to do.
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [[ -z "${UPSTREAM_CLONE_DIR:-}" ]]; then
  echo ""
  echo "--- Shallow clone of $SLUG at $PINNED_REF ---"
  # A pinned SHA is not a ref, so it cannot be cloned with --branch. Fetching it
  # by SHA into an empty repo keeps the download to one commit instead of the
  # full history a plain clone would pull.
  git init -q "$CLONE_DIR"
  git -C "$CLONE_DIR" remote add origin "https://github.com/$SLUG"
  if ! git -C "$CLONE_DIR" fetch -q --depth 1 origin "$PINNED_REF"; then
    echo "ERROR: could not fetch $PINNED_REF from $SLUG." >&2
    echo "       The ref may have been garbage-collected or force-pushed away." >&2
    exit 1
  fi
  git -C "$CLONE_DIR" checkout -q FETCH_HEAD
fi

echo ""
echo "--- Remapping onto upstream source paths ---"
"${REMAP_BIN:-$SCRIPT_DIR/remap-lcov.sh}" "$JSON_DIR" "$REPORT_DIR" \
  --upstream-root "$CLONE_DIR" --upstream-workspace "$WORKSPACE"

LCOV="$REPORT_DIR/lcov.info"
if [[ ! -s "$LCOV" ]]; then
  echo "ERROR: remap produced no lcov at $LCOV." >&2
  exit 1
fi

# Both targets, resolved before either upload so a failure to determine HEAD
# does not leave the pinned-ref copy uploaded and the visible one missing.
TARGETS=("$PINNED_REF")
MAIN_HEAD="$(git -C "$CLONE_DIR" ls-remote origin HEAD 2>/dev/null | awk '{print $1}')"
if [[ "$MAIN_HEAD" =~ ^[0-9a-f]{40}$ && "$MAIN_HEAD" != "$PINNED_REF" ]]; then
  TARGETS+=("$MAIN_HEAD")
else
  # Not fatal: the exactly-attributed copy is still worth publishing, and a
  # later run will carry the HEAD copy. Silence here would hide why the flag
  # never appears on the default branch, which is the whole point of the copy.
  echo "[WARN] could not resolve $SLUG main HEAD — uploading to the pinned ref" >&2
  echo "       only. The flag will not be visible on the default branch." >&2
fi

CODECOV_BIN="${CODECOV_BIN:-/tmp/codecov}"
if [[ "$DRY_RUN" != "true" && ! -x "$CODECOV_BIN" ]]; then
  "$SCRIPT_DIR/ensure-codecov-cli.sh" "$CODECOV_BIN"
fi

FAILED=()
for sha in "${TARGETS[@]}"; do
  label="pinned ref"
  [[ "$sha" != "$PINNED_REF" ]] && label="main HEAD"
  echo ""
  echo "--- Upload to $sha ($label) ---"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] would upload $LCOV"
    echo "[DRY-RUN]   --slug $SLUG --sha $sha --flag $FLAG --branch main"
    continue
  fi

  # Run from inside the clone — see constraint 1 at the top. This is the single
  # most load-bearing line in the script.
  if ! (cd "$CLONE_DIR" && "$CODECOV_BIN" upload-process \
    --token "$CODECOV_UPSTREAM_TOKEN" \
    --slug "$SLUG" \
    --sha "$sha" \
    --branch main \
    --flag "$FLAG" \
    --file "$LCOV" \
    --disable-search \
    --name "overlay-$FLAG" \
    --fail-on-error); then
    echo "ERROR: upload to $sha failed" >&2
    FAILED+=("$sha")
  fi
done

echo ""
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "ERROR: ${#FAILED[@]} of ${#TARGETS[@]} upload(s) failed: ${FAILED[*]}" >&2
  exit 1
fi
echo "=== Done: ${#TARGETS[@]} upload(s) for $FLAG ==="
