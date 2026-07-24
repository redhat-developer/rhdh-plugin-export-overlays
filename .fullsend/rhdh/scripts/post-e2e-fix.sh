#!/usr/bin/env bash
# Post-script: execute agent directives, push branches, and create PRs.
#
# Runs on the GitHub Actions runner AFTER the sandbox is destroyed.
# The agent cannot perform GitHub/JIRA write operations inside the sandbox.
# Instead, it writes directives to agent-result.json, which this script
# executes with the appropriate credentials.
#
# The result file contains a "workspaces" array — one entry per workspace
# with failures. Each workspace may have its own branch, issue, and JIRA
# directive. This script iterates over all workspaces and processes each
# independently.
#
# Security layers (defense-in-depth):
#   - Branch validation — refuse to push main/master
#   - Authoritative secret scan (gitleaks) — final gate before any push
#   - Signed-off-by trailer rejection — agents must not sign commits
#   - Secret scan on agent-result.json — before posting content as comments
#   - Token isolation — PUSH_TOKEN never enters the sandbox
#
# Steps:
#   1. Locate and validate agent-result.json
#   2. For each workspace: execute GitHub issue directives
#   3. For each workspace: execute JIRA directives
#   4. For each workspace with a branch: validate, scan, backfill, push, create PR
#   5. Display summary
#
# Required environment variables:
#   GH_TOKEN          — GitHub token (used for API calls and as push fallback)
#   REPO_FULL_NAME    — owner/repo (default: redhat-developer/rhdh-plugin-export-overlays)
#   PUSH_REPO         — fork owner/repo for push and PR head (default: REPO_FULL_NAME)
#
# Optional environment variables:
#   PUSH_TOKEN        — dedicated push token (minted by fullsend; falls back to GH_TOKEN)
#   PUSH_TOKEN_SOURCE — "github-app" when PUSH_TOKEN is from mint service
#   JIRA_TOKEN        — JIRA API bearer token for bug creation
#   JIRA_URL          — JIRA instance URL (default: https://issues.redhat.com)
#   TARGET_REPO_DIR   — path to extracted repo (set by fullsend automatically)
#   REPO_DIR          — fallback repo path if TARGET_REPO_DIR not set (default: .)
#   TARGET_BRANCH     — base branch for PRs (default: main)
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

REPO_DIR="${TARGET_REPO_DIR:-${REPO_DIR:-.}}"
REPO_FULL_NAME="${REPO_FULL_NAME:-redhat-developer/rhdh-plugin-export-overlays}"
PUSH_REPO="${PUSH_REPO:-${REPO_FULL_NAME}}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
JIRA_URL="${JIRA_URL:-https://issues.redhat.com}"

: "${GH_TOKEN:?GH_TOKEN is required}"
export GH_TOKEN
echo "::add-mask::${GH_TOKEN}"

PUSH_TOKEN="${PUSH_TOKEN:-${GH_TOKEN}}"
echo "::add-mask::${PUSH_TOKEN}"
if [[ -n "${PUSH_TOKEN_SOURCE:-}" ]]; then
  echo "Push token source: ${PUSH_TOKEN_SOURCE}"
fi

# Promote GH_TOKEN to PUSH_TOKEN so the gh CLI has write permissions
# for issues, PRs, and labels. When PUSH_TOKEN is minted (GitHub Actions),
# it carries contents:write + pull_requests:write + issues:write.
# Locally, PUSH_TOKEN == GH_TOKEN so this is a no-op.
export GH_TOKEN="${PUSH_TOKEN}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

sanitize_for_gha() {
  local text="${1:-}"
  text="${text//::/}"
  text="${text//%0A/}"
  text="${text//%0a/}"
  text="${text//%0D/}"
  text="${text//%0d/}"
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
  local os_name arch_name
  os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch_name="$(uname -m)"
  case "${arch_name}" in
    x86_64) arch_name="x64" ;;
    aarch64|arm64) arch_name="arm64" ;;
  esac
  if curl -fsSL --proto =https \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${os_name}_${arch_name}.tar.gz" \
    -o /tmp/gitleaks.tar.gz \
    && echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c --quiet \
    && tar xzf /tmp/gitleaks.tar.gz -C "${HOME}/.local/bin" gitleaks \
    && rm /tmp/gitleaks.tar.gz; then
    export PATH="${HOME}/.local/bin:${PATH}"
    echo "gitleaks installed"
    return 0
  fi
  echo "::warning::Failed to install gitleaks — secret scans will be skipped"
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
  echo "::warning::No agent-result.json found — checking transcript for summary"
  echo "Run directory: $(pwd)"
  ls -R iteration-*/ 2>/dev/null || true
  exit 0
fi

RESULT_FILE="$(cd "$(dirname "${RESULT_FILE}")" && pwd)/$(basename "${RESULT_FILE}")"
echo "Found agent-result.json: ${RESULT_FILE}"

# ---------------------------------------------------------------------------
# 1b. Validate agent-result.json
# ---------------------------------------------------------------------------
if ! jq empty "${RESULT_FILE}" 2>/dev/null; then
  echo "::error::agent-result.json is not valid JSON"
  exit 1
fi

RESULT_TARGET_BRANCH="$(jq -r '.target_branch // empty' "${RESULT_FILE}")"
if [[ -n "${RESULT_TARGET_BRANCH}" ]]; then
  TARGET_BRANCH="${RESULT_TARGET_BRANCH}"
  echo "Target branch (from result): ${TARGET_BRANCH}"
else
  echo "Target branch (default): ${TARGET_BRANCH}"
fi

WORKSPACE_COUNT="$(jq '.workspaces | length' "${RESULT_FILE}")"
if [[ -z "${WORKSPACE_COUNT}" || "${WORKSPACE_COUNT}" -lt 1 ]]; then
  echo "::error::agent-result.json has no workspaces entries"
  exit 1
fi

echo "Workspaces to process: ${WORKSPACE_COUNT}"

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_NAME="$(jq -r ".workspaces[$i].workspace // empty" "${RESULT_FILE}")"
  if [[ -z "${WS_NAME}" ]]; then
    echo "::error::workspaces[$i] missing workspace name"
    exit 1
  fi

  for field in root_cause fix_category action_taken attempt next_step; do
    val="$(jq -r ".workspaces[$i].${field} // empty" "${RESULT_FILE}")"
    if [[ -z "${val}" ]]; then
      echo "::error::workspaces[$i] (${WS_NAME}) missing required field: ${field}"
      exit 1
    fi
  done

  FIX_CAT="$(jq -r ".workspaces[$i].fix_category" "${RESULT_FILE}")"
  case "${FIX_CAT}" in
    infra_flake|test_fix|product_bug|environment) ;;
    *)
      echo "::error::workspaces[$i] (${WS_NAME}) invalid fix_category: $(sanitize_for_gha "${FIX_CAT}")"
      exit 1
      ;;
  esac

  ACTION="$(jq -r ".workspaces[$i].action_taken" "${RESULT_FILE}")"
  case "${ACTION}" in
    logged|commented_on_existing|issue_tracked|fix_implemented|test_skipped) ;;
    *)
      echo "::error::workspaces[$i] (${WS_NAME}) invalid action_taken: $(sanitize_for_gha "${ACTION}")"
      exit 1
      ;;
  esac

  ISSUE_ACTION="$(jq -r ".workspaces[$i].issue.action // \"skip\"" "${RESULT_FILE}")"
  case "${ISSUE_ACTION}" in
    create)
      for field in title body; do
        val="$(jq -r ".workspaces[$i].issue.${field} // empty" "${RESULT_FILE}")"
        if [[ -z "${val}" ]]; then
          echo "::error::workspaces[$i] (${WS_NAME}) issue.action=create but missing issue.${field}"
          exit 1
        fi
      done
      ;;
    comment)
      for field in number body; do
        val="$(jq -r ".workspaces[$i].issue.${field} // empty" "${RESULT_FILE}")"
        if [[ -z "${val}" ]]; then
          echo "::error::workspaces[$i] (${WS_NAME}) issue.action=comment but missing issue.${field}"
          exit 1
        fi
      done
      ;;
    skip) ;;
    *)
      echo "::error::workspaces[$i] (${WS_NAME}) invalid issue.action: $(sanitize_for_gha "${ISSUE_ACTION}")"
      exit 1
      ;;
  esac

  JIRA_PROJECT="$(jq -r ".workspaces[$i].jira.project // empty" "${RESULT_FILE}")"
  if [[ -n "${JIRA_PROJECT}" ]]; then
    for field in type summary description backfill_file; do
      val="$(jq -r ".workspaces[$i].jira.${field} // empty" "${RESULT_FILE}")"
      if [[ -z "${val}" ]]; then
        echo "::error::workspaces[$i] (${WS_NAME}) jira directive present but missing jira.${field}"
        exit 1
      fi
    done
  fi
done

echo "Validation passed for all ${WORKSPACE_COUNT} workspace(s)"

# ---------------------------------------------------------------------------
# 1c. Scan agent-result.json for secrets before posting as comments
# ---------------------------------------------------------------------------
if install_gitleaks; then
  echo "Scanning agent-result.json for secrets before posting..."
  SCAN_DIR="$(mktemp -d)"
  cp "${RESULT_FILE}" "${SCAN_DIR}/agent-result.json"
  if ! gitleaks detect --source "${SCAN_DIR}" --no-git --redact 2>/dev/null; then
    echo "::error::Secret detected in agent-result.json — refusing to post comments"
    rm -rf "${SCAN_DIR}"
    exit 1
  fi
  rm -rf "${SCAN_DIR}"
  echo "Result file scan passed"
fi

# ---------------------------------------------------------------------------
# 2-3. Execute issue and JIRA directives per workspace
# ---------------------------------------------------------------------------
declare -a WS_ISSUE_NUMBERS=()
declare -a WS_ISSUE_URLS=()
declare -a WS_JIRA_KEYS=()

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_NAME="$(jq -r ".workspaces[$i].workspace" "${RESULT_FILE}")"
  echo ""
  echo "--- Workspace: ${WS_NAME} ---"

  # -----------------------------------------------------------------------
  # 2. GitHub issue directive
  # -----------------------------------------------------------------------
  ISSUE_NUMBER=""
  ISSUE_URL=""
  ISSUE_ACTION="$(jq -r ".workspaces[$i].issue.action // \"skip\"" "${RESULT_FILE}")"

  case "${ISSUE_ACTION}" in
    create)
      echo "  Creating GitHub issue..."
      ISSUE_TITLE="$(jq -r ".workspaces[$i].issue.title" "${RESULT_FILE}")"
      ISSUE_BODY="$(jq -r ".workspaces[$i].issue.body" "${RESULT_FILE}")"

      LABEL_ARGS=()
      while IFS= read -r label; do
        [[ -n "${label}" ]] && LABEL_ARGS+=(--label "${label}")
      done < <(jq -r ".workspaces[$i].issue.labels // [] | .[]" "${RESULT_FILE}")

      if ISSUE_URL="$(gh issue create \
        --repo "${REPO_FULL_NAME}" \
        --title "${ISSUE_TITLE}" \
        "${LABEL_ARGS[@]}" \
        --body "${ISSUE_BODY}" 2>&1)"; then
        ISSUE_NUMBER="$(echo "${ISSUE_URL}" | grep -o '[0-9]*$')"
        echo "  Created issue #${ISSUE_NUMBER}: ${ISSUE_URL}"
      elif echo "${ISSUE_URL}" | grep -qi "label.*not found"; then
        echo "  Label not found — retrying without labels..."
        if ISSUE_URL="$(gh issue create \
          --repo "${REPO_FULL_NAME}" \
          --title "${ISSUE_TITLE}" \
          --body "${ISSUE_BODY}" 2>&1)"; then
          ISSUE_NUMBER="$(echo "${ISSUE_URL}" | grep -o '[0-9]*$')"
          echo "  Created issue #${ISSUE_NUMBER}: ${ISSUE_URL}"
        else
          echo "::warning::Failed to create issue for ${WS_NAME}: $(sanitize_for_gha "${ISSUE_URL}")"
          ISSUE_URL=""
        fi
      else
        if echo "${ISSUE_URL}" | grep -qE "HTTP (401|403)"; then
          echo "::warning::Insufficient permissions to create issue for ${WS_NAME} — skipping"
        else
          echo "::warning::Failed to create issue for ${WS_NAME}: $(sanitize_for_gha "${ISSUE_URL}")"
        fi
        ISSUE_URL=""
      fi
      ;;

    comment)
      ISSUE_NUMBER="$(jq -r ".workspaces[$i].issue.number" "${RESULT_FILE}")"
      COMMENT_BODY="$(jq -r ".workspaces[$i].issue.body" "${RESULT_FILE}")"

      echo "  Commenting on issue #${ISSUE_NUMBER}..."
      if ! COMMENT_OUTPUT="$(gh issue comment "${ISSUE_NUMBER}" \
        --repo "${REPO_FULL_NAME}" \
        --body "${COMMENT_BODY}" 2>&1)"; then
        if echo "${COMMENT_OUTPUT}" | grep -qE "HTTP (401|403)"; then
          echo "::warning::Insufficient permissions to comment on issue #${ISSUE_NUMBER} — skipping"
        else
          echo "::warning::Failed to comment on issue #${ISSUE_NUMBER}: $(sanitize_for_gha "${COMMENT_OUTPUT}")"
        fi
      fi

      ADD_LABELS="$(jq -r ".workspaces[$i].issue.add_labels // [] | join(\",\")" "${RESULT_FILE}")"
      if [[ -n "${ADD_LABELS}" ]]; then
        echo "  Adding labels: ${ADD_LABELS}"
        if ! LABEL_OUTPUT="$(gh issue edit "${ISSUE_NUMBER}" \
          --repo "${REPO_FULL_NAME}" \
          --add-label "${ADD_LABELS}" 2>&1)"; then
          if echo "${LABEL_OUTPUT}" | grep -qE "HTTP (401|403)"; then
            echo "::warning::Insufficient permissions to add labels — skipping"
          else
            echo "::warning::Failed to add labels: $(sanitize_for_gha "${LABEL_OUTPUT}")"
          fi
        fi
      fi

      ISSUE_URL="https://github.com/${REPO_FULL_NAME}/issues/${ISSUE_NUMBER}"
      echo "  Updated issue #${ISSUE_NUMBER}: ${ISSUE_URL}"
      ;;

    skip)
      echo "  No issue directive — skipping"
      ;;
  esac

  WS_ISSUE_NUMBERS+=("${ISSUE_NUMBER}")
  WS_ISSUE_URLS+=("${ISSUE_URL}")

  # -----------------------------------------------------------------------
  # 3. JIRA directive
  # -----------------------------------------------------------------------
  JIRA_KEY=""
  JIRA_PROJECT="$(jq -r ".workspaces[$i].jira.project // empty" "${RESULT_FILE}")"

  if [[ -n "${JIRA_PROJECT}" ]]; then
    if [[ -z "${JIRA_TOKEN:-}" ]]; then
      echo "::warning::JIRA directive for ${WS_NAME} but JIRA_TOKEN not set — skipping"
      jq -r ".workspaces[$i].jira | \"  Project: \" + .project + \"\\n  Summary: \" + .summary" "${RESULT_FILE}"
    else
      echo "::add-mask::${JIRA_TOKEN}"
      echo "  Creating JIRA bug in ${JIRA_PROJECT}..."
      JIRA_SUMMARY="$(jq -r ".workspaces[$i].jira.summary" "${RESULT_FILE}")"
      JIRA_DESCRIPTION="$(jq -r ".workspaces[$i].jira.description" "${RESULT_FILE}")"
      JIRA_TYPE="$(jq -r ".workspaces[$i].jira.type // \"Bug\"" "${RESULT_FILE}")"

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
          echo "  Created JIRA: ${JIRA_KEY} (${JIRA_URL}/browse/${JIRA_KEY})"
        else
          echo "::warning::JIRA response missing key: $(sanitize_for_gha "${JIRA_RESPONSE}")"
        fi
      else
        echo "::warning::JIRA creation failed for ${WS_NAME}: $(sanitize_for_gha "${JIRA_RESPONSE}")"
      fi
    fi
  fi

  WS_JIRA_KEYS+=("${JIRA_KEY}")
done

# ---------------------------------------------------------------------------
# 4. Validate, scan, backfill, push, and create PRs per workspace branch
# ---------------------------------------------------------------------------
if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "::error::REPO_DIR (${REPO_DIR}) is not a git repository"
  exit 1
fi
cd "${REPO_DIR}"

git remote set-url origin \
  "https://x-access-token:${PUSH_TOKEN}@github.com/${PUSH_REPO}.git"
git fetch origin "${TARGET_BRANCH}" --quiet 2>/dev/null || true

declare -a WS_PR_URLS=()

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_NAME="$(jq -r ".workspaces[$i].workspace" "${RESULT_FILE}")"
  BRANCH="$(jq -r ".workspaces[$i].branch // empty" "${RESULT_FILE}")"

  if [[ -z "${BRANCH}" || "${BRANCH}" == "null" ]]; then
    WS_PR_URLS+=("")
    continue
  fi

  echo ""
  echo "--- Branch: ${BRANCH} (${WS_NAME}) ---"

  if ! git checkout "${BRANCH}" 2>/dev/null; then
    echo "::warning::Branch ${BRANCH} not found — skipping push for ${WS_NAME}"
    WS_PR_URLS+=("")
    continue
  fi

  # -----------------------------------------------------------------------
  # 4a. Branch validation — only allow fullsend/ prefixed branches
  # -----------------------------------------------------------------------
  if [[ "${BRANCH}" != fullsend/* ]]; then
    echo "::error::BLOCKED — branch '${BRANCH}' does not start with fullsend/; refusing to push"
    WS_PR_URLS+=("")
    continue
  fi

  # -----------------------------------------------------------------------
  # 4b. Compute changed files
  # -----------------------------------------------------------------------
  MERGE_BASE="$(git merge-base "origin/${TARGET_BRANCH}" HEAD 2>/dev/null)" || MERGE_BASE=""
  if [[ -n "${MERGE_BASE}" ]]; then
    CHANGED="$(git diff --name-only "${MERGE_BASE}..HEAD")"
  else
    CHANGED="$(git diff --name-only HEAD~1..HEAD 2>/dev/null || true)"
  fi

  if [[ -z "${CHANGED}" ]]; then
    echo "  No changed files — skipping push"
    WS_PR_URLS+=("")
    continue
  fi

  echo "  Changed files:"
  echo "${CHANGED}" | sed 's/^/    /'

  # -----------------------------------------------------------------------
  # 4c. Authoritative secret scan (gitleaks)
  # -----------------------------------------------------------------------
  SCAN_RANGE="${MERGE_BASE:-$(git rev-parse HEAD~1 2>/dev/null || git rev-list --max-parents=0 HEAD)}..HEAD"

  if install_gitleaks; then
    echo "  Running secret scan on agent commits..."
    if ! gitleaks detect --source . --log-opts="${SCAN_RANGE}" --redact; then
      echo "::error::BLOCKED — secret detected in agent commits for ${WS_NAME}"
      WS_PR_URLS+=("")
      continue
    fi
    echo "  Secret scan passed"
  fi

  # -----------------------------------------------------------------------
  # 4d. Reject Signed-off-by trailers
  # -----------------------------------------------------------------------
  if git log --format='%b' "${SCAN_RANGE}" | grep -q '^Signed-off-by:'; then
    echo "::error::BLOCKED — agent commit contains a Signed-off-by trailer for ${WS_NAME}"
    WS_PR_URLS+=("")
    continue
  fi

  # -----------------------------------------------------------------------
  # 4e. Backfill JIRA key
  # -----------------------------------------------------------------------
  NEEDS_AMEND=false
  JIRA_KEY="${WS_JIRA_KEYS[$i]}"
  ISSUE_NUMBER="${WS_ISSUE_NUMBERS[$i]}"

  if [[ -n "${JIRA_KEY}" ]]; then
    BACKFILL_FILE="$(jq -r ".workspaces[$i].jira.backfill_file // empty" "${RESULT_FILE}")"
    if [[ -n "${BACKFILL_FILE}" && -f "${BACKFILL_FILE}" ]] \
       && [[ "$(realpath "${BACKFILL_FILE}")" == "$(realpath .)/workspaces/"* ]]; then
      if grep -q 'JIRA-PENDING' "${BACKFILL_FILE}"; then
        echo "  Backfilling JIRA key ${JIRA_KEY} in ${BACKFILL_FILE}"
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

  # -----------------------------------------------------------------------
  # 4f. Backfill issue number
  # -----------------------------------------------------------------------
  if [[ -n "${ISSUE_NUMBER}" ]]; then
    BF_BASE="$(git merge-base "origin/${TARGET_BRANCH}" HEAD 2>/dev/null)" || BF_BASE=""
    if [[ -n "${BF_BASE}" ]]; then
      CHANGED_FILES="$(git diff --name-only "${BF_BASE}..HEAD")"
    else
      CHANGED_FILES="$(git diff --name-only HEAD~1..HEAD 2>/dev/null || true)"
    fi
    while IFS= read -r f; do
      [[ -z "${f}" ]] && continue
      if [[ -f "${f}" ]] && grep -q 'ISSUE_PLACEHOLDER' "${f}"; then
        echo "  Backfilling issue #${ISSUE_NUMBER} in ${f}"
        sed -i.bak "s/ISSUE_PLACEHOLDER/${ISSUE_NUMBER}/g" "${f}"
        rm -f "${f}.bak"
        git add "${f}"
        NEEDS_AMEND=true
      fi
    done <<< "${CHANGED_FILES}"
  fi

  if [[ "${NEEDS_AMEND}" == "true" ]]; then
    OLD_MSG="$(git log -1 --format='%B')"
    NEW_MSG="${OLD_MSG}"
    [[ -n "${JIRA_KEY}" ]] && NEW_MSG="$(echo "${NEW_MSG}" | sed "s/JIRA-PENDING/${JIRA_KEY}/g")"
    [[ -n "${ISSUE_NUMBER}" ]] && NEW_MSG="$(echo "${NEW_MSG}" | sed "s/ISSUE_PLACEHOLDER/${ISSUE_NUMBER}/g")"

    git commit --amend -m "${NEW_MSG}"
    echo "  Amended commit with backfilled placeholders"

    # Re-scan after amend if gitleaks is available
    if command -v gitleaks >/dev/null 2>&1; then
      echo "  Re-running secret scan on amended commit..."
      if ! gitleaks detect --source . --log-opts="${SCAN_RANGE}" --redact; then
        echo "::error::BLOCKED — secret detected in amended commit for ${WS_NAME}"
        WS_PR_URLS+=("")
        continue
      fi
    fi
  fi

  # -----------------------------------------------------------------------
  # 4g. Push branch
  # -----------------------------------------------------------------------
  echo "  Pushing branch ${BRANCH}..."
  PUSH_OUTPUT=""
  PUSH_OUTPUT="$(git push -u origin -- "${BRANCH}" 2>&1)" && PUSH_RC=0 || PUSH_RC=$?
  echo "${PUSH_OUTPUT}"

  if [[ "${PUSH_RC}" -ne 0 ]]; then
    if echo "${PUSH_OUTPUT}" | grep -qi "non-fast-forward\|rejected\|fetch first"; then
      echo "::warning::Plain push failed — retrying with --force-with-lease"
      if ! git push --force-with-lease -u origin -- "${BRANCH}" 2>&1; then
        echo "::error::Force-with-lease push also failed for ${BRANCH}"
        WS_PR_URLS+=("")
        continue
      fi
    else
      echo "::error::Push failed for ${BRANCH}: $(sanitize_for_gha "${PUSH_OUTPUT}")"
      WS_PR_URLS+=("")
      continue
    fi
  fi

  # -----------------------------------------------------------------------
  # 4h. Create or update PR
  # -----------------------------------------------------------------------
  PR_URL=""
  PUSH_OWNER="${PUSH_REPO%%/*}"
  if [[ "${PUSH_REPO}" == "${REPO_FULL_NAME}" ]]; then
    PR_HEAD="${BRANCH}"
  else
    PR_HEAD="${PUSH_OWNER}:${BRANCH}"
  fi

  EXISTING_PR="$(gh pr list --repo "${REPO_FULL_NAME}" --head "${PR_HEAD}" \
    --json number,url --jq '.[0]' 2>/dev/null || true)"

  if [[ -n "${EXISTING_PR}" && "${EXISTING_PR}" != "null" ]]; then
    PR_URL="$(echo "${EXISTING_PR}" | jq -r '.url')"
    PR_NUM="$(echo "${EXISTING_PR}" | jq -r '.number')"
    echo "  PR #${PR_NUM} already exists — branch updated: ${PR_URL}"
  else
    echo "  Creating PR..."
    COMMIT_SUBJECT="$(git log -1 --format='%s')"
    COMMIT_BODY="$(git log -1 --format='%b' | sed '/^$/d')"

    PR_BODY="${COMMIT_BODY}"
    [[ -n "${ISSUE_NUMBER}" ]] && PR_BODY="${PR_BODY}

Closes #${ISSUE_NUMBER}"
    [[ -n "${JIRA_KEY}" ]] && PR_BODY="${PR_BODY}

JIRA: [${JIRA_KEY}](${JIRA_URL}/browse/${JIRA_KEY})"

    if ! PR_URL="$(gh pr create \
      --repo "${REPO_FULL_NAME}" \
      --head "${PR_HEAD}" \
      --base "${TARGET_BRANCH}" \
      --title "${COMMIT_SUBJECT}" \
      --body "${PR_BODY}" 2>&1)"; then
      if echo "${PR_URL}" | grep -qE "HTTP (401|403)"; then
        echo "::error::Insufficient permissions to create PR for ${BRANCH}"
      else
        echo "::error::Failed to create PR for ${BRANCH}: $(sanitize_for_gha "${PR_URL}")"
      fi
      PR_URL=""
    else
      echo "  PR created: ${PR_URL}"
    fi
  fi

  WS_PR_URLS+=("${PR_URL}")
done

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== E2E Fix Agent Results ==="
echo "Workspaces processed: ${WORKSPACE_COUNT}"

for i in $(seq 0 $((WORKSPACE_COUNT - 1))); do
  WS_NAME="$(jq -r ".workspaces[$i].workspace" "${RESULT_FILE}")"
  FIX_CAT="$(jq -r ".workspaces[$i].fix_category" "${RESULT_FILE}")"
  ACTION="$(jq -r ".workspaces[$i].action_taken" "${RESULT_FILE}")"
  ATTEMPT="$(jq -r ".workspaces[$i].attempt" "${RESULT_FILE}")"
  TEST_COUNT="$(jq ".workspaces[$i].tests | length" "${RESULT_FILE}")"
  BRANCH="$(jq -r ".workspaces[$i].branch // empty" "${RESULT_FILE}")"
  ROOT_CAUSE="$(jq -r ".workspaces[$i].root_cause" "${RESULT_FILE}")"

  echo ""
  echo "  [${WS_NAME}]"
  echo "    Root cause:    ${ROOT_CAUSE}"
  echo "    Category:      ${FIX_CAT}"
  echo "    Action:        ${ACTION}"
  echo "    Attempt:       ${ATTEMPT}"
  echo "    Tests:         ${TEST_COUNT}"

  if [[ -n "${BRANCH}" && "${BRANCH}" != "null" ]]; then
    echo "    Branch:        ${BRANCH}"
  else
    echo "    Branch:        (none)"
  fi

  ISSUE_URL="${WS_ISSUE_URLS[$i]:-}"
  [[ -n "${ISSUE_URL}" ]] && echo "    Issue:         ${ISSUE_URL}"

  PR_URL="${WS_PR_URLS[$i]:-}"
  [[ -n "${PR_URL}" ]] && echo "    PR:            ${PR_URL}"

  JIRA_KEY="${WS_JIRA_KEYS[$i]:-}"
  [[ -n "${JIRA_KEY}" ]] && echo "    JIRA:          ${JIRA_KEY} (${JIRA_URL}/browse/${JIRA_KEY})"
done

echo ""
echo "Post-e2e-fix complete."
