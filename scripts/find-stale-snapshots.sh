#!/usr/bin/env bash
#
# List the workspaces whose committed coverage snapshot no longer reflects the
# workspace, one per line. Prints nothing when everything is current.
#
# Usage:
#   ./scripts/find-stale-snapshots.sh
#
# Why this exists:
#   coverage-snapshots/<ws>.lcov is refreshed by refresh-coverage-snapshot.yaml
#   when the e2e bot reports a pass on a PR — but that path only fires for
#   same-repo PRs. It skips forks outright ("Fork PR — skipping snapshot
#   refresh"), because it checks out the PR head and pushes back to it, and
#   neither is safe or possible against a fork. Nearly half of the merged PRs
#   that touch a workspace come from forks, so their coverage is measured, the
#   run passes, and the result is discarded.
#
#   The visible symptom is not a gap but a LIE: the flag keeps publishing the
#   last number that did land. As of 2026-08-05 bulk-import, global-header and
#   tech-radar were still reporting coverage measured on 2026-06-24/29 against
#   workspaces that had changed on 08-03. A missing number is ignored; a stale
#   one gets believed.
#
#   This script is the detection half of the fix. It is deliberately pure and
#   local — only git and the working tree — so it can be unit tested. Resolving
#   a workspace to a coverage artifact and refreshing it is the caller's job
#   (.github/workflows/refresh-stale-coverage-snapshots.yaml).
#
# Staleness is "the workspace changed after its snapshot did". That over-reports
# rather than under-reports: a commit touching only a workspace's README marks
# it stale and costs one redundant refresh, which the refresh itself then
# no-ops when the lcov comes back identical. The opposite error — believing a
# stale snapshot is current — is the one that matters.
#
# Requires: git, run from anywhere inside the repo. Needs real history, so a
# shallow clone must fetch with depth 0.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Which committed history to measure against. HEAD is right for CI, where the
# caller has already checked out the branch it wants measured — the accumulation
# branch in refresh-stale-coverage-snapshots.yaml, so snapshots refreshed by an
# earlier run count as current instead of being redone every time. Override it
# to inspect another ref by hand (`STALE_COMPARE_REF=origin/main`).
COMPARE_REF="${STALE_COMPARE_REF:-HEAD}"

# Validated rather than tolerated. `git log` on an unknown ref exits non-zero
# with no output, which would read as "no snapshot" for every workspace — the
# script would print all of them, exit 0, and the caller would burn its whole
# refresh budget on a list produced by a typo.
if ! git rev-parse --verify --quiet "${COMPARE_REF}^{commit}" >/dev/null; then
  echo "ERROR: STALE_COMPARE_REF='${COMPARE_REF}' is not a commit in this repository" >&2
  exit 1
fi

shopt -s nullglob
anchor_dirs=("$REPO_ROOT"/workspaces/*/coverage-anchors)
shopt -u nullglob

# `"${arr[@]}"` on an empty array is an unbound-variable error under `set -u` on
# bash 3.2, which is what macOS still ships as /bin/bash. `${#arr[@]}` is safe
# there, so guard the same way seed-main-coverage.sh does.
if [[ ${#anchor_dirs[@]} -eq 0 ]]; then
  exit 0
fi

for dir in "${anchor_dirs[@]}"; do
  ws="$(basename "$(dirname "$dir")")"

  # A workspace with no frontend plugin cannot produce browser coverage at all:
  # the instrumented bundles are loaded and executed in the page, and a
  # backend-only workspace never puts one there. Reporting these as stale would
  # queue a refresh that can only ever come back empty, every single run.
  #
  # Matched on the `role:` value exactly, because that is the rule
  # instrument-plugin.sh applies when deciding what to instrument
  # (`[[ "$PLUGIN_ROLE" != "frontend-plugin" ]]`). A substring match would also
  # accept `frontend-plugin-module`, which that script SKIPS — so such a
  # workspace would be refreshed forever and come back empty every time, which
  # is the exact loop this exclusion exists to prevent.
  if ! grep -rqsE '^[[:space:]]*role:[[:space:]]*frontend-plugin[[:space:]]*$' \
    "$REPO_ROOT/workspaces/$ws/metadata/"; then
    continue
  fi

  snapshot="coverage-snapshots/$ws.lcov"

  # Absence is checked against the ref, not only through `git log`. A DELETION
  # also shows up in `git log -1` for the path, and its date is by definition
  # newer than whatever last touched the workspace — so history alone reports a
  # deleted snapshot as current, forever. That is reachable on purpose:
  # seed-main-coverage.sh tells operators to delete an orphaned snapshot, and
  # deleting one to force a regeneration is the obvious move. Either would make
  # the workspace invisible here while its flag kept publishing the last number.
  if ! git cat-file -e "${COMPARE_REF}:${snapshot}" 2>/dev/null; then
    echo "$ws"
    continue
  fi

  # Epoch seconds, NOT %cI. %cI renders each commit in its own committer's
  # offset — this repo's history carries +02:00, -04:00, +05:30 and -03:00 — so
  # comparing those strings lexicographically compares wall-clock readings from
  # different timezones. It gets both directions wrong within the offset spread,
  # and the accumulation branch makes that the common case: its commits are
  # written on a UTC runner (git renders those as `Z`, which sorts above every
  # digit and above `+`/`-`), while workspace commits carry contributors'
  # offsets. %ct is an absolute instant and removes offset, `Z`-vs-`+` and
  # locale collation from the comparison in one move.
  snapshot_ts="$(git log -1 --format=%ct "$COMPARE_REF" -- "$snapshot")"
  workspace_ts="$(git log -1 --format=%ct "$COMPARE_REF" -- "workspaces/$ws/")"

  # A snapshot present in the tree always has a commit, so an empty timestamp
  # here would mean the ref moved under us — treat it as stale rather than
  # silently skipping.
  if [[ -z "$snapshot_ts" ]]; then
    echo "$ws"
    continue
  fi
  [[ -z "$workspace_ts" ]] && continue

  if (( workspace_ts > snapshot_ts )); then
    echo "$ws"
  fi
done
