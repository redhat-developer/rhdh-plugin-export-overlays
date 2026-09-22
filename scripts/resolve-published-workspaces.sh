#!/usr/bin/env bash
#
# Decide which workspaces a publish just republished, so publish-workspace-plugins.yaml
# can smoke test each of them against the tag it pushed (RHDHBUGS-3634).
#
# Split out of that workflow for the reason resolve-publish-targets.cjs and e2e-comment.cjs
# were: logic living inside a `run:` block can only be exercised by running the workflow.
# That was not theoretical here either — the first version swallowed a failing `git diff`
# inside `mapfile`, which reports its own status and not the pipeline's, so a broken diff
# produced an empty list, read as "nothing to test", and took the run green having tested
# nothing. Nothing caught it but a human reading the diff.
#
# The export tool works the published set out internally and does not report it back, so
# this recomputes it from the same base commit the publish used.
#
# Usage: resolve-published-workspaces.sh <base-commit> <head-commit>
#
# Writes `key=value` lines on stdout for the caller to append to $GITHUB_OUTPUT:
#   workspaces  JSON array of workspace names
#   count       how many
#   reason      empty when scoped normally; otherwise why the list is empty
# Diagnostics go to stderr.
#
# See scripts/tests/test_resolve_published_workspaces.py.

set -euo pipefail

BASE="${1:-}"
HEAD_SHA="${2:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The three outputs always travel together, so name them here rather than leaving
# `emit '[]' 0 ""` to be decoded at each call site.
emit() {
  local workspaces="$1" count="$2" reason="$3"
  printf 'workspaces=%s\ncount=%s\nreason=%s\n' "$workspaces" "$count" "$reason"
}

if [[ -z "$HEAD_SHA" ]]; then
  echo "usage: $(basename "$0") <base-commit> <head-commit>" >&2
  exit 2
fi

if [[ -z "$BASE" ]] || ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  # Deliberately NOT falling back to the push payload's before-sha. export received this
  # same empty last-publish-commit and republished broadly, so scoping to one push would
  # cover strictly less than was published — a silent gap, which is the failure this
  # check exists to remove.
  echo "base commit '${BASE}' does not resolve; not scoping" >&2
  emit '[]' 0 "base commit '${BASE}' does not resolve, so the publish was not scoped and this cannot scope to it either"
  exit 0
fi

echo "diffing ${BASE}..${HEAD_SHA} for changed workspaces" >&2
# Assigned first so a failing diff aborts here under `set -e`, rather than being swallowed
# by the loop's process substitution.
changed="$(git diff --name-only "$BASE" "$HEAD_SHA" -- 'workspaces/*')"

candidates=()
while IFS= read -r ws; do
  [[ -n "$ws" ]] || continue
  # A workspace shipping no oci:// artifact has nothing to pull, and the harness treats
  # zero refs as an error — so a file-only change there would turn a good publish red.
  if grep -rqs 'dynamicArtifact: *oci://' "workspaces/${ws}/metadata/"; then
    candidates+=("$ws")
  else
    echo "  skipping '${ws}': no oci:// dynamicArtifact in its metadata" >&2
  fi
  # sort -u because one workspace usually has several files in a single bump.
done < <(printf '%s\n' "$changed" | sed -n 's|^workspaces/\([^/]*\)/.*|\1|p' | sort -u)

if [[ ${#candidates[@]} -eq 0 ]]; then
  # printf over an empty array still emits one blank line, which jq would read as [""].
  emit '[]' 0 ""
  exit 0
fi

printf '  %s\n' "${candidates[@]}" >&2
emit "$(printf '%s\n' "${candidates[@]}" | jq -R . | jq -s -c .)" "${#candidates[@]}" ""
