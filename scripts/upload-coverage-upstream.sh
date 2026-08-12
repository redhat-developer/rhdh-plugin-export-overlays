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
#                  This flag was written to stage a first run for review, and
#                  that is NOT what it does. A pinned-only upload of the
#                  extensions workspace was accepted by Codecov (556 KB stored,
#                  queued) and ten minutes later the pinned commit still
#                  reported the same session count and the same per-file
#                  numbers, none of them the uploaded ones. A report uploaded
#                  onto a historical commit has not been observed to change
#                  that commit's report, so there is nothing to review. WHY that
#                  is has not been established — see point 3, which is the one
#                  account of it; do not infer a mechanism from here.
#                  Keep the flag for staging only if that changes.
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
#      That verification was read as "the HEAD copy works" for longer than it
#      should have been. On 2026-08-12 the same path was run for extensions,
#      whose pinned ref sits 201 commits behind HEAD, and NOTHING landed: the
#      flag on main HEAD kept showing an older measurement, and two files this
#      run covers with real numbers (plugins/extensions/src/index.ts 3/3 and
#      plugin.ts 18/25) were absent from the report entirely. Both uploads were
#      accepted, queued and reported success.
#
#      One cause is fixed here: every upload now runs from a checkout OF THE SHA
#      IT DECLARES, and is remapped against that tree. Before, both uploads ran
#      from the pinned clone, so the HEAD copy declared the pinned tree's file
#      list against a different commit.
#
#      That does NOT explain the whole observation, and the gap is left written
#      down rather than smoothed over: the PINNED copy had the correct tree and
#      also did not land. What both failures share is a flag that already had a
#      carried-forward report on the target commit, which intelligent-assistant
#      did not. Whether Codecov declines to recompute such a commit is not
#      established — do not assume a green run here means the report changed.
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
  local message="$1"
  echo "[WARN] $message" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning::$FLAG: $message"
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

FAILED_SHAS=()
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
  fi
done

echo ""
if [[ ${#FAILED_SHAS[@]} -gt 0 ]]; then
  echo "ERROR: ${#FAILED_SHAS[@]} of ${#UPLOAD_SHAS[@]} upload(s) failed: ${FAILED_SHAS[*]}" >&2
  exit 1
fi
echo "=== Done: ${#UPLOAD_SHAS[@]} upload(s) for $FLAG ==="
