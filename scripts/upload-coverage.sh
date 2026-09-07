#!/usr/bin/env bash
#
# Upload Istanbul/lcov coverage to Codecov, attributed to THIS repo's commit.
#
# Usage:
#   ./scripts/upload-coverage.sh <workspace-name> [lcov-file]
#
# Example:
#   ./scripts/upload-coverage.sh tech-radar coverage-snapshots/tech-radar.lcov
#
# lcov-file defaults to coverage/lcov.info, which only matters for a manual run:
# the sole automated caller — the seed (scripts/seed-main-coverage.sh, run by
# seed-coverage-main.yaml) — always passes an explicit coverage-snapshots/<ws>.lcov
# so every `e2e-<workspace>` flag carries only its own workspace's data. The seed
# is the only path that uploads to Codecov; the per-PR e2e run no longer uploads,
# it just produces the coverage artifacts the snapshot refresh consumes.
#
# Coverage is uploaded to the Codecov project of this overlay repo
# (redhat-developer/rhdh-plugin-export-overlays), flagged `e2e-<workspace>`,
# against the overlay commit currently being tested. That avoids needing other
# orgs' Codecov tokens and keeps RHDH-specific E2E numbers off upstream
# community dashboards.
#
# An earlier version attributed coverage to the upstream source repo plus the
# historical `repo-ref` commit from source.json. It produced a flag stuck at
# 0.00% on rhdh-plugins and was reverted in #2580, recorded there as "Codecov
# finalizes a commit's report shortly after that commit's own CI completes —
# uploads to an already-finalized historical commit are accepted by the API and
# never displayed".
#
# That diagnosis does NOT hold. A cross-project upload was actually performed on
# 2026-08-05 — real orchestrator e2e coverage from PR #3120, remapped to
# source-repo paths, sent to the rhdh-plugins project at orchestrator's
# source.json SHA. The target report was `state: complete` with 24 sessions and
# it still moved:
#
#     sessions 24 -> 25   coverage 58.12 -> 58.05   (134 of our 149 paths present)
#
# So a late upload to a finalized commit is accepted, registered AND recomputed.
#
# The 0.00% flag has a different cause, and it is not path prefixes either. An
# earlier revision of this comment claimed it was; that was wrong. The test used
# correct paths (151/151 resolved against a checkout at the pinned SHA) and its
# `e2e-orchestrator` flag ALSO reads 0.0%, right beside the pilot's `e2e-theme`.
# The flags page reports each flag's coverage on the DEFAULT BRANCH. Both uploads
# targeted a historical commit and never the default-branch HEAD, so both read
# 0.0% there regardless of path correctness.
#
# The real constraint is which commit you attribute to. To surface a number on
# the source repo's dashboard, coverage has to land on a commit of that repo's
# default branch — the same compromise this seed already makes for itself, since
# it uploads to the current main HEAD rather than to the commit the coverage was
# measured against. Correct paths are still required for line-level annotation;
# they are simply not what the 0.0% was about.
#
# Remaining work if this is revived: a reliable remote -> plugin-directory
# mapping. Deriving it from the scalprum remote name resolves only 82 of 95
# committed anchors (roadie-backstage-plugins fails outright). Resolving against
# a checkout of the source repo resolved 151/151, including sibling packages
# (`orchestrator-common/src/...` must not take the owning plugin's prefix), but
# the remap step has no source tree in CI. See RHIDP-13411.
#
# Trade-off: this repo does not contain the plugin source files, so Codecov
# cannot render line-level annotations — only the per-flag coverage percentage
# and its trend, which is the metric we want from E2E runs.
#
# Required environment:
#   CODECOV_TOKEN         - Codecov upload token for this repo's project.
#                           Falls back to VAULT_CODECOV_TOKEN (see below).
# Optional environment:
#   CODECOV_UPLOAD_SLUG   - GitHub slug of the Codecov project to upload to.
#                           Default: redhat-developer/rhdh-plugin-export-overlays.
#   CODECOV_UPLOAD_STRICT - "true" to exit non-zero whenever Codecov did not
#                           receive the report — a failed upload OR a missing
#                           token. Default (unset) keeps the historical
#                           non-blocking behaviour — see the exit-code contract
#                           at the upload call below.
#   PULL_PULL_SHA         - PR head SHA (set by Prow presubmits).
#   PULL_NUMBER           - PR number (set by Prow presubmits).
#   PULL_BASE_REF         - Base branch (set by Prow postsubmits) — used as the
#                           upload branch when there is no PR number.
#   GITHUB_SHA            - Commit SHA (set by GitHub Actions).
#   GIT_PR_NUMBER         - PR number fallback (exported by the E2E CI step).
#
# Test seams (scripts/tests/test_upload_coverage.py) — production leaves these
# at their defaults:
#   CODECOV_BIN                 - path to the Codecov CLI, so tests can stub it
#                                 instead of downloading and calling the real one.
#   UPLOAD_RETRY_DELAY_SECONDS  - retry backoff, so tests don't wait it out.

set -euo pipefail

# OpenShift CI auto-exports Vault secret keys prefixed with VAULT_ (the
# rhdh-plugin-export-overlays ocp-helm step mounts the test-credentials secret
# and exports every VAULT_* key). Accept VAULT_CODECOV_TOKEN as a fallback so the
# token only has to be added to that Vault secret — no openshift/release change.
: "${CODECOV_TOKEN:=${VAULT_CODECOV_TOKEN:-}}"

# Resolved once so every "did anything reach Codecov" branch below tests the same
# thing — see the exit-code contract at the upload call.
#
# Rejected rather than defaulted when unrecognized: silently treating STRICT=1 or
# STRICT=yes as non-strict would hand back the exact silent green this flag
# exists to prevent, and a caller that bothered to set it clearly wanted it.
case "${CODECOV_UPLOAD_STRICT:-false}" in
  true)  readonly UPLOAD_STRICT=true ;;
  false) readonly UPLOAD_STRICT=false ;;
  *)
    echo "ERROR: CODECOV_UPLOAD_STRICT must be 'true' or 'false' (got '${CODECOV_UPLOAD_STRICT}')" >&2
    exit 1
    ;;
esac

# One retry, no more: a strict caller runs on a schedule, so a transient 5xx or
# DNS blip would otherwise turn a healthy day red and train people to ignore the
# alert — while a longer backoff chain would just delay a real outage's verdict.
readonly UPLOAD_ATTEMPTS=2

# Long enough to ride out a brief Codecov blip or DNS hiccup, short enough that
# a genuine outage still fails the job promptly (the seed uploads one snapshot
# per workspace in sequence). Overridable so the unit tests don't pay it.
readonly UPLOAD_RETRY_DELAY_SECONDS="${UPLOAD_RETRY_DELAY_SECONDS:-10}"

WORKSPACE="${1:?Usage: $0 <workspace-name> [lcov-file]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LCOV_FILE="${2:-$REPO_ROOT/coverage/lcov.info}"

# The workspace name becomes the Codecov flag verbatim — validate it so a typo
# doesn't create a ghost e2e-<typo> flag that carryforward then keeps alive.
if [[ ! -d "$REPO_ROOT/workspaces/$WORKSPACE" ]]; then
  echo "ERROR: Unknown workspace '$WORKSPACE' (no workspaces/$WORKSPACE directory)" >&2
  exit 1
fi

# The namespace this workspace's coverage lives under on the dashboard (see
# codecov.yml). Named once so the upload and every message about it can never
# disagree.
readonly FLAG="e2e-$WORKSPACE"

if [[ ! -f "$LCOV_FILE" ]]; then
  echo "ERROR: No lcov file found at $LCOV_FILE" >&2
  echo "Run tests with E2E_COLLECT_COVERAGE=true first" >&2
  exit 1
fi

UPLOAD_SLUG="${CODECOV_UPLOAD_SLUG:-redhat-developer/rhdh-plugin-export-overlays}"

# Resolve the overlay commit to attribute the coverage to. Codecov requires a
# SHA that exists on GitHub:
#   - Prow presubmits check out a synthetic merge of the PR onto the base
#     branch, so `git rev-parse HEAD` would yield a commit GitHub doesn't know.
#     Use PULL_PULL_SHA (the PR head) instead. (Prow *batch* jobs don't set
#     PULL_PULL_SHA and would fall through to the synthetic batch-merge HEAD —
#     this optional job isn't batched today, but if that changes the fallback
#     needs a JOB_TYPE=batch guard.)
#   - GITHUB_SHA covers GitHub Actions push/schedule events only. On
#     pull_request events it is the synthetic refs/pull/N/merge commit, NOT the
#     PR head — an Actions PR job would need the head SHA from the event
#     payload instead. Coverage currently only flows through Prow, so this
#     path is for completeness.
#   - Periodics / local runs sit on a real pushed commit; HEAD is fine.
if [[ -n "${PULL_PULL_SHA:-}" ]]; then
  UPLOAD_SHA="$PULL_PULL_SHA"
elif [[ -n "${GITHUB_SHA:-}" ]]; then
  UPLOAD_SHA="$GITHUB_SHA"
else
  UPLOAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
fi

if [[ ! "$UPLOAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: Could not resolve a 40-char overlay commit SHA (got '$UPLOAD_SHA')" >&2
  exit 1
fi

# PR number gets the same strictness as the SHA above: a malformed value would
# produce another accepted-but-misattributed upload.
PR_NUMBER="${PULL_NUMBER:-${GIT_PR_NUMBER:-}}"
if [[ -n "$PR_NUMBER" && ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "[WARN] Ignoring non-numeric PR number '$PR_NUMBER'" >&2
  PR_NUMBER=""
fi

# Without a PR, Codecov needs an explicit branch or the upload won't attach to
# the default-branch trend (CI checkouts are detached HEAD, so the CLI's own
# git detection finds nothing useful). PULL_BASE_REF covers Prow postsubmits;
# otherwise use the real local branch, mapping detached HEAD (periodics) to
# the default branch.
UPLOAD_BRANCH=""
if [[ -z "$PR_NUMBER" ]]; then
  UPLOAD_BRANCH="${PULL_BASE_REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}"
  [[ "$UPLOAD_BRANCH" == "HEAD" ]] && UPLOAD_BRANCH="main"
fi

echo "=== Uploading E2E coverage to Codecov ==="
echo "  Workspace:  $WORKSPACE"
echo "  LCOV file:  $LCOV_FILE"
echo "  Target repo: $UPLOAD_SLUG"
echo "  Target SHA:  $UPLOAD_SHA"
[[ -n "$PR_NUMBER" ]] && echo "  PR:          #$PR_NUMBER"
[[ -n "$UPLOAD_BRANCH" ]] && echo "  Branch:      $UPLOAD_BRANCH"
echo "  Flag:        $FLAG"

if [[ -z "${CODECOV_TOKEN:-}" ]]; then
  echo ""
  echo "[WARN] CODECOV_TOKEN is not set — skipping Codecov upload"
  echo "[INFO] Coverage report is still available locally at: $LCOV_FILE"
  # Strict is about "did Codecov actually receive this", so it has to cover the
  # path where nothing is even attempted. Without this, a strict caller missing
  # the token exits 0 having uploaded nothing — the silent green strict exists
  # to eliminate.
  if [[ "$UPLOAD_STRICT" == "true" ]]; then
    echo "ERROR: CODECOV_UPLOAD_STRICT=true and no token — nothing was uploaded." >&2
    exit 1
  fi
  exit 0
fi

# Codecov CLI, downloaded and checksum-verified by the shared helper so this
# path and upload-coverage-upstream.sh cannot drift to different pinned
# versions. CODECOV_BIN still overrides the location — the seam the unit tests
# use to point at a stub instead of downloading the real one.
CODECOV_BIN="${CODECOV_BIN:-/tmp/codecov}"
if [[ ! -x "$CODECOV_BIN" ]]; then
  echo ""
  "$SCRIPT_DIR/ensure-codecov-cli.sh" "$CODECOV_BIN"
fi

readonly COMMIT_URL="https://app.codecov.io/gh/$UPLOAD_SLUG/commit/$UPLOAD_SHA"

CODECOV_ARGS=(
  --file "$LCOV_FILE"
  --flag "$FLAG"
  --sha "$UPLOAD_SHA"
  --slug "$UPLOAD_SLUG"
  --token "$CODECOV_TOKEN"
  --git-service github
  --name "overlay-$FLAG"
  --disable-search
  --fail-on-error
)
[[ -n "$PR_NUMBER" ]] && CODECOV_ARGS+=(--pr "$PR_NUMBER")
[[ -n "$UPLOAD_BRANCH" ]] && CODECOV_ARGS+=(--branch "$UPLOAD_BRANCH")

echo ""
# Exit-code contract for a failed upload, selected by CODECOV_UPLOAD_STRICT:
#
#   unset/false (default) - exit 0. For a caller whose real job is something else
#     and merely uploads coverage on the side (the Prow e2e run used to do this):
#     coverage is informational, so Codecov being down must not fail that job.
#     The lcov is still on disk, and a human reading the log sees the banner.
#
#   true - exit non-zero. For a caller whose ONLY job is the upload — today
#     scripts/seed-main-coverage.sh, the sole automated caller. There, swallowing
#     the failure makes the job report "seeded" while Codecov received nothing,
#     so the dashboard silently goes stale with a green check. That is the exact
#     failure mode seed-main-coverage.sh already guards against for a missing
#     token ("the job would go green while uploading nothing"); this closes the
#     same hole for the upload itself.
#
# Either verdict is reached only after UPLOAD_ATTEMPTS tries. Uploads are
# idempotent (same flag+sha+name), so a retry after a failure that actually
# landed server-side is harmless.
for attempt in $(seq 1 "$UPLOAD_ATTEMPTS"); do
  if "$CODECOV_BIN" upload-process "${CODECOV_ARGS[@]}"; then
    echo ""
    echo "=== Upload complete (attempt $attempt/$UPLOAD_ATTEMPTS) ==="
    echo "  View coverage at: $COMMIT_URL"
    echo "  Filter by flag: $FLAG"
    exit 0
  fi
  if [[ "$attempt" -lt "$UPLOAD_ATTEMPTS" ]]; then
    echo "[WARN] Codecov upload attempt $attempt did not go through — retrying in ${UPLOAD_RETRY_DELAY_SECONDS}s..." >&2
    # An interrupted sleep must not decide the verdict: under `set -e` a signalled
    # sleep would abort here with a non-zero status, failing even a non-strict
    # caller this script promises never to fail.
    sleep "$UPLOAD_RETRY_DELAY_SECONDS" || true
  fi
done

# Every attempt failed. Everything from here is a diagnostic, so it goes to
# stderr as one block — splitting it across streams lets CI log capture
# interleave the verdict away from the banner it explains.
{
  echo ""
  echo "=================================================="
  echo "  Codecov upload failed ($UPLOAD_ATTEMPTS attempts)"
  echo "=================================================="
  echo "  LCOV file:   $LCOV_FILE"
  echo "  Target repo: $UPLOAD_SLUG"
  echo "  Target SHA:  $UPLOAD_SHA"
  if [[ "$UPLOAD_STRICT" == "true" ]]; then
    echo "  CODECOV_UPLOAD_STRICT=true — failing so this doesn't pass silently."
  else
    echo "  Non-fatal — the coverage data is still available locally."
  fi
  echo "=================================================="
} >&2

# Explicit `if` so the two exits read as one decision.
if [[ "$UPLOAD_STRICT" == "true" ]]; then
  exit 1
fi
exit 0
