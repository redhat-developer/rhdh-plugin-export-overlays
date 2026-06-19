#!/usr/bin/env bash
set -euo pipefail

RESULT_FILE=""
for dir in iteration-*/output; do
  if [[ -f "${dir}/agent-result.json" ]]; then
    RESULT_FILE="${dir}/agent-result.json"
  fi
done

if [[ -z "${RESULT_FILE}" ]]; then
  echo "No agent-result.json found — checking transcript for summary"
  echo "Run directory: $(pwd)"
  ls -R iteration-*/
  exit 0
fi

echo "=== E2E Fix Agent Results ==="
jq -r '
  "Root cause:      " + (.root_cause // "unknown"),
  "Classification:  " + (.fix_category // "unknown"),
  "Action:          " + (.action_taken // "unknown"),
  "Attempt:         " + ((.attempt // 1) | tostring),
  "Issue:           " + (.issue_url // "none"),
  "PR:              " + (.pr_url // "none"),
  "JIRA:            " + (.jira_key // "none"),
  "Next step:       " + (.next_step // "none")
' "${RESULT_FILE}" 2>/dev/null || echo "Could not parse result JSON"
