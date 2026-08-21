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
#   --dry-run      resolve and remap everything, upload nothing. That is both
#                  checkouts and both remaps, on purpose: the copy anyone
#                  actually sees is the HEAD one, and a dry run that skipped it
#                  would not tell you what a real run would publish. It costs
#                  roughly twice what a single-target run does.
#   --pinned-only  upload to the pinned repo-ref but NOT to the default-branch
#                  HEAD. The HEAD copy is a one-way door: once the flag exists
#                  there, carryforward keeps it on every later commit and
#                  removing it needs Codecov UI access on a repo we may not
#                  administer.
#
#                  A pinned-only upload DOES land — the session is on the
#                  commit, in state `merged`, with its own totals. An earlier
#                  version of this comment said otherwise; see point 3 for how
#                  that mistake was made and how to check for yourself.
#
#                  What it does not do is make the flag reachable from the
#                  default branch, which is the whole reason the HEAD copy
#                  exists. So this stages a run in the sense of publishing it
#                  where nobody is looking, not in the sense of previewing what
#                  the visible copy will say.
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
#      HOW TO TELL WHETHER AN UPLOAD LANDED, because getting this wrong cost a
#      day. The commit endpoint does not expose sessions; the uploads one does,
#      and it PAGINATES:
#
#        /api/v2/github/redhat-developer/repos/rhdh-plugins/commits/<sha>/uploads
#
#      Look for a session named `overlay-<flag>-<digest>`. If it is there with
#      totals, the upload landed, whatever the numbers look like.
#
#      Every run checks this for itself now and says so when it cannot confirm,
#      which retires the standing caution this block used to carry about not
#      reading a green run as proof. The caution applies again wherever
#      VERIFY_ATTEMPTS is 0: verification off means nothing was asked, and the
#      run says nothing either way on purpose.
#
#      Two things make a landed upload look like a lost one, and both were
#      mistaken for "the report did not change" on 2026-08-12:
#
#      1. The numbers are counted differently at each end. lcov reports a line
#         as covered or not; Codecov splits it into hits, misses and PARTIALS.
#         extensions remapped to 995/1179 lines here and arrived as 906 hits +
#         260 misses + 292 partials = 1458. A file this side calls 1/1 can read
#         0/1 there with partials=1. Same measurement, finer classification —
#         not, as it first appeared, somebody else's data.
#
#      2. The destination repo's own codecov.yml `ignore:` block drops files
#         after upload. rhdh-plugins ignores `**/src/index.ts` and plugin wiring
#         deliberately, which is why 78 resolved files arrive as 76. The drift
#         warning below compares OUR two remaps and cannot see this, so a gap
#         between "N resolved" and the flag's file count is expected and is not
#         a defect to chase.
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
#       Reuse an existing checkout of the PINNED ref instead of cloning it.
#   UPSTREAM_HEAD_CHECKOUT_DIR
#       The same for the default-branch HEAD checkout. Both are needed to keep a
#       run off the network: setting only the first leaves the HEAD copy cloning
#       from github.com, which is how a "hermetic" test quietly grows a network
#       dependency.
#   REMAP_BIN
#       Path to the remap step. remap-lcov.sh npm-installs the istanbul
#       libraries on every run, which is too heavy and too networked for a unit
#       test; the remap itself is covered separately against a fixture.
#   CODECOV_UPLOADS_API
#       Template for the endpoint the post-upload check reads, with %OWNER%,
#       %REPO% and %SHA% substituted. Tests point it at local files so the check
#       never reaches Codecov.
#   CODECOV_GRAPHQL_API
#       The endpoint the flag-visibility check posts to. Tests point it at a
#       local file; curl serves a file:// URL and ignores the POST body, so one
#       fixture shape covers both seams.
#   VERIFY_ATTEMPTS / VERIFY_DELAY_SECONDS
#       How hard the two post-upload checks try — the session check above and
#       the flag-visibility check. 0 attempts disables both entirely and says
#       nothing, which is what the tests that are not about them use.

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

# The workspace name is what the flag is normally built from — validate it so a
# typo cannot create a ghost e2e-<typo> flag that carryforward then keeps alive
# in a shared project we do not administer. `upstream_flag_for` below can
# override the derived name, and carries its own guard for the same reason.
#
# Deliberately the SAME shape scripts/e2e-comment.cjs enforces, cap and trailing
# hyphen included. This used to be the looser of the two on the reasoning that
# the module always runs first — but this script is a documented entry point on
# its own, and the guard whose stated job is stopping a ghost flag should not be
# the weakest place the name can enter from.
if [[ ! "$WORKSPACE" =~ ^[a-z0-9][a-z0-9-]{0,49}$ || "$WORKSPACE" == *- ]]; then
  echo "ERROR: invalid workspace name '$WORKSPACE'" >&2
  exit 1
fi
# Normally the flag IS `e2e-<workspace>`, derived rather than configured so a
# new workspace needs no bookkeeping here. The exceptions below exist only
# because Codecov has DELETED the derived name.
#
# Deleting a flag on Codecov is a soft delete with no inverse: the GraphQL API
# exposes `deleteFlag` and nothing to undo it, the UI offers no restore, and the
# name stays unusable afterwards. The data does not go anywhere — it stays in
# the report and in the v2 REST listing — but every UI surface hides it, because
# the resolver behind them filters `deleted__isnot=True` while REST does not.
# So a deleted flag can only be replaced, never recovered.
#
# Each entry needs a matching `flag_management.individual_flags` entry in the
# DESTINATION repo's codecov.yml, or the flag loses the path scoping every other
# e2e flag has.
#
# Do not "tidy" an entry away because the suffix looks redundant. Removing one
# silently reverts that workspace to a name Codecov will accept, process, and
# then hide — which is precisely the failure it was added for.
#
# And do NOT mirror this into scripts/upload-coverage.sh or
# scripts/seed-main-coverage.sh. Both derive `e2e-<workspace>` for THIS repo's
# own Codecov project, where e2e-orchestrator is healthy and visible (46.73%
# measured 2026-08-21) — and seed-main-coverage.sh is the one that sets the
# default-branch value the dashboard displays, so it is the more costly of the
# two to get wrong. Renaming there would orphan a good history to fix a problem
# that exists only on the destination project.
upstream_flag_for() {
  # Named rather than used as "$1" throughout, matching every other function in
  # this script (`local sha="$1"`, `local lcov="$1"`, `local out_dir="$1"`).
  local workspace="$1"
  case "$workspace" in
    # e2e-orchestrator was deleted on redhat-developer/rhdh-plugins some time
    # after 2026-08-17. Its data is still there — 142 files, 49.51% at main HEAD
    # b37abc01 — and invisible to everyone. The suffix is NOT a plugin version;
    # orchestrator 6.0.0 has nothing to do with it. It is here because the plain
    # name is burned. Registered upstream by redhat-developer/rhdh-plugins#4436.
    orchestrator) echo "e2e-orchestrator-plugin" ;;
    *) echo "e2e-$workspace" ;;
  esac
}
# Split assignment rather than `readonly FLAG="$(...)"`, matching upload_name_for
# below — where the shape is load-bearing, because `readonly` would make the exit
# status its own and hide a failing substitution from set -e. A `case` plus
# `echo` has no failure path, so here it is the convention, not a live hazard.
FLAG="$(upstream_flag_for "$WORKSPACE")"
readonly FLAG

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

# A shallow checkout of one commit. Used twice — see the HEAD checkout further
# down — because the Codecov CLI sends the file network of the tree it is run
# from, so each upload target needs a tree that IS that commit.
clone_at() {
  local ref="$1" dir="$2"
  # A pinned SHA is not a ref, so it cannot be cloned with --branch. Fetching it
  # by SHA into an empty repo keeps the download to one commit instead of the
  # full history a plain clone would pull.
  git init -q "$dir"
  git -C "$dir" remote add origin "https://github.com/$SLUG"
  if ! git -C "$dir" fetch -q --depth 1 origin "$ref"; then
    echo "ERROR: could not fetch $ref from $SLUG." >&2
    echo "       The ref may have been garbage-collected or force-pushed away." >&2
    return 1
  fi
  git -C "$dir" checkout -q FETCH_HEAD
}

# A warning nobody is expected to go looking for.
#
# This job used to be dispatched by hand, so stderr reached the person who ran
# it. It now fires on every merge, unattended, and every HEAD-copy failure below
# still exits 0 on purpose — the exactly-attributed copy is worth publishing
# without it. That combination is "published nothing anyone can see, reported
# success", which is the failure this whole change exists to remove, so the
# HEAD-copy failures are raised to run annotations rather than left in the log.
warn_loudly() {
  local message="$1" escaped
  echo "[WARN] $message" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    # Escaped the way GitHub documents for workflow command DATA. Every value
    # reaching here today is already constrained — a 40-char SHA, an allowlisted
    # slug, a content digest — so this closes the gap for the next caller rather
    # than a live one, which is the only time it is cheap to close.
    escaped="${message//\%/%25}"
    escaped="${escaped//$'\r'/%0D}"
    escaped="${escaped//$'\n'/%0A}"
    echo "::warning::$FLAG: $escaped"
  fi
}

# The remap, once per upload target. Same reason clone_at exists: each target
# resolves its report paths against ITS OWN tree, so this runs twice with
# different arguments and nothing else different.
remap_onto() {
  local out_dir="$1" root="$2"
  "${REMAP_BIN:-$SCRIPT_DIR/remap-lcov.sh}" "$JSON_DIR" "$out_dir" \
    --upstream-root "$root" --upstream-workspace "$WORKSPACE"
}

if [[ -z "${UPSTREAM_CHECKOUT_DIR:-}" ]]; then
  echo ""
  echo "--- Shallow clone of $SLUG at $PINNED_REF ---"
  clone_at "$PINNED_REF" "$UPSTREAM_CHECKOUT" || exit 1
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
remap_onto "$REPORT_DIR" "$UPSTREAM_CHECKOUT"

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
  # The HEAD copy needs its OWN checkout and its OWN remap, and getting this
  # wrong is silent. The CLI sends the file network of the tree it runs in, so
  # uploading the pinned tree's network against the HEAD sha declares a set of
  # files that is not what that commit contains; Codecov drops the report and
  # the run still reports success. Measured: extensions, pinned 201 commits
  # behind HEAD, uploaded cleanly and changed nothing, while
  # intelligent-assistant at 101 commits behind landed — the difference was how
  # far the workspace had moved, which is not something to leave to luck.
  #
  # Remapping again is not optional either: the paths are resolved against the
  # tree, and a file that moved or was deleted since the pinned ref has no place
  # in the HEAD report.
  echo ""
  echo "--- Shallow clone of $SLUG at $DEFAULT_BRANCH ($DEFAULT_BRANCH_SHA) ---"
  # Absolutised for the same reason the pinned checkout is, and under the same
  # contract: remap-lcov.sh runs the remap from the repo root, so a relative
  # --upstream-root resolves against that root instead of the caller's
  # directory. The default is already absolute; a seam handed in by a caller
  # need not be.
  if [[ -n "${UPSTREAM_HEAD_CHECKOUT_DIR:-}" ]]; then
    HEAD_CHECKOUT="$(cd "$UPSTREAM_HEAD_CHECKOUT_DIR" && pwd)"
  else
    HEAD_CHECKOUT="$WORK_DIR/src-head"
  fi
  # No mkdir: remap-lcov.sh creates its own report dir, which is why the pinned
  # path does not pre-create one either.
  HEAD_REPORT_DIR="$WORK_DIR/report-head"
  if [[ -z "${UPSTREAM_HEAD_CHECKOUT_DIR:-}" ]] && ! clone_at "$DEFAULT_BRANCH_SHA" "$HEAD_CHECKOUT"; then
    warn_loudly "could not check out $DEFAULT_BRANCH HEAD — uploaded to the pinned ref only, so the flag will not be visible on the default branch."
  else
    echo ""
    echo "--- Remapping onto $DEFAULT_BRANCH HEAD paths ---"
    # Guarded, and the guard is the point. remap-coverage.cjs EXITS 1 when
    # nothing resolves against a tree (and on a missing workspace directory) —
    # it does not write an empty lcov. Called bare, that status propagates
    # through `set -e` and kills the run here, before any upload: the
    # exactly-attributed pinned copy this branch says is "still worth
    # publishing" would be lost too, and every later merge touching the
    # workspace would go red for a condition the code below is written to treat
    # as survivable.
    HEAD_LCOV="$HEAD_REPORT_DIR/lcov.info"
    if ! remap_onto "$HEAD_REPORT_DIR" "$HEAD_CHECKOUT" || [[ ! -s "$HEAD_LCOV" ]]; then
      # Every path the run measured has moved or gone since the pinned ref. The
      # pinned copy is still worth publishing; going quiet here is not.
      warn_loudly "the remap resolved nothing against $DEFAULT_BRANCH HEAD — the workspace has moved too far from its pinned ref. Uploaded to the pinned ref only, so the flag will not be visible on the default branch."
    else
      # Reported because it is the number that says how stale the pinned ref has
      # become, and it is invisible otherwise.
      # Compared as SETS, not counts. Churn that removes one measured file and
      # adds another leaves the counts equal while the visible copy is missing
      # something the run measured — the exact drift this is here to surface.
      PINNED_PATHS="$WORK_DIR/pinned-paths"
      HEAD_PATHS="$WORK_DIR/head-paths"
      grep '^SF:' "$LCOV_FILE" | sort -u > "$PINNED_PATHS" || true
      grep '^SF:' "$HEAD_LCOV" | sort -u > "$HEAD_PATHS" || true
      PINNED_FILES="$(wc -l < "$PINNED_PATHS" | tr -d ' ')"
      HEAD_FILES="$(wc -l < "$HEAD_PATHS" | tr -d ' ')"
      LOST="$(comm -23 "$PINNED_PATHS" "$HEAD_PATHS" | wc -l | tr -d ' ')"
      # Not phrased as a subset: both remaps run over the same coverage JSONs
      # against different trees, so HEAD can resolve a file the pinned ref did
      # not have — a plugin added upstream since the ref was pinned.
      echo "[INFO] pinned ref resolved $PINNED_FILES file(s); $DEFAULT_BRANCH HEAD resolved $HEAD_FILES."
      if [[ "$LOST" -gt 0 ]]; then
        warn_loudly "$LOST file(s) measured at the pinned ref no longer resolve at $DEFAULT_BRANCH HEAD and are absent from the copy anyone sees."
      fi
      UPLOAD_SHAS+=("$DEFAULT_BRANCH_SHA")
    fi
  fi
else
  # Not fatal: the exactly-attributed copy is still worth publishing, and a
  # later run will carry the HEAD copy. Silence here would hide why the flag
  # never appears on the default branch, which is the whole point of the copy.
  warn_loudly "could not resolve $SLUG $DEFAULT_BRANCH HEAD — uploaded to the pinned ref only, so the flag will not be visible on the default branch."
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
upload_name_for() {
  # Assigned rather than echoed inline: `echo "$(cmd)"` makes the function's
  # status echo's, so a failed hash-object would yield "overlay-<flag>-" and
  # every target would upload under one colliding constant name — Codecov reads
  # a matching name on a commit as a REPLACEMENT for that session.
  local lcov="$1" digest
  digest="$(git hash-object "$lcov" | cut -c1-8)"
  if [[ -z "$digest" ]]; then
    echo "ERROR: could not digest $lcov for the upload session name." >&2
    return 1
  fi
  echo "overlay-$FLAG-$digest"
}

CODECOV_BIN="${CODECOV_BIN:-/tmp/codecov}"
if [[ "$DRY_RUN" != "true" && ! -x "$CODECOV_BIN" ]]; then
  "$SCRIPT_DIR/ensure-codecov-cli.sh" "$CODECOV_BIN"
fi

# Whether a session with this name is on the commit yet.
#
# Codecov accepts an upload and returns before it has processed it, so "queued
# for processing" is a receipt, not a result — the CLI says it whether or not
# the report ever changes. Everything else in this script guards against
# publishing nothing while reporting success; this is the last place that could
# still happen, and it is the exact blindness that made a landed upload
# indistinguishable from a swallowed one for a day.
#
# Only the uploads endpoint lists sessions, and it PAGINATES — the omission that
# hid them. Read-only and unauthenticated: the destination project is public.
UPLOADS_API="${CODECOV_UPLOADS_API:-https://api.codecov.io/api/v2/github/%OWNER%/repos/%REPO%/commits/%SHA%/uploads}"

uploads_url_for() {
  local sha="$1" owner="${SLUG%%/*}" repo="${SLUG##*/}" url
  url="${UPLOADS_API//%OWNER%/$owner}"
  url="${url//%REPO%/$repo}"
  echo "${url//%SHA%/$sha}"
}

# Prints one session name per line and FAILS if the listing could not be read.
# The caller tells those apart through the EXIT STATUS, not a variable: this is
# consumed through a command substitution, which is a subshell, so anything
# assigned in here is gone by the time the caller looks. The status survives.
# A `next` that repeats itself, or a listing that never ends, would otherwise
# spin until the job's own timeout — turning a diagnostic into the thing that
# kills the publish. Codecov pages 50 at a time and no commit here comes close.
readonly MAX_UPLOAD_PAGES=50

session_names_on() {
  local sha="$1" url next page pages=0
  url="$(uploads_url_for "$sha")"
  while [[ -n "$url" && "$url" != "null" ]]; do
    pages=$((pages + 1))
    if [[ "$pages" -gt "$MAX_UPLOAD_PAGES" ]]; then
      echo "[WARN] stopped after $MAX_UPLOAD_PAGES pages of $sha's upload listing." >&2
      return 1
    fi
    # --fail, because without it an HTTP error IS a successful fetch of an
    # error body: Codecov answers 404 with `{"detail":"Not found."}` and 429
    # with its own JSON, both of which `jq '(.results // [])[]'` reads as an
    # empty listing and exits 0. That routes a rate-limit or a moved endpoint
    # into "no session is on the commit" — the loud message — instead of
    # "could not reach", which is the whole distinction this function draws.
    if ! page="$(curl -sfL --max-time 30 "$url" 2>/dev/null)"; then
      return 1
    fi
    if ! jq -r '(.results // [])[] | .name // empty' <<<"$page" 2>/dev/null; then
      return 1
    fi
    next="$(jq -r '.next // "null"' <<<"$page" 2>/dev/null)"
    # Codecov hands `next` back on the insecure scheme even when asked over TLS.
    # The host is the one we chose, so the scheme is forced rather than
    # followed — written as a swap rather than a literal so nothing here spells
    # out a clear-text URL. file:// is the test seam and is taken as given.
    #
    # Only the file:// arm is covered: the tests serve pages from disk, so no
    # test reaches the scheme-forcing arm, and mutating that arm alone leaves
    # the suite green. Covering it would need a local TLS server, which buys
    # less than it costs — but do not read a green suite as proof of this line.
    case "$next" in
      null | "") url="" ;;
      file://*) url="$next" ;;
      *://*) url="https://${next#*://}" ;;
      *) url="$next" ;;
    esac
  done
}

# Bounded and non-fatal. A slow processing queue is not a failed publish, and
# turning every merge red on a timeout would be worse than the silence it
# replaces — so an unconfirmed upload is raised as an annotation, not an error.
readonly VERIFY_ATTEMPTS="${VERIFY_ATTEMPTS:-5}"
readonly VERIFY_DELAY_SECONDS="${VERIFY_DELAY_SECONDS:-20}"

# The sticky state both post-upload checks share: "the endpoint answered at least
# once, so whatever it said is evidence". Named because the two checks have to agree
# on it — a typo in one of the four comparisons would silently turn a definitive
# observation into "could not reach", which is the dismissible message.
readonly LOOKUP_REACHED="reached"

# What this proves: a session with this report's content is on the commit. What
# it does not prove: that THIS run put it there. The name is a digest of the
# report precisely so a retry collapses onto one session, so an identical
# re-upload confirms the earlier one — which is the right answer for the
# question that matters ("is this coverage on the commit?") and the wrong one
# for "did my upload do something", a question nothing here asks.
verify_landed() {
  local sha="$1" name="$2" attempt=1 names lookup_failed="false" where
  # Nothing was asked, so nothing can be claimed either way — warning here would
  # report a session that was never looked for.
  if [[ "$VERIFY_ATTEMPTS" -le 0 ]]; then
    return 0
  fi

  # An arithmetic loop rather than `seq 1 "$VERIFY_ATTEMPTS"`: BSD seq counts
  # DOWN when first > last, so `seq 1 0` yields "1 0" on macOS and nothing on
  # GNU. The guard above already makes zero unreachable, so this is
  # belt-and-braces — kept because that trap has already cost this repo a
  # fixture that meant opposite things on the two platforms.
  while [[ "$attempt" -le "$VERIFY_ATTEMPTS" ]]; do
    if names="$(session_names_on "$sha")"; then
      # Sticky in the useful direction: one reachable poll that showed the
      # session absent is real evidence, and a blip on a later attempt must not
      # erase it. Last-poll-wins turned four definitive observations into "could
      # not reach", which is the dismissible message and would be false.
      lookup_failed="$LOOKUP_REACHED"
      if grep -qxF "$name" <<<"$names"; then
        echo "[OK]   $sha: session '$name' is on the commit."
        return 0
      fi
    elif [[ "$lookup_failed" != "$LOOKUP_REACHED" ]]; then
      lookup_failed="true"
    fi
    attempt=$((attempt + 1))
    [[ "$attempt" -le "$VERIFY_ATTEMPTS" ]] && { sleep "$VERIFY_DELAY_SECONDS" || true; }
  done

  where="$(uploads_url_for "$sha")"
  if [[ "$lookup_failed" == "true" ]]; then
    warn_loudly "uploaded to $sha but could not reach $where to confirm it — this says nothing about whether the report changed."
  else
    warn_loudly "uploaded to $sha but no session named '$name' is on the commit — the report may not have changed. Check $where (it paginates)."
  fi
  return 1
}

# Whether the flag is VISIBLE, which is a different question from whether the
# upload landed — and the one this script could not answer until 2026-08-21.
#
# A flag that a Codecov admin has deleted keeps accepting uploads, keeps its
# data in the report, and still returns from the v2 REST listing this script
# already reads. It vanishes only from the UI, because the GraphQL resolver
# behind every UI surface filters `deleted__isnot=True` and the REST one does
# not. So `verify_landed` says [OK] twice, the report says 49.51%, and the
# dashboard's flag picker does not offer the flag at all.
#
# That is exactly what happened to e2e-orchestrator on redhat-developer/
# rhdh-plugins: two green publishes (2026-08-13 and 2026-08-17), 142 files on
# main HEAD, and absent from the picker. The deletion is a soft delete that
# Codecov documents as not undoable, with the name unusable afterwards — so
# this cannot heal itself and the only useful response is to say so loudly.
GRAPHQL_API="${CODECOV_GRAPHQL_API:-https://api.codecov.io/graphql/gh}"

# Prints the visible flag names matching $FLAG, one per line, and FAILS if the
# listing could not be read. Same split as session_names_on, for the same
# reason: "the flag is gone" and "I could not ask" read alike in a log and send
# whoever is debugging to opposite places.
visible_flag_names() {
  local owner="${SLUG%%/*}" repo="${SLUG##*/}" payload response
  # `term` is a substring match server-side, so passing the whole flag name
  # keeps the answer small without having to page a repo's entire flag list.
  payload="$(jq -n --arg owner "$owner" --arg repo "$repo" --arg term "$FLAG" \
    '{query: "query($owner:String!,$repo:String!,$term:String!){owner(username:$owner){repository(name:$repo){... on Repository{coverageAnalytics{flags(filters:{term:$term},first:100){edges{node{name}}}}}}}}",
      variables: {owner: $owner, repo: $repo, term: $term}}')" || return 1
  if ! response="$(curl -sfL --max-time 30 -X POST \
    -H 'Content-Type: application/json' --data "$payload" "$GRAPHQL_API" 2>/dev/null)"; then
    return 1
  fi
  # A GraphQL error is an HTTP 200 carrying an `errors` array and a null `data`,
  # which --fail cannot see. Reading that as an empty flag list would report a
  # perfectly live flag as deleted — the loudest wrong answer available here.
  # `.errors // empty` would be wrong here and silently so: on the happy path
  # `.errors` is absent, `// empty` yields `empty`, and `if empty then` makes the
  # WHOLE expression produce nothing — so every healthy response read as "err".
  # Compared against null explicitly instead.
  if [[ "$(jq -r '
        if (.errors != null) then "err"
        elif ((.data.owner.repository.coverageAnalytics.flags.edges | type) == "array") then "ok"
        else "err" end' <<<"$response" 2>/dev/null)" != "ok" ]]; then
    return 1
  fi
  jq -r '.data.owner.repository.coverageAnalytics.flags.edges[].node.name' <<<"$response" 2>/dev/null
}

# Non-fatal, like verify_landed: the coverage IS published either way, and a
# deleted flag needs a human with Codecov admin rights, not a red merge.
#
# Runs once per script run rather than once per upload, because visibility is a
# property of the flag on the destination project — the same answer for both
# SHAs.
#
# It runs only after verify_landed has CONFIRMED a session, and that is what
# makes it safe for a genuinely new flag: the RepositoryFlag row is created when
# the upload is processed, so once a session is on the commit the flag exists,
# and an absence here means deleted rather than not-yet-created. The call site
# enforces that by requiring UNVERIFIED_SHAS to be short of every target — do
# not relax it to "the upload was accepted", which is a different and much
# weaker claim. See the comment there for what that costs.
verify_flag_visible() {
  local names attempt=1 lookup_failed="false"
  # Verification off means nothing was asked; claiming anything would be a
  # finding nobody looked for.
  if [[ "$VERIFY_ATTEMPTS" -le 0 ]]; then
    return 0
  fi

  while [[ "$attempt" -le "$VERIFY_ATTEMPTS" ]]; do
    if names="$(visible_flag_names)"; then
      lookup_failed="$LOOKUP_REACHED"
      if grep -qxF "$FLAG" <<<"$names"; then
        echo "[OK]   flag '$FLAG' is visible on $SLUG."
        return 0
      fi
    elif [[ "$lookup_failed" != "$LOOKUP_REACHED" ]]; then
      lookup_failed="true"
    fi
    attempt=$((attempt + 1))
    [[ "$attempt" -le "$VERIFY_ATTEMPTS" ]] && { sleep "$VERIFY_DELAY_SECONDS" || true; }
  done

  if [[ "$lookup_failed" == "true" ]]; then
    warn_loudly "could not reach $GRAPHQL_API to check whether '$FLAG' is still visible on $SLUG — this says nothing either way."
  else
    warn_loudly "the upload landed but '$FLAG' is NOT in $SLUG's visible flag list, which means a Codecov admin has deleted the flag. The coverage is still in the report and in the v2 REST listing; every UI surface hides it. Deletion is a soft delete Codecov documents as not undoable — this needs a Codecov admin or a new flag name, and re-running this job will not fix it."
  fi
  return 1
}

FAILED_SHAS=()
UNVERIFIED_SHAS=()
for sha in "${UPLOAD_SHAS[@]}"; do
  # Each target uploads ITS OWN tree and ITS OWN remap. Reusing the pinned pair
  # for the HEAD sha is exactly the silent failure this loop was changed to fix.
  if [[ "$sha" == "$PINNED_REF" ]]; then
    label="pinned ref"
    target_root="$UPSTREAM_CHECKOUT"
    target_lcov="$LCOV_FILE"
  else
    label="$DEFAULT_BRANCH HEAD"
    target_root="$HEAD_CHECKOUT"
    target_lcov="$HEAD_LCOV"
  fi
  # Guarded like every other per-target step: a digest failure is one target's
  # problem, and under `set -e` an unguarded assignment here would take the
  # other target down with it — the opposite of what this loop is for.
  if ! upload_name="$(upload_name_for "$target_lcov")"; then
    FAILED_SHAS+=("$sha")
    continue
  fi
  echo ""
  echo "--- Upload to $sha ($label) ---"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] would upload $target_lcov from $target_root"
    echo "[DRY-RUN]   --slug $SLUG --sha $sha --flag $FLAG --branch $DEFAULT_BRANCH --name $upload_name"
    continue
  fi

  # Retried for the same reason upload-coverage.sh retries (see its
  # UPLOAD_ATTEMPTS comment): a transient 5xx or DNS blip should not need a
  # human. It matters more here — this job is dispatched by hand, so a blip on
  # the second upload costs a re-dispatch rather than the next scheduled run.
  uploaded="false"
  for attempt in $(seq 1 "$UPLOAD_ATTEMPTS"); do
    # Run from inside the checkout — see constraint 1 at the top.
    if (cd "$target_root" && "$CODECOV_BIN" upload-process \
      --token "$CODECOV_RHDH_PLUGINS_TOKEN" \
      --slug "$SLUG" \
      --sha "$sha" \
      --branch "$DEFAULT_BRANCH" \
      --git-service github \
      --flag "$FLAG" \
      --file "$target_lcov" \
      --disable-search \
      --name "$upload_name" \
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
  elif ! verify_landed "$sha" "$upload_name"; then
    UNVERIFIED_SHAS+=("$sha")
  fi
done

echo ""
# Only worth asking when something was actually published: on a dry run nothing
# reached Codecov, and when every upload failed the flag's visibility is not the
# problem to report.
#
# A CONFIRMED session is required, not merely an accepted upload — the
# difference is the whole safety of the check. The RepositoryFlag row is created
# when Codecov PROCESSES an upload, so between "accepted" and "processed" a
# perfectly healthy new flag does not exist yet. Gating on FAILED_SHAS alone
# would ask during exactly that window whenever the queue ran slow enough for
# verify_landed to give up, and answer "a Codecov admin has deleted the flag …
# re-running this job will not fix it" — categorical, actionable and false,
# sending someone to open a support ticket over a slow queue. Worse than not
# checking at all, and the same "could not ask" vs "it is gone" confusion this
# file keeps apart everywhere else.
# COMBINED, not two independent comparisons. A target lands in exactly one of
# the two arrays, so what this needs is "at least one target in neither" — and
# with two targets, one failed upload plus one unconfirmed session satisfies
# `FAILED < 2` and `UNVERIFIED < 2` separately while confirming nothing.
if [[ "$DRY_RUN" != "true" \
  && $(( ${#FAILED_SHAS[@]} + ${#UNVERIFIED_SHAS[@]} )) -lt ${#UPLOAD_SHAS[@]} ]]; then
  verify_flag_visible || true
fi

if [[ ${#UNVERIFIED_SHAS[@]} -gt 0 ]]; then
  echo "[WARN] uploaded but unconfirmed: ${UNVERIFIED_SHAS[*]}" >&2
fi
if [[ ${#FAILED_SHAS[@]} -gt 0 ]]; then
  echo "ERROR: ${#FAILED_SHAS[@]} of ${#UPLOAD_SHAS[@]} upload(s) failed: ${FAILED_SHAS[*]}" >&2
  exit 1
fi
echo "=== Done: ${#UPLOAD_SHAS[@]} upload(s) for $FLAG ==="
