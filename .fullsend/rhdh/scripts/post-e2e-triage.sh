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
#   - Perform grouping or dedup (the agent handles both — each result entry
#     is one already-grouped, already-deduplicated cause)
#   - Manage JIRA (removed from triage pipeline)
#
# Steps:
#   1. Locate and validate agent-result.json
#   2. Scan result file for secrets (gitleaks)
#   3. For each cause: execute issue directive (create/comment/skip)
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

ISSUE_COUNT="$(jq '.issues | length' "${RESULT_FILE}")"

if [[ -z "${ISSUE_COUNT}" || "${ISSUE_COUNT}" -lt 1 ]]; then
  echo "::error::agent-result.json has no issues entries"
  exit 1
fi

echo "Target branch: $(jq -r '.target_branch // "main"' "${RESULT_FILE}")"
echo "Causes to process: ${ISSUE_COUNT}"

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
# 3. Execute issue directives per cause
# ---------------------------------------------------------------------------
declare -a SUMMARY_LINES=()
declare -a CATEGORIES=()

# update_tracking_workspaces — keep an existing issue's workspace tracking lines
# in sync with the cause's current membership.
#
# Tracking lines (`fullsend-tracking: workspace=<name>`) are the search anchor
# the next night's dedup relies on, and they live only in the issue BODY. When
# we merely comment, a workspace that starts failing under this cause AFTER the
# issue was created never gets a tracking line, so a later slug-drift run (where
# the workspace net is the only fallback) can miss the open issue and file a
# duplicate. On every comment we UNION tonight's affected set into the body's
# workspace lines — union, not replace, so a workspace that passed tonight but
# may regress later keeps its anchor. Editing the body is safe: the issues
# workflow only reacts to `labeled`, never `edited`.
update_tracking_workspaces() {
  local issue="$1"; shift
  local -a want=("$@")
  local body ws missing=() block new_body
  if ! body="$(gh api "repos/${REPO_FULL_NAME}/issues/${issue}" --jq '.body' 2>/dev/null)"; then
    echo "::warning::Could not fetch #${issue} body to sync tracking lines"
    return 0
  fi
  for ws in "${want[@]}"; do
    grep -Fq "fullsend-tracking: workspace=${ws}" <<<"${body}" || missing+=("${ws}")
  done
  [[ ${#missing[@]} -eq 0 ]] && return 0

  block=""
  for ws in "${missing[@]}"; do
    block+="\`fullsend-tracking: workspace=${ws}\`"$'\n'
  done
  # Insert the missing lines right after the last existing workspace line so the
  # tracking block stays grouped; if none exist, append at the end (search is
  # in:body, so position is functionally irrelevant either way). The block is
  # passed via the environment (ENVIRON) rather than -v because it contains
  # newlines, which -v mishandles on BSD awk.
  new_body="$(TRACK_BLOCK="${block}" awk '
    { lines[NR]=$0; if ($0 ~ /fullsend-tracking: workspace=/) last=NR }
    END {
      for (i=1;i<=NR;i++) { print lines[i]; if (i==last) printf "%s", ENVIRON["TRACK_BLOCK"] }
      if (last=="") printf "%s", ENVIRON["TRACK_BLOCK"]
    }' <<<"${body}")"

  if ! printf '%s' "${new_body}" | gh issue edit "${issue}" \
    --repo "${REPO_FULL_NAME}" --body-file - >/dev/null 2>&1; then
    echo "::warning::Failed to sync tracking lines on #${issue}"
  fi
}

for i in $(seq 0 $((ISSUE_COUNT - 1))); do
  WS_JSON="$(jq -c ".issues[$i]" "${RESULT_FILE}")"

  # Root cause for the summary table — collapse to a single line and trim.
  ROOT_CAUSE="$(echo "${WS_JSON}" | jq -r '.root_cause // ""' \
    | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-200)"

  IFS=$'\t' read -r WS_NAME FIX_CAT TEST_COUNT ISSUE_ACTION < <(
    echo "${WS_JSON}" | jq -r '[(.affected_workspaces | join(", ")), .fix_category, (.tests|length), (.issue.action // "skip")] | @tsv'
  )

  echo ""
  echo "--- Cause: ${WS_NAME} (${FIX_CAT}) ---"

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
        echo "::warning::Failed to create issue for $(sanitize_for_gha "${WS_NAME}"): $(sanitize_for_gha "$(cat "${create_stderr}")")"
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

      # Keep the body's workspace tracking lines in sync with this cause's
      # current membership so next night's dedup can still find the issue.
      mapfile -t AFFECTED_WS < <(echo "${WS_JSON}" | jq -r '.affected_workspaces[]')
      if [[ ${#AFFECTED_WS[@]} -gt 0 ]]; then
        update_tracking_workspaces "${ISSUE_NUMBER}" "${AFFECTED_WS[@]}"
      fi

      # ---------------------------------------------------------------
      # 4. Handle cycle_ready_to_code
      # ---------------------------------------------------------------
      # Only cycle for auto-fixable causes. ready-to-code wakes the code agent;
      # cycling it on an environment or upstream_test_utils cause (or an umbrella
      # tracking a cluster-wide outage) would aim a code-fix run at something no
      # code change in this repo can fix. The agent should already gate the flag
      # this way — this is a defensive backstop.
      if [[ "${CYCLE}" == "true" && ( "${FIX_CAT}" == "test_fix" || "${FIX_CAT}" == "product_bug" ) ]]; then
        echo "  Cycling ready-to-code label on #${ISSUE_NUMBER}..."
        if remove_label "${REPO_FULL_NAME}" "${ISSUE_NUMBER}" "ready-to-code"; then
          sleep 1
          add_label "${REPO_FULL_NAME}" "${ISSUE_NUMBER}" "ready-to-code"
          echo "  ready-to-code label cycled — coder will re-trigger"
        else
          echo "::warning::Failed to remove ready-to-code from #${ISSUE_NUMBER} — label cycle skipped, coder may not re-trigger"
        fi
      elif [[ "${CYCLE}" == "true" ]]; then
        echo "  cycle_ready_to_code set on a '${FIX_CAT}' cause — not cycling (needs human)"
      fi
      ;;

    skip)
      echo "  No issue directive — skipping"
      ;;

    *)
      echo "::warning::Unknown issue action '$(sanitize_for_gha "${ISSUE_ACTION}")' for $(sanitize_for_gha "${WS_NAME}") — skipping"
      ;;
  esac

  # Escape pipes so root-cause prose can't break the markdown table.
  ROOT_CAUSE_CELL="${ROOT_CAUSE//|/\\|}"
  SUMMARY_LINES+=("| ${WS_NAME} | \`${FIX_CAT}\` | ${TEST_COUNT} | ${ISSUE_REF:-—} | ${ROOT_CAUSE_CELL:-—} |")
  CATEGORIES+=("${FIX_CAT}")
  echo "  [${WS_NAME}] ${FIX_CAT} — ${TEST_COUNT} test(s) — ${ISSUE_ACTION}"
done

# ---------------------------------------------------------------------------
# 5. Comment on trigger issue with summary table
# ---------------------------------------------------------------------------
if [[ -n "${TRIGGER_ISSUE_NUMBER}" ]]; then
  echo ""
  echo "Posting summary to trigger issue #${TRIGGER_ISSUE_NUMBER}..."

  TARGET_BRANCH="$(jq -r '.target_branch // "main"' "${RESULT_FILE}")"

  # Category breakdown for the headline. test_fix + product_bug are handed to
  # the code agent automatically; environment + upstream_test_utils need a
  # human (fix belongs elsewhere); infra_flake is transient (no issue).
  AUTO_FIX=0; NEEDS_HUMAN=0; FLAKE=0; OTHER=0
  for c in "${CATEGORIES[@]:-}"; do
    case "${c}" in
      test_fix|product_bug) AUTO_FIX=$((AUTO_FIX + 1)) ;;
      environment|upstream_test_utils) NEEDS_HUMAN=$((NEEDS_HUMAN + 1)) ;;
      infra_flake)          FLAKE=$((FLAKE + 1)) ;;
      *)
        OTHER=$((OTHER + 1))
        echo "::warning::Unexpected fix_category '$(sanitize_for_gha "${c}")' in breakdown — counted under 'other'"
        ;;
    esac
  done

  CAUSE_WORD="causes"; [[ "${ISSUE_COUNT}" -eq 1 ]] && CAUSE_WORD="cause"
  BREAKDOWN_STR=""
  append_breakdown() {
    [[ -n "${BREAKDOWN_STR}" ]] && BREAKDOWN_STR+=" · "
    BREAKDOWN_STR+="$1"
  }
  [[ "${AUTO_FIX}" -gt 0 ]] && append_breakdown "${AUTO_FIX} queued for auto-fix"
  [[ "${NEEDS_HUMAN}" -gt 0 ]] && append_breakdown "${NEEDS_HUMAN} need manual attention"
  [[ "${FLAKE}" -gt 0 ]] && append_breakdown "${FLAKE} transient flake"
  [[ "${OTHER}" -gt 0 ]] && append_breakdown "${OTHER} uncategorized"

  SUMMARY="## E2E Nightly Triage — \`${TARGET_BRANCH}\` (${ISSUE_COUNT} ${CAUSE_WORD})"$'\n\n'
  [[ -n "${BREAKDOWN_STR}" ]] && SUMMARY+="${BREAKDOWN_STR}"$'\n\n'
  SUMMARY+="| Workspaces | Category | Tests | Issue | Root cause |"$'\n'
  SUMMARY+="|------------|----------|-------|-------|------------|"$'\n'
  for line in "${SUMMARY_LINES[@]}"; do
    SUMMARY+="${line}"$'\n'
  done

  printf '%s' "${SUMMARY}" | gh issue comment "${TRIGGER_ISSUE_NUMBER}" \
    --repo "${REPO_FULL_NAME}" \
    --body-file - 2>/dev/null || echo "::warning::Failed to comment on trigger issue"
fi

echo ""
echo "=== E2E Triage Results ==="
echo "Causes: ${ISSUE_COUNT}"
echo ""
echo "Post-e2e-triage complete."
