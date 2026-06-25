#!/usr/bin/env bash
# Post-script: execute agent directives, push branch, and create PR.
#
# Runs on the GitHub Actions runner AFTER the sandbox is destroyed.
# The agent cannot perform GitHub/JIRA write operations inside the sandbox.
# Instead, it writes directives to agent-result.json, which this script
# executes with the appropriate credentials.
#
# Steps:
#   1. Locate and validate agent-result.json
#   2. Execute GitHub issue directives (create or comment)
#   3. Execute JIRA directives (create bug)
#   4. Backfill JIRA key + issue number in committed code
#   5. Push branch (if code changes exist)
#   6. Create or update PR
#   7. Display summary
#
# Required environment variables:
#   GH_TOKEN          — GitHub token with issues:write, pull-requests:write,
#                       contents:write on the target repo
#   REPO_FULL_NAME    — owner/repo (default: redhat-developer/rhdh-plugin-export-overlays)
#
# Optional environment variables:
#   JIRA_TOKEN        — JIRA API bearer token for bug creation
#   JIRA_URL          — JIRA instance URL (default: https://issues.redhat.com)
#   REPO_DIR          — path to extracted repo (default: current directory)
#   TARGET_BRANCH     — base branch for PRs (default: main)
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REPO_DIR="${REPO_DIR:-.}"
REPO_FULL_NAME="${REPO_FULL_NAME:-redhat-developer/rhdh-plugin-export-overlays}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
JIRA_URL="${JIRA_URL:-https://issues.redhat.com}"

: "${GH_TOKEN:?GH_TOKEN is required}"
export GH_TOKEN
echo "::add-mask::${GH_TOKEN}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Sanitize text before interpolating into GHA workflow commands to prevent
# injecting ::set-output, ::save-state, or other directives via crafted
# API responses or agent output.
sanitize_for_gha() {
  local text="${1:-}"
  text="${text//::/}"
  text="${text//%0A/}"
  text="${text//%0a/}"
  text="${text//%0D/}"
  text="${text//%0d/}"
  echo "${text}"
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
  echo "::warning::No agent-result.json found — checking transcript for summary"
  echo "Run directory: $(pwd)"
  ls -R iteration-*/ 2>/dev/null || true
  exit 0
fi

echo "Found agent-result.json: ${RESULT_FILE}"

# ---------------------------------------------------------------------------
# 1b. Validate agent-result.json before executing any directives
# ---------------------------------------------------------------------------
if ! jq empty "${RESULT_FILE}" 2>/dev/null; then
  echo "::error::agent-result.json is not valid JSON"
  exit 1
fi

# Validate required top-level fields
for field in root_cause fix_category action_taken attempt next_step; do
  val="$(jq -r ".${field} // empty" "${RESULT_FILE}")"
  if [[ -z "${val}" ]]; then
    echo "::error::agent-result.json missing required field: ${field}"
    exit 1
  fi
done

# Validate fix_category enum
FIX_CATEGORY="$(jq -r '.fix_category' "${RESULT_FILE}")"
case "${FIX_CATEGORY}" in
  infra_flake|test_fix|product_bug|environment) ;;
  *)
    echo "::error::Invalid fix_category: $(sanitize_for_gha "${FIX_CATEGORY}")"
    exit 1
    ;;
esac

# Validate action_taken enum
ACTION_TAKEN="$(jq -r '.action_taken' "${RESULT_FILE}")"
case "${ACTION_TAKEN}" in
  logged|commented_on_existing|issue_tracked|fix_implemented|test_skipped) ;;
  *)
    echo "::error::Invalid action_taken: $(sanitize_for_gha "${ACTION_TAKEN}")"
    exit 1
    ;;
esac

# Validate issue directive consistency
ISSUE_ACTION="$(jq -r '.issue.action // "skip"' "${RESULT_FILE}")"
case "${ISSUE_ACTION}" in
  create)
    for field in title body; do
      val="$(jq -r ".issue.${field} // empty" "${RESULT_FILE}")"
      if [[ -z "${val}" ]]; then
        echo "::error::issue.action=create but missing issue.${field}"
        exit 1
      fi
    done
    ;;
  comment)
    for field in number body; do
      val="$(jq -r ".issue.${field} // empty" "${RESULT_FILE}")"
      if [[ -z "${val}" ]]; then
        echo "::error::issue.action=comment but missing issue.${field}"
        exit 1
      fi
    done
    ;;
  skip) ;;
  *)
    echo "::error::Invalid issue.action: $(sanitize_for_gha "${ISSUE_ACTION}")"
    exit 1
    ;;
esac

# Validate JIRA directive if present
JIRA_PROJECT="$(jq -r '.jira.project // empty' "${RESULT_FILE}")"
if [[ -n "${JIRA_PROJECT}" ]]; then
  for field in type summary description backfill_file; do
    val="$(jq -r ".jira.${field} // empty" "${RESULT_FILE}")"
    if [[ -z "${val}" ]]; then
      echo "::error::jira directive present but missing jira.${field}"
      exit 1
    fi
  done
fi

echo "Validation passed — action: ${ACTION_TAKEN}, category: ${FIX_CATEGORY}"

# ---------------------------------------------------------------------------
# 2. Execute GitHub issue directives
# ---------------------------------------------------------------------------
ISSUE_NUMBER=""
ISSUE_URL=""

case "${ISSUE_ACTION}" in
  create)
    echo "Creating GitHub issue..."
    ISSUE_TITLE="$(jq -r '.issue.title' "${RESULT_FILE}")"
    ISSUE_BODY="$(jq -r '.issue.body' "${RESULT_FILE}")"

    LABEL_ARGS=()
    while IFS= read -r label; do
      [[ -n "${label}" ]] && LABEL_ARGS+=(--label "${label}")
    done < <(jq -r '.issue.labels // [] | .[]' "${RESULT_FILE}")

    CREATE_OUTPUT=""
    if ISSUE_URL="$(gh issue create \
      --repo "${REPO_FULL_NAME}" \
      --title "${ISSUE_TITLE}" \
      "${LABEL_ARGS[@]}" \
      --body "${ISSUE_BODY}" 2>&1)"; then
      ISSUE_NUMBER="$(echo "${ISSUE_URL}" | grep -o '[0-9]*$')"
      echo "Created issue #${ISSUE_NUMBER}: ${ISSUE_URL}"
    else
      if echo "${ISSUE_URL}" | grep -qE "HTTP (401|403)"; then
        echo "::warning::Insufficient permissions to create issue — skipping"
      else
        echo "::warning::Failed to create issue: $(sanitize_for_gha "${ISSUE_URL}")"
      fi
      echo "::warning::Continuing without issue — PR will not have Closes reference"
      ISSUE_URL=""
    fi
    ;;

  comment)
    ISSUE_NUMBER="$(jq -r '.issue.number' "${RESULT_FILE}")"
    COMMENT_BODY="$(jq -r '.issue.body' "${RESULT_FILE}")"

    echo "Commenting on issue #${ISSUE_NUMBER}..."
    COMMENT_OUTPUT=""
    if ! COMMENT_OUTPUT="$(gh issue comment "${ISSUE_NUMBER}" \
      --repo "${REPO_FULL_NAME}" \
      --body "${COMMENT_BODY}" 2>&1)"; then
      if echo "${COMMENT_OUTPUT}" | grep -qE "HTTP (401|403)"; then
        echo "::warning::Insufficient permissions to comment on issue #${ISSUE_NUMBER} — skipping"
      else
        echo "::warning::Failed to comment on issue #${ISSUE_NUMBER}: $(sanitize_for_gha "${COMMENT_OUTPUT}")"
      fi
    fi

    ADD_LABELS="$(jq -r '.issue.add_labels // [] | join(",")' "${RESULT_FILE}")"
    if [[ -n "${ADD_LABELS}" ]]; then
      echo "Adding labels: ${ADD_LABELS}"
      if ! LABEL_OUTPUT="$(gh issue edit "${ISSUE_NUMBER}" \
        --repo "${REPO_FULL_NAME}" \
        --add-label "${ADD_LABELS}" 2>&1)"; then
        if echo "${LABEL_OUTPUT}" | grep -qE "HTTP (401|403)"; then
          echo "::warning::Insufficient permissions to add labels — skipping"
        else
          echo "::warning::Failed to add labels to issue #${ISSUE_NUMBER}: $(sanitize_for_gha "${LABEL_OUTPUT}")"
        fi
      fi
    fi

    ISSUE_URL="https://github.com/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}"
    echo "Updated issue #${ISSUE_NUMBER}: ${ISSUE_URL}"
    ;;

  skip)
    echo "No issue directive — skipping"
    ;;
esac

# ---------------------------------------------------------------------------
# 3. Execute JIRA directive
# ---------------------------------------------------------------------------
JIRA_KEY=""

if [[ -n "${JIRA_PROJECT}" ]]; then
  if [[ -z "${JIRA_TOKEN:-}" ]]; then
    echo "::warning::JIRA directive present but JIRA_TOKEN not set — skipping JIRA creation"
    echo "::warning::JIRA bug should be created manually:"
    jq -r '"  Project: " + .jira.project + "\n  Summary: " + .jira.summary' "${RESULT_FILE}"
  else
    echo "::add-mask::${JIRA_TOKEN}"
    echo "Creating JIRA bug in ${JIRA_PROJECT}..."
    JIRA_SUMMARY="$(jq -r '.jira.summary' "${RESULT_FILE}")"
    JIRA_DESCRIPTION="$(jq -r '.jira.description' "${RESULT_FILE}")"
    JIRA_TYPE="$(jq -r '.jira.type // "Bug"' "${RESULT_FILE}")"

    JIRA_RESPONSE=""
    if JIRA_RESPONSE="$(curl -sf -X POST "${JIRA_URL}/rest/api/2/issue" \
      -H "Authorization: Bearer ${JIRA_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg proj "${JIRA_PROJECT}" \
        --arg type "${JIRA_TYPE}" \
        --arg sum "${JIRA_SUMMARY}" \
        --arg desc "${JIRA_DESCRIPTION}" \
        '{fields: {project: {key: $proj}, issuetype: {name: $type}, summary: $sum, description: $desc}}'
      )" 2>&1)"; then
      JIRA_KEY="$(echo "${JIRA_RESPONSE}" | jq -r '.key // empty')"
      if [[ -n "${JIRA_KEY}" ]]; then
        echo "Created JIRA: ${JIRA_KEY} (${JIRA_URL}/browse/${JIRA_KEY})"
      else
        echo "::warning::JIRA response did not contain key: $(sanitize_for_gha "${JIRA_RESPONSE}")"
      fi
    else
      echo "::warning::JIRA creation failed: $(sanitize_for_gha "${JIRA_RESPONSE}")"
      echo "::warning::JIRA bug should be created manually"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 4. Backfill placeholders in committed code
# ---------------------------------------------------------------------------
if [[ -d "${REPO_DIR}" && "${REPO_DIR}" != "." ]]; then
  cd "${REPO_DIR}"
fi

NEEDS_AMEND=false

# 4a. Backfill JIRA key (JIRA-PENDING → RHDHBUGS-1234)
if [[ -n "${JIRA_KEY}" ]]; then
  BACKFILL_FILE="$(jq -r '.jira.backfill_file // empty' "${RESULT_FILE}")"
  if [[ -n "${BACKFILL_FILE}" && -f "${BACKFILL_FILE}" ]]; then
    if grep -q 'JIRA-PENDING' "${BACKFILL_FILE}"; then
      echo "Backfilling JIRA key ${JIRA_KEY} in ${BACKFILL_FILE}"
      sed -i.bak "s/JIRA-PENDING/${JIRA_KEY}/g" "${BACKFILL_FILE}"
      rm -f "${BACKFILL_FILE}.bak"
      git add "${BACKFILL_FILE}"
      NEEDS_AMEND=true
    fi
  fi

  if git log -1 --format='%s%n%b' | grep -q 'JIRA-PENDING'; then
    NEEDS_AMEND=true
  fi
fi

# 4b. Backfill issue number (ISSUE_PLACEHOLDER → actual number)
if [[ -n "${ISSUE_NUMBER}" ]]; then
  ALL_FILES="$(git diff --name-only HEAD~1..HEAD 2>/dev/null || true)"
  for f in ${ALL_FILES}; do
    if [[ -f "${f}" ]] && grep -q 'ISSUE_PLACEHOLDER' "${f}"; then
      echo "Backfilling issue #${ISSUE_NUMBER} in ${f}"
      sed -i.bak "s/ISSUE_PLACEHOLDER/${ISSUE_NUMBER}/g" "${f}"
      rm -f "${f}.bak"
      git add "${f}"
      NEEDS_AMEND=true
    fi
  done
fi

if [[ "${NEEDS_AMEND}" == "true" ]]; then
  OLD_MSG="$(git log -1 --format='%B')"
  NEW_MSG="${OLD_MSG}"
  [[ -n "${JIRA_KEY}" ]] && NEW_MSG="$(echo "${NEW_MSG}" | sed "s/JIRA-PENDING/${JIRA_KEY}/g")"
  [[ -n "${ISSUE_NUMBER}" ]] && NEW_MSG="$(echo "${NEW_MSG}" | sed "s/ISSUE_PLACEHOLDER/${ISSUE_NUMBER}/g")"

  git commit --amend -m "${NEW_MSG}"
  echo "Amended commit with backfilled placeholders"
fi

# ---------------------------------------------------------------------------
# 5. Push branch (if code changes exist)
# ---------------------------------------------------------------------------
BRANCH="$(git branch --show-current)"
PR_URL=""

if [[ -z "${BRANCH}" || "${BRANCH}" == "main" || "${BRANCH}" == "master" ]]; then
  echo "No feature branch (current: '${BRANCH:-detached HEAD}') — skipping push"
else
  MERGE_BASE="$(git merge-base "origin/${TARGET_BRANCH}" HEAD 2>/dev/null)" || MERGE_BASE=""
  if [[ -n "${MERGE_BASE}" ]]; then
    CHANGED="$(git diff --name-only "${MERGE_BASE}..HEAD")"
  else
    CHANGED="$(git diff --name-only HEAD~1..HEAD 2>/dev/null || true)"
  fi

  if [[ -z "${CHANGED}" ]]; then
    echo "No changed files — skipping push"
  else
    echo "Changed files:"
    echo "${CHANGED}" | sed 's/^/  /'

    git remote set-url origin \
      "https://x-access-token:${GH_TOKEN}@github.com/${REPO_FULL_NAME}.git"

    echo "Pushing branch ${BRANCH}..."
    PUSH_OUTPUT=""
    PUSH_OUTPUT="$(git push -u origin -- "${BRANCH}" 2>&1)" && PUSH_RC=0 || PUSH_RC=$?
    echo "${PUSH_OUTPUT}"

    if [[ "${PUSH_RC}" -ne 0 ]]; then
      if echo "${PUSH_OUTPUT}" | grep -qi "non-fast-forward\|rejected\|fetch first"; then
        echo "::warning::Plain push failed — retrying with --force-with-lease"
        if ! git push --force-with-lease -u origin -- "${BRANCH}" 2>&1; then
          echo "::error::Force-with-lease push also failed"
          exit 1
        fi
      else
        echo "::error::Push failed: $(sanitize_for_gha "${PUSH_OUTPUT}")"
        exit 1
      fi
    fi

    # -----------------------------------------------------------------
    # 6. Create or update PR
    # -----------------------------------------------------------------
    EXISTING_PR="$(gh pr list --repo "${REPO_FULL_NAME}" --head "${BRANCH}" \
      --json number,url --jq '.[0]' 2>/dev/null || true)"

    if [[ -n "${EXISTING_PR}" && "${EXISTING_PR}" != "null" ]]; then
      PR_URL="$(echo "${EXISTING_PR}" | jq -r '.url')"
      PR_NUM="$(echo "${EXISTING_PR}" | jq -r '.number')"
      echo "PR #${PR_NUM} already exists — branch updated: ${PR_URL}"
    else
      echo "Creating PR..."
      COMMIT_SUBJECT="$(git log -1 --format='%s')"
      COMMIT_BODY="$(git log -1 --format='%b' | sed '/^$/d')"

      PR_BODY="${COMMIT_BODY}"
      [[ -n "${ISSUE_NUMBER}" ]] && PR_BODY="${PR_BODY}

Closes #${ISSUE_NUMBER}"
      [[ -n "${JIRA_KEY}" ]] && PR_BODY="${PR_BODY}

JIRA: [${JIRA_KEY}](${JIRA_URL}/browse/${JIRA_KEY})"

      if ! PR_URL="$(gh pr create \
        --repo "${REPO_FULL_NAME}" \
        --head "${BRANCH}" \
        --base "${TARGET_BRANCH}" \
        --title "${COMMIT_SUBJECT}" \
        --body "${PR_BODY}" 2>&1)"; then
        if echo "${PR_URL}" | grep -qE "HTTP (401|403)"; then
          echo "::error::Insufficient permissions to create PR — check GH_TOKEN scopes (needs pull-requests:write)"
        else
          echo "::error::Failed to create PR: $(sanitize_for_gha "${PR_URL}")"
        fi
        exit 1
      fi
      echo "PR created: ${PR_URL}"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== E2E Fix Agent Results ==="
jq -r '
  "Root cause:      " + (.root_cause // "unknown"),
  "Classification:  " + (.fix_category // "unknown"),
  "Action:          " + (.action_taken // "unknown"),
  "Attempt:         " + ((.attempt // 1) | tostring),
  "Next step:       " + (.next_step // "none")
' "${RESULT_FILE}" 2>/dev/null || echo "Could not parse result JSON"

[[ -n "${ISSUE_URL}" ]] && echo "Issue:           ${ISSUE_URL}"
[[ -n "${PR_URL}" ]] && echo "PR:              ${PR_URL}"
[[ -n "${JIRA_KEY}" ]] && echo "JIRA:            ${JIRA_KEY} (${JIRA_URL}/browse/${JIRA_KEY})"
echo ""

echo "Post-e2e-fix complete."
