#!/usr/bin/env bash
#
# Publish a workspace's E2E coverage to the Codecov project of the repository
# the plugin SOURCES live in, browsable file by file.
#
# Usage:
#   ./scripts/upload-coverage-upstream.sh <workspace> <coverage-source> [flags]
#
# <coverage-source> is either a local directory of the run's per-test coverage
# JSONs, or the gcsweb URL of a Prow run's .../artifacts/e2e-test-results/
# coverage/ listing, which is downloaded for you.
#
# Flags:
#   --dry-run      resolve and remap everything, upload nothing.
#   --pinned-only  upload to the pinned repo-ref but NOT to the default-branch
#                  HEAD. The HEAD copy is a one-way door: once the flag exists
#                  there, carryforward keeps it on every later commit and
#                  removing it needs Codecov UI access on a repo we may not
#                  administer. The pinned-ref copy has no such reach, so a first
#                  real run against a shared project can be staged behind this
#                  flag and reviewed before the visible copy is published.
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
#      source repo's current default-branch HEAD, because a report on a
#      historical commit is never reachable from the default branch: Codecov's
#      carryforward inherits from the parent commit's finalised report, and every
#      commit between the pinned ref and now was finalised without this flag.
#      Measured 2026-08-10: e2e-orchestrator has a report at its pinned ref and
#      files=0 on all ~30 main commits processed after that upload landed, while
#      the unit-test flag carries forward normally on those same commits.
#
#      The HEAD copy was verified end to end on 2026-08-10 with real coverage
#      from the Prow run of overlay PR #3200: e2e-intelligent-assistant went from
#      files=0 to files=99 at rhdh-plugins main HEAD 008c3da9, browsable per
#      file, and the commit's own coverage moved 58.52 -> 58.74. So the HEAD copy
#      is the one anyone sees; the pinned-ref copy is the exactly-attributed one.
#      Source drift between the two measured 0-14% per workspace, and does not
#      track the ref's age — churn does.
#
# Required environment:
#   CODECOV_RHDH_PLUGINS_TOKEN
#       Codecov upload token for the redhat-developer/rhdh-plugins project — the
#       same value that repository holds as its own CODECOV_TOKEN. Named for the
#       project rather than "upstream" on purpose: Codecov tokens are per
#       project, so this one authorises exactly one destination and a generic
#       name would suggest otherwise. It is NOT the CODECOV_TOKEN this repo uses
#       for its own anchor uploads. Not needed for --dry-run.
#
# Test seams (scripts/tests/test_upload_coverage_upstream.py):
#   CODECOV_BIN
#       Path to the Codecov CLI, so tests stub it instead of downloading and
#       calling the real one.
#   UPSTREAM_CHECKOUT_DIR
#       Reuse an existing checkout instead of cloning, so tests never reach
#       GitHub.
#   REMAP_BIN
#       Path to the remap step. remap-lcov.sh npm-installs the istanbul
#       libraries on every run, which is too heavy and too networked for a unit
#       test; the remap itself is covered separately against a fixture.

set -euo pipefail

# Same values and same reasoning as upload-coverage.sh — kept in step so the two
# uploaders do not develop different ideas about what a transient failure is.
# Overridable so the unit tests do not pay the delay.
readonly UPLOAD_ATTEMPTS=2
readonly UPLOAD_RETRY_DELAY_SECONDS="${UPLOAD_RETRY_DELAY_SECONDS:-10}"

WORKSPACE="${1:?Usage: $0 <workspace> <coverage-source> [--dry-run] [--pinned-only]}"
COVERAGE_SOURCE="${2:?Usage: $0 <workspace> <coverage-source> [--dry-run] [--pinned-only]}"
shift 2
DRY_RUN="false"
PINNED_ONLY="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN="true" ;;
    --pinned-only) PINNED_ONLY="true" ;;
    *)
      echo "ERROR: unknown argument '$1' (expected --dry-run or --pinned-only)" >&2
      exit 1
      ;;
  esac
  shift
done

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

if [[ ! "$COVERAGE_SOURCE" =~ ^https?:// && ! -d "$COVERAGE_SOURCE" ]]; then
  echo "ERROR: coverage source is neither a URL nor a directory: $COVERAGE_SOURCE" >&2
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
#
# Adding an entry here is NOT sufficient on its own. Codecov tokens are per
# project, and this script carries one — CODECOV_RHDH_PLUGINS_TOKEN. A second
# destination needs its own token and a way to select between them, so treat
# this list as "the one project, written as a list" rather than an extension
# point that only needs appending to.
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

if [[ "$DRY_RUN" != "true" && -z "${CODECOV_RHDH_PLUGINS_TOKEN:-}" ]]; then
  echo "ERROR: CODECOV_RHDH_PLUGINS_TOKEN is not set — the upload would reach" >&2
  echo "       nothing. Use --dry-run to exercise the remap without it." >&2
  exit 1
fi

echo "=== Upstream E2E coverage: $WORKSPACE ==="
echo "  Source repo: $SLUG"
echo "  Pinned ref:  $PINNED_REF"
echo "  Flag:        $FLAG"

WORK_DIR="$(mktemp -d)"
# Absolute on purpose: remap-lcov.sh runs the remap from the repo root, so a
# relative path handed in through UPSTREAM_CHECKOUT_DIR would silently resolve
# against that root instead of the caller's directory.
if [[ -n "${UPSTREAM_CHECKOUT_DIR:-}" ]]; then
  UPSTREAM_CHECKOUT="$(cd "$UPSTREAM_CHECKOUT_DIR" && pwd)"
else
  UPSTREAM_CHECKOUT="$WORK_DIR/src"
fi
REPORT_DIR="$WORK_DIR/report"
# Keep the clone when it was handed to us: deleting a caller's checkout (or a
# test fixture) is not ours to do.
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Resolved BEFORE the clone on purpose. A gcsweb listing URL is downloaded by
# the shared helper; a local path is used as-is. An e2e run that legitimately
# produced no coverage (backend-only or uninstrumented) leaves the directory
# empty, and that is not this script's failure to report — exit cleanly rather
# than turning a passing run red. Doing it first means such a run does not pay
# for a shallow clone of a large monorepo it is about to throw away.
if [[ "$COVERAGE_SOURCE" =~ ^https?:// ]]; then
  JSON_DIR="$WORK_DIR/coverage-json"
  echo ""
  "$SCRIPT_DIR/download-coverage-json.sh" "$COVERAGE_SOURCE" "$JSON_DIR"
else
  JSON_DIR="$COVERAGE_SOURCE"
fi

if ! compgen -G "$JSON_DIR/*.json" >/dev/null; then
  echo "[INFO] No coverage JSONs in $JSON_DIR — nothing to publish upstream."
  exit 0
fi

if [[ -z "${UPSTREAM_CHECKOUT_DIR:-}" ]]; then
  echo ""
  echo "--- Shallow clone of $SLUG at $PINNED_REF ---"
  # A pinned SHA is not a ref, so it cannot be cloned with --branch. Fetching it
  # by SHA into an empty repo keeps the download to one commit instead of the
  # full history a plain clone would pull.
  git init -q "$UPSTREAM_CHECKOUT"
  git -C "$UPSTREAM_CHECKOUT" remote add origin "https://github.com/$SLUG"
  if ! git -C "$UPSTREAM_CHECKOUT" fetch -q --depth 1 origin "$PINNED_REF"; then
    echo "ERROR: could not fetch $PINNED_REF from $SLUG." >&2
    echo "       The ref may have been garbage-collected or force-pushed away." >&2
    exit 1
  fi
  git -C "$UPSTREAM_CHECKOUT" checkout -q FETCH_HEAD
fi

# Both upload targets are resolved before the remap, so a lookup failure costs a
# fast exit rather than an npm install and a full remap first. One --symref query
# yields the default branch's NAME and its tip together, and they must agree:
# --branch tells Codecov which branch's trend the report joins, so hardcoding
# "main" while resolving the tip of whatever HEAD points at would attach the
# report to a branch that may not exist.
LS_REMOTE_STDERR="$WORK_DIR/ls-remote.err"
if ! LS_REMOTE_OUTPUT="$(git -C "$UPSTREAM_CHECKOUT" ls-remote --symref origin HEAD 2>"$LS_REMOTE_STDERR")"; then
  # Keep git's own message: "could not resolve the default branch" on its own
  # says nothing about whether this was auth, DNS, or a deleted repo.
  echo "ERROR: could not query $SLUG for its default branch:" >&2
  sed 's/^/       /' "$LS_REMOTE_STDERR" >&2
  exit 1
fi
DEFAULT_BRANCH="$(sed -n 's#^ref: refs/heads/\([^[:space:]]*\).*#\1#p' <<<"$LS_REMOTE_OUTPUT" | head -1)"
DEFAULT_BRANCH_SHA="$(awk '$2 == "HEAD" {print $1; exit}' <<<"$LS_REMOTE_OUTPUT")"

if [[ -z "$DEFAULT_BRANCH" ]]; then
  # Attaching to the wrong branch is worse than not attaching: the report joins
  # a trend it does not belong to, and nobody looking at the real default branch
  # ever sees it.
  echo "ERROR: $SLUG reported no symbolic HEAD, so its default branch is unknown." >&2
  exit 1
fi
echo "  Branch:      $DEFAULT_BRANCH"

echo ""
echo "--- Remapping onto upstream source paths ---"
"${REMAP_BIN:-$SCRIPT_DIR/remap-lcov.sh}" "$JSON_DIR" "$REPORT_DIR" \
  --upstream-root "$UPSTREAM_CHECKOUT" --upstream-workspace "$WORKSPACE"

LCOV_FILE="$REPORT_DIR/lcov.info"
if [[ ! -s "$LCOV_FILE" ]]; then
  echo "ERROR: remap produced no lcov at $LCOV_FILE." >&2
  exit 1
fi

# Both SHAs are resolved before either upload, so failing to determine HEAD does
# not leave the pinned-ref copy uploaded and the visible one missing.
UPLOAD_SHAS=("$PINNED_REF")
if [[ "$PINNED_ONLY" == "true" ]]; then
  echo ""
  echo "[--pinned-only] skipping the $DEFAULT_BRANCH HEAD copy; the flag will"
  echo "                NOT be visible on the default branch until a full run."
elif [[ "$DEFAULT_BRANCH_SHA" == "$PINNED_REF" ]]; then
  # The pinned ref IS the branch tip, which is the normal state right after
  # update-plugins-repo-refs bumps a workspace. One upload covers both roles, and
  # saying "could not resolve HEAD" here would be plainly false.
  echo ""
  echo "[INFO] the pinned ref is already $DEFAULT_BRANCH HEAD — one upload covers"
  echo "       both the exact attribution and the default-branch view."
elif [[ "$DEFAULT_BRANCH_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  UPLOAD_SHAS+=("$DEFAULT_BRANCH_SHA")
else
  # Not fatal: the exactly-attributed copy is still worth publishing, and a
  # later run will carry the HEAD copy. Silence here would hide why the flag
  # never appears on the default branch, which is the whole point of the copy.
  echo "[WARN] could not resolve $SLUG $DEFAULT_BRANCH HEAD — uploading to the" >&2
  echo "       pinned ref only. The flag will not be visible on the default branch." >&2
fi

# Codecov treats an upload whose --name matches an existing session on the same
# commit as a REPLACEMENT for it. A fixed name therefore collides with every
# previous run's session, including the spike uploads already sitting on these
# pinned commits. Deriving the name from the report's content keeps the useful
# half of that behaviour and drops the harmful half: re-uploading identical data
# collapses onto the same session (idempotent retries), while a genuinely
# different measurement gets its own.
# git hash-object rather than sha256sum: git is already a hard dependency here
# (the clone above), and it behaves identically everywhere, so this avoids a
# second copy of the sha256sum/shasum fallback that ensure-codecov-cli.sh needs.
# Any content-stable digest works — this one only has to differ when the report
# does.
LCOV_DIGEST="$(git hash-object "$LCOV_FILE" | cut -c1-8)"
readonly UPLOAD_NAME="overlay-$FLAG-$LCOV_DIGEST"

CODECOV_BIN="${CODECOV_BIN:-/tmp/codecov}"
if [[ "$DRY_RUN" != "true" && ! -x "$CODECOV_BIN" ]]; then
  "$SCRIPT_DIR/ensure-codecov-cli.sh" "$CODECOV_BIN"
fi

FAILED_SHAS=()
for sha in "${UPLOAD_SHAS[@]}"; do
  label="pinned ref"
  [[ "$sha" != "$PINNED_REF" ]] && label="$DEFAULT_BRANCH HEAD"
  echo ""
  echo "--- Upload to $sha ($label) ---"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] would upload $LCOV_FILE"
    echo "[DRY-RUN]   --slug $SLUG --sha $sha --flag $FLAG --branch $DEFAULT_BRANCH --name $UPLOAD_NAME"
    continue
  fi

  # Retried for the same reason upload-coverage.sh retries (see its
  # UPLOAD_ATTEMPTS comment): a transient 5xx or DNS blip should not need a
  # human. It matters more here — this job is dispatched by hand, so a blip on
  # the second upload costs a re-dispatch rather than the next scheduled run.
  uploaded="false"
  for attempt in $(seq 1 "$UPLOAD_ATTEMPTS"); do
    # Run from inside the checkout — see constraint 1 at the top.
    if (cd "$UPSTREAM_CHECKOUT" && "$CODECOV_BIN" upload-process \
      --token "$CODECOV_RHDH_PLUGINS_TOKEN" \
      --slug "$SLUG" \
      --sha "$sha" \
      --branch "$DEFAULT_BRANCH" \
      --git-service github \
      --flag "$FLAG" \
      --file "$LCOV_FILE" \
      --disable-search \
      --name "$UPLOAD_NAME" \
      --fail-on-error); then
      uploaded="true"
      break
    fi
    if [[ "$attempt" -lt "$UPLOAD_ATTEMPTS" ]]; then
      echo "[WARN] upload to $sha failed, retrying in ${UPLOAD_RETRY_DELAY_SECONDS}s" >&2
      # An interrupted sleep must not decide the verdict: under `set -e` a
      # signalled sleep aborts with a non-zero status. Here that would abandon
      # the remaining target mid-loop — the per-target independence this loop
      # exists for — on nothing more than a stray signal.
      sleep "$UPLOAD_RETRY_DELAY_SECONDS" || true
    fi
  done
  if [[ "$uploaded" != "true" ]]; then
    echo "ERROR: upload to $sha failed" >&2
    FAILED_SHAS+=("$sha")
  fi
done

echo ""
if [[ ${#FAILED_SHAS[@]} -gt 0 ]]; then
  echo "ERROR: ${#FAILED_SHAS[@]} of ${#UPLOAD_SHAS[@]} upload(s) failed: ${FAILED_SHAS[*]}" >&2
  exit 1
fi
echo "=== Done: ${#UPLOAD_SHAS[@]} upload(s) for $FLAG ==="
