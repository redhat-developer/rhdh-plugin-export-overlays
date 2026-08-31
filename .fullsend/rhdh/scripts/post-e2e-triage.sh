#!/usr/bin/env bash
# Post-script: execute triage agent issue directives and summarize.
#
# Runs on the GitHub Actions runner AFTER the sandbox is destroyed.
# The triage agent cannot perform GitHub write operations inside the sandbox.
# Instead, it writes directives to agent-result.json, which this script
# executes with the appropriate credentials.
#
# This script does NOT:
#   - Push branches or create PRs (code agent handles that)
#   - Perform dedup logic (the agent handles dedup in Phase 4)
#   - Manage JIRA (removed from triage pipeline)
#
# Steps:
#   1. Locate and validate agent-result.json
#   2. Scan result file for secrets (gitleaks)
#   3. For each workspace: execute issue directive (create/comment/skip)
#   4. Handle cycle_ready_to_code label re-triggering
#   5. Comment on trigger issue with summary table
#
# Required environment variables:
#   GH_TOKEN          — GitHub token (used for API calls)
#   REPO_FULL_NAME    — owner/repo (default: redhat-developer/rhdh-plugin-export-overlays)
#   GITHUB_ISSUE_URL  — HTML URL of the trigger issue
#
# Optional environment variables:
#   PUSH_TOKEN        — dedicated token with issues:write (falls back to GH_TOKEN)
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

REPO_FULL_NAME="${REPO_FULL_NAME:-redhat-developer/rhdh-plugin-export-overlays}"

: "${GH_TOKEN:?GH_TOKEN is required}"
export GH_TOKEN
echo "::add-mask::${GH_TOKEN}"

PUSH_TOKEN="${PUSH_TOKEN:-${GH_TOKEN}}"
echo "::add-mask::${PUSH_TOKEN}"

# Promote to PUSH_TOKEN for write permissions on issues and labels.
export GH_TOKEN="${PUSH_TOKEN}"

# Extract trigger issue number from GITHUB_ISSUE_URL
TRIGGER_ISSUE_URL="${GITHUB_ISSUE_URL:-}"
TRIGGER_ISSUE_NUMBER=""
if [[ -n "${TRIGGER_ISSUE_URL}" ]]; then
  TRIGGER_ISSUE_NUMBER="${TRIGGER_ISSUE_URL##*/}"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

sanitize_for_gha() {
  local text="${1:-}" prev=""
  while [[ "${text}" != "${prev}" ]]; do
    prev="${text}"
    text="${text//::/}"
    text="${text//\%0A/}"
    text="${text//\%0a/}"
    text="${text//\%0D/}"
    text="${text//\%0d/}"
  done
  text="${text//$'\n'/ }"
  text="${text//$'\r'/}"
  echo "${text}"
}

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1; then
    return 0
  fi
  echo "Installing gitleaks v${GITLEAKS_VERSION}..."
  mkdir -p "${HOME}/.local/bin"
  if curl -fsSL --proto =https \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    -o /tmp/gitleaks.tar.gz \
    && echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c --quiet \
    && tar xzf /tmp/gitleaks.tar.gz -C "${HOME}/.local/bin" gitleaks \
    && rm /tmp/gitleaks.tar.gz; then
    export PATH="${HOME}/.local/bin:${PATH}"
    echo "gitleaks installed"
    return 0
  fi
  echo "::error::Failed to install gitleaks"
  return 1
}

# add_label uses the labels API to avoid firing issues.edited.
add_label() {
  local repo="$1" issue="$2" label="$3"
  local stderr_file
  stderr_file="$(mktemp)"
  if ! gh api "repos/${repo}/issues/${issue}/labels" -f "labels[]=${label}" --silent 2>"${stderr_file}"; then
    echo "::warning::Failed to add label '${label}' to #${issue}: $(sanitize_for_gha "$(cat "${stderr_file}")")"
  fi
  rm -f "${stderr_file}"
}

# remove_label removes a label. Returns 0 on success or if absent (404).
remove_label() {
  local repo="$1" issue="$2" label="$3"
  local encoded stderr_file
  encoded=$(printf '%s' "${label}" | jq -sRr @uri)
  stderr_file="$(mktemp)"
  if gh api "repos/${repo}/issues/${issue}/labels/${encoded}" -X DELETE --silent 2>"${stderr_file}"; then
    rm -f "${stderr_file}"
    return 0
  fi
  if grep -q "404" "${stderr_file}"; then
    rm -f "${stderr_file}"
    return 0
  fi
  rm -f "${stderr_file}"
  return 1
}

# ---------------------------------------------------------------------------
# 1. Locate agent-result.json
# ---------------------------------------------------------------------------
RESULT_FILE=""
for dir in iteration-*/output; do
  if [[ -f "${dir}/agent-result.json" ]]; then
    RESULT_FILE="${dir}/agent-result.json"
  fi
done

if [[ -z "${RESULT_FILE}" ]]; then
  echo "::warning::No agent-result.json found"
  ls -R iteration-*/ 2>/dev/null || true
  exit 0
fi

RESULT_FILE="$(cd "$(dirname "${RESULT_FILE}")" && pwd)/$(basename "${RESULT_FILE}")"
echo "Found agent-result.json: ${RESULT_FILE}"

# Validate JSON
if ! jq empty "${RESULT_FILE}" 2>/dev/null; then
  echo "::error::agent-result.json is not valid JSON"
  exit 1
fi

WORKSPACE_COUNT="$(jq '.workspaces | length' "${RESULT_FILE}")"

if [[ -z "${WORKSPACE_COUNT}" || "${WORKSPACE_COUNT}" -lt 1 ]]; then
  echo "::error::agent-result.json has no workspaces entries"
  exit 1
fi

echo "Target branch: $(jq -r '.target_branch // "main"' "${RESULT_FILE}")"
echo "Workspaces to process: ${WORKSPACE_COUNT}"

# ---------------------------------------------------------------------------
# 2. Scan agent-result.json for secrets
# ---------------------------------------------------------------------------
if ! install_gitleaks; then
  echo "::error::Failed to install gitleaks — refusing to post without secret scan"
  exit 1
fi
echo "Scanning agent-result.json for secrets..."
SCAN_DIR="$(mktemp -d)"
cp "${RESULT_FILE}" "${SCAN_DIR}/agent-result.json"
if ! gitleaks detect --source "${SCAN_DIR}" --no-git --redact 2>/dev/null; then
  echo "::error::Secret detected in agent-result.json — refusing to post"
  rm -rf "${SCAN_DIR}"
  exit 1
fi
rm -rf "${SCAN_DIR}"
echo "Result file scan passed"

# ---------------------------------------------------------------------------
# 3. Execute issue directives per workspace
# ---------------------------------------------------------------------------
declare -a SUMMARY_LINES=()

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_JSON="$(jq -c ".workspaces[$i]" "${RESULT_FILE}")"

  IFS=$'\t' read -r WS_NAME FIX_CAT TEST_COUNT ISSUE_ACTION ROOT_SLUG < <(
    echo "${WS_JSON}" | jq -r '[.workspace, .fix_category, (.tests|length), (.issue.action // "skip"), .root_cause_slug] | @tsv'
  )

  echo ""
  echo "--- Workspace: ${WS_NAME} (${FIX_CAT}) ---"

  ISSUE_REF=""

  case "${ISSUE_ACTION}" in
    create)
      echo "  Creating GitHub issue..."
      ISSUE_TITLE="$(echo "${WS_JSON}" | jq -r '.issue.title')"
      ISSUE_BODY="$(echo "${WS_JSON}" | jq -r '.issue.body')"
      if [[ -n "${TRIGGER_ISSUE_URL}" ]]; then
        ISSUE_BODY="${ISSUE_BODY}"$'\n\n'"---"$'\n'"Triggered by ${TRIGGER_ISSUE_URL}"
      fi

      # Create issue WITHOUT labels — labels are added separately via the
      # labels API so that ready-to-code fires a proper issues.labeled event
      # (gh issue create --label does NOT emit a separate labeled event).
      create_stderr="$(mktemp)"
      if ISSUE_URL="$(gh issue create \
        --repo "${REPO_FULL_NAME}" \
        --title "${ISSUE_TITLE}" \
        --body "${ISSUE_BODY}" 2>"${create_stderr}")"; then
        ISSUE_NUMBER="${ISSUE_URL##*/}"
        if [[ ! "${ISSUE_NUMBER}" =~ ^[0-9]+$ ]]; then
          echo "::warning::Could not parse issue number from: ${ISSUE_URL}"
          rm -f "${create_stderr}"
          continue
        fi
        echo "  Created issue #${ISSUE_NUMBER}: ${ISSUE_URL}"
        ISSUE_REF="#${ISSUE_NUMBER}"

        # Add labels via labels API. Batch non-deferred labels into one
        # call, then add ready-to-code LAST so its labeled event is the
        # final webhook and triggers the coder.
        NON_DEFERRED="$(echo "${WS_JSON}" | jq -c '[.issue.labels // [] | .[] | select(. != "ready-to-code")]')"
        HAS_DEFERRED="$(echo "${WS_JSON}" | jq -r '.issue.labels // [] | map(select(. == "ready-to-code")) | length > 0')"
        if [[ "${NON_DEFERRED}" != "[]" ]]; then
          if ! echo "${NON_DEFERRED}" | gh api "repos/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}/labels" --input - --silent 2>/dev/null; then
            echo "::warning::Failed to add batch labels to #${ISSUE_NUMBER}"
          fi
        fi
        if [[ "${HAS_DEFERRED}" == "true" ]]; then
          add_label "${REPO_FULL_NAME}" "${ISSUE_NUMBER}" "ready-to-code"
        fi
      else
        echo "::warning::Failed to create issue for ${WS_NAME}: $(sanitize_for_gha "$(cat "${create_stderr}")")"
      fi
      rm -f "${create_stderr}"
      ;;

    comment)
      ISSUE_NUMBER="$(echo "${WS_JSON}" | jq -r '.issue.number')"
      COMMENT_BODY="$(echo "${WS_JSON}" | jq -r '.issue.body')"
      CYCLE="$(echo "${WS_JSON}" | jq -r '.issue.cycle_ready_to_code // false')"

      echo "  Commenting on issue #${ISSUE_NUMBER}..."
      if ! gh issue comment "${ISSUE_NUMBER}" \
        --repo "${REPO_FULL_NAME}" \
        --body "${COMMENT_BODY}" 2>/dev/null; then
        echo "::warning::Failed to comment on issue #${ISSUE_NUMBER}"
      fi
      ISSUE_REF="#${ISSUE_NUMBER}"

      # ---------------------------------------------------------------
      # 4. Handle cycle_ready_to_code
      # ---------------------------------------------------------------
      if [[ "${CYCLE}" == "true" ]]; then
        echo "  Cycling ready-to-code label on #${ISSUE_NUMBER}..."
        if remove_label "${REPO_FULL_NAME}" "${ISSUE_NUMBER}" "ready-to-code"; then
          sleep 1
          add_label "${REPO_FULL_NAME}" "${ISSUE_NUMBER}" "ready-to-code"
          echo "  ready-to-code label cycled — coder will re-trigger"
        else
          echo "::warning::Failed to remove ready-to-code from #${ISSUE_NUMBER} — label cycle skipped, coder may not re-trigger"
        fi
      fi
      ;;

    skip)
      echo "  No issue directive — skipping"
      ;;

    *)
      echo "::warning::Unknown issue action '${ISSUE_ACTION}' for ${WS_NAME} — skipping"
      ;;
  esac

  SUMMARY_LINES+=("| ${WS_NAME} | \`${FIX_CAT}\` | ${ROOT_SLUG} | ${TEST_COUNT} | ${ISSUE_REF:-—} |")
  echo "  [${WS_NAME}] ${FIX_CAT} — ${TEST_COUNT} test(s) — ${ISSUE_ACTION}"
done

# ---------------------------------------------------------------------------
# 5. Comment on trigger issue with summary table
# ---------------------------------------------------------------------------
if [[ -n "${TRIGGER_ISSUE_NUMBER}" ]]; then
  echo ""
  echo "Posting summary to trigger issue #${TRIGGER_ISSUE_NUMBER}..."

  SUMMARY="## Triage Summary"$'\n\n'
  SUMMARY+="| Workspace | Category | Root Cause | Tests | Issue |"$'\n'
  SUMMARY+="|-----------|----------|------------|-------|-------|"$'\n'
  for line in "${SUMMARY_LINES[@]}"; do
    SUMMARY+="${line}"$'\n'
  done

  AGENT_SUMMARY="$(jq -r '.summary // empty' "${RESULT_FILE}")"
  if [[ -n "${AGENT_SUMMARY}" ]]; then
    SUMMARY+=$'\n'"### Analysis"$'\n\n'"${AGENT_SUMMARY}"
  fi

  printf '%s' "${SUMMARY}" | gh issue comment "${TRIGGER_ISSUE_NUMBER}" \
    --repo "${REPO_FULL_NAME}" \
    --body-file - 2>/dev/null || echo "::warning::Failed to comment on trigger issue"
fi

echo ""
echo "=== E2E Triage Results ==="
echo "Workspaces: ${WORKSPACE_COUNT}"
echo ""
echo "Post-e2e-triage complete."
