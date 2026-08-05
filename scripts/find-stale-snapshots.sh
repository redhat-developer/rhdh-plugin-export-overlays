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

# Compare against the pushed branch rather than the local checkout, so a run
# from a feature branch reports what main actually carries.
REF="${STALE_COMPARE_REF:-HEAD}"

shopt -s nullglob
anchor_dirs=("$REPO_ROOT"/workspaces/*/coverage-anchors)
shopt -u nullglob

for dir in "${anchor_dirs[@]}"; do
  ws="$(basename "$(dirname "$dir")")"

  # A workspace with no frontend plugin cannot produce browser coverage at all:
  # the instrumented bundles are loaded and executed in the page, and a
  # backend-only workspace never puts one there. Reporting these as stale would
  # queue a refresh that can only ever come back empty, every single run.
  if ! grep -rqs 'frontend-plugin' "$REPO_ROOT/workspaces/$ws/metadata/"; then
    continue
  fi

  snapshot="coverage-snapshots/$ws.lcov"
  snapshot_date="$(git log -1 --format=%cI "$REF" -- "$snapshot" 2>/dev/null || true)"

  # No snapshot at all is stale by definition — it has never landed.
  if [[ -z "$snapshot_date" ]]; then
    echo "$ws"
    continue
  fi

  workspace_date="$(git log -1 --format=%cI "$REF" -- "workspaces/$ws/" 2>/dev/null || true)"
  [[ -z "$workspace_date" ]] && continue

  # ISO-8601 with a fixed offset sorts lexicographically, which keeps this free
  # of date(1)'s BSD/GNU parsing differences.
  if [[ "$workspace_date" > "$snapshot_date" ]]; then
    echo "$ws"
  fi
done
