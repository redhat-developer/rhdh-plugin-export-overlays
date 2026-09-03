#!/usr/bin/env bash
# Post-script: upsert ONE sticky CI-diagnose comment on the PR.
#
# Runs on the GitHub Actions runner AFTER the sandbox is destroyed.
# The ci-diagnose agent runs read-only and cannot write to GitHub. It renders
# the comment markdown into agent-result.json (`comment_body`); this script
# posts it — editing the existing sticky comment in place when one exists, so
# re-runs UPDATE the comment rather than spamming a new one per check.
#
# This script does NOT:
#   - Push branches, create PRs, or create issues (ci-diagnose is diagnose-only)
#   - Add or remove labels (the bootstrap workflow owns the ci-diagnose label)
#   - Perform any classification (the agent does that in-sandbox)
#
# After the sticky upsert, for bot-authored same-repo PRs with pr_regression
# findings, it may submit a CHANGES_REQUESTED review as the review App
# (fullsend-ai-review[bot]). That is the built-in bot→fix on-ramp in
# reusable-dispatch.yml — no PAT, no slash-command impersonation.
#
# Steps:
#   1. Locate and validate agent-result.json
#   2. Scan the result file for secrets (gitleaks) — refuse to post on a hit
#   3. Resolve the PR number (from the result, falling back to GITHUB_ISSUE_URL)
#   4. If the PR advanced past the analyzed head_sha while the agent ran,
#      swap in a stale notice instead of the (now outdated) diagnosis
#   5. Find the existing sticky comment via the `<!-- ci-diagnose -->` marker
#   6. PATCH it in place if found, else create a new comment
#   7. Maybe request-changes so the fix agent picks up pr_regression findings
#
# Required environment variables:
#   GH_TOKEN          — GitHub token with pull-requests/issues write
#   REPO_FULL_NAME    — owner/repo (default: redhat-developer/rhdh-plugin-export-overlays)
#
# Optional environment variables:
#   GITHUB_ISSUE_URL  — HTML URL of the PR (fallback source for the PR number)
#   PUSH_TOKEN        — dedicated write token (falls back to GH_TOKEN)
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

STICKY_MARKER="<!-- ci-diagnose -->"
AUTOFIX_MARKER_PREFIX="<!-- ci-diagnose-autofix:"
EXHAUSTED_MARKER="<!-- ci-diagnose-autofix-exhausted -->"
CODER_BOT_LOGIN="fullsend-ai-coder[bot]"
MAX_AUTOFIX_ATTEMPTS=2
REPO_FULL_NAME="${REPO_FULL_NAME:-redhat-developer/rhdh-plugin-export-overlays}"

: "${GH_TOKEN:?GH_TOKEN is required}"
export GH_TOKEN
echo "::add-mask::${GH_TOKEN}"

PUSH_TOKEN="${PUSH_TOKEN:-${GH_TOKEN}}"
echo "::add-mask::${PUSH_TOKEN}"

# Promote to PUSH_TOKEN for write permissions on PR comments.
export GH_TOKEN="${PUSH_TOKEN}"

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

skip_handoff() {
  echo "::notice::$(sanitize_for_gha "${1:-}")"
}

# Merge paginated REST list pages into one JSON array.
fetch_json_array() {
  local dest="$1"
  local endpoint="$2"
  local raw
  raw="$(mktemp)"
  if ! gh api "${endpoint}" --paginate > "${raw}"; then
    rm -f "${raw}"
    return 1
  fi
  if ! jq -s 'add // []' "${raw}" > "${dest}"; then
    rm -f "${raw}"
    return 1
  fi
  rm -f "${raw}"
  jq -e 'type == "array"' "${dest}" >/dev/null
}

# Submit CHANGES_REQUESTED for pr_regression findings so fullsend's inlined
# fix job runs (review-bot path). Always return 0: a hand-off miss must not
# fail the sticky comment we already posted. API errors skip (fail closed).
maybe_handoff_to_fix() {
  if [[ "${STALE}" == "true" ]]; then
    skip_handoff "Stale diagnosis — not requesting changes"
    return 0
  fi
  if [[ -z "${RECORDED_HEAD}" ]]; then
    skip_handoff "No analyzed head_sha — not requesting changes"
    return 0
  fi

  local regression_count
  if ! regression_count="$(jq '[.checks[]? | select(.classification == "pr_regression" and ((.suggestion // "") | length) > 0)] | length' "${RESULT_FILE}")"; then
    skip_handoff "Failed to read pr_regression findings — skipping fix hand-off (fail closed)"
    return 0
  fi
  if [[ ! "${regression_count}" =~ ^[0-9]+$ ]] || [[ "${regression_count}" -lt 1 ]]; then
    skip_handoff "No pr_regression findings — not requesting changes"
    return 0
  fi

  local pr_json
  if ! pr_json="$(gh api "repos/${REPO_FULL_NAME}/pulls/${PR_NUMBER}")"; then
    skip_handoff "Failed to fetch PR #${PR_NUMBER} — skipping fix hand-off (fail closed)"
    return 0
  fi

  local pr_author head_repo base_repo
  pr_author="$(printf '%s' "${pr_json}" | jq -r '.user.login // empty')"
  head_repo="$(printf '%s' "${pr_json}" | jq -r '.head.repo.full_name // empty')"
  base_repo="$(printf '%s' "${pr_json}" | jq -r '.base.repo.full_name // empty')"

  if [[ "${pr_author}" != "${CODER_BOT_LOGIN}" ]]; then
    skip_handoff "PR author ${pr_author} is not ${CODER_BOT_LOGIN} — not auto-fixing"
    return 0
  fi
  if [[ -z "${head_repo}" || "${head_repo}" != "${base_repo}" ]]; then
    skip_handoff "Fork PR (head=${head_repo:-none}, base=${base_repo}) — auto-fix blocked"
    return 0
  fi

  local labels
  if ! labels="$(gh api "repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/labels" --paginate --jq '.[].name')"; then
    skip_handoff "Failed to read labels — skipping fix hand-off (fail closed)"
    return 0
  fi
  if printf '%s\n' "${labels}" | grep -qx "fullsend-no-fix"; then
    skip_handoff "fullsend-no-fix label present — auto-fix disabled for this PR"
    return 0
  fi

  local comments reviews
  comments="$(mktemp)"
  reviews="$(mktemp)"
  if ! fetch_json_array "${comments}" "repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/comments"; then
    rm -f "${comments}" "${reviews}"
    skip_handoff "Failed to list PR comments — skipping fix hand-off (fail closed)"
    return 0
  fi
  if ! fetch_json_array "${reviews}" "repos/${REPO_FULL_NAME}/pulls/${PR_NUMBER}/reviews"; then
    rm -f "${comments}" "${reviews}"
    skip_handoff "Failed to list PR reviews — skipping fix hand-off (fail closed)"
    return 0
  fi

  local human
  if ! human="$(jq '[.[]
    | select(.user.type != "Bot")
    | select((.body // "") | test("^\\s*/fs-fix(\\s|$)"))] | length' "${comments}")"; then
    rm -f "${comments}" "${reviews}"
    skip_handoff "Failed to scan comments for /fs-fix — skipping fix hand-off (fail closed)"
    return 0
  fi
  if [[ "${human}" =~ ^[0-9]+$ && "${human}" -gt 0 ]]; then
    rm -f "${comments}" "${reviews}"
    skip_handoff "A human already posted /fs-fix — backing off"
    return 0
  fi

  local sha_marker dup n exh
  sha_marker="${AUTOFIX_MARKER_PREFIX} ${RECORDED_HEAD} -->"
  if ! dup="$(jq --arg m "${sha_marker}" \
    '[.[] | select(.body != null and (.body | contains($m)))] | length' "${reviews}")"; then
    rm -f "${comments}" "${reviews}"
    skip_handoff "Failed to scan reviews for per-SHA marker — skipping fix hand-off (fail closed)"
    return 0
  fi
  if [[ "${dup}" =~ ^[0-9]+$ && "${dup}" -gt 0 ]]; then
    rm -f "${comments}" "${reviews}"
    skip_handoff "Already handed off for ${RECORDED_HEAD} — idempotent skip"
    return 0
  fi

  if ! n="$(jq --arg p "${AUTOFIX_MARKER_PREFIX}" \
    '[.[] | select(.body != null and (.body | contains($p)))] | length' "${reviews}")"; then
    rm -f "${comments}" "${reviews}"
    skip_handoff "Failed to count prior auto-fix reviews — skipping fix hand-off (fail closed)"
    return 0
  fi
  if [[ ! "${n}" =~ ^[0-9]+$ ]]; then
    rm -f "${comments}" "${reviews}"
    skip_handoff "Could not parse auto-fix attempt count — skipping fix hand-off (fail closed)"
    return 0
  fi
  if [[ "${n}" -ge "${MAX_AUTOFIX_ATTEMPTS}" ]]; then
    if ! exh="$(jq --arg m "${EXHAUSTED_MARKER}" \
      '[.[] | select(.body != null and (.body | contains($m)))] | length' "${comments}")"; then
      rm -f "${comments}" "${reviews}"
      skip_handoff "Failed to scan for exhausted marker — skipping fix hand-off (fail closed)"
      return 0
    fi
    if [[ "${exh}" =~ ^[0-9]+$ && "${exh}" -eq 0 ]]; then
      local note
      note="$(mktemp)"
      {
        echo "Automated fix reached its ${MAX_AUTOFIX_ATTEMPTS}-attempt limit for this PR and CI is still failing. A maintainer can take over with \`/fs-fix <instruction>\`, or stop auto-fix with \`/fs-fix-stop\`."
        echo ""
        echo "${EXHAUSTED_MARKER}"
      } > "${note}"
      if gh pr comment "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" --body-file "${note}"; then
        echo "Posted budget-exhausted note on PR #${PR_NUMBER}"
      else
        echo "::warning::Failed to post budget-exhausted note on PR #${PR_NUMBER}"
      fi
      rm -f "${note}"
    fi
    rm -f "${comments}" "${reviews}"
    skip_handoff "Auto-fix budget exhausted (${n} attempts) — a human can take over with /fs-fix"
    return 0
  fi
  rm -f "${comments}" "${reviews}"

  local review_file
  review_file="$(mktemp)"
  if ! {
    echo "CI diagnosis found PR-regression failures on \`${RECORDED_HEAD}\`."
    echo ""
    echo "These findings are caused by this PR. Implement each suggested fix. Do not treat them as out of scope. Leave flake, pre_existing, config_env, product_bug, and needs_human checks alone."
    echo ""
    jq -r '
      .checks[]?
      | select(.classification == "pr_regression" and ((.suggestion // "") | length) > 0)
      | "### `\(.name)`\n\n\(.suggestion)\n\nRoot cause: \(.root_cause)\n"
    ' "${RESULT_FILE}"
    echo ""
    echo "${sha_marker}"
  } > "${review_file}"; then
    rm -f "${review_file}"
    skip_handoff "Failed to render review body — skipping fix hand-off (fail closed)"
    return 0
  fi

  if [[ ! -s "${review_file}" ]]; then
    rm -f "${review_file}"
    skip_handoff "Review body was empty — not requesting changes"
    return 0
  fi

  local review_stderr
  review_stderr="$(mktemp)"
  if gh pr review "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" \
       --request-changes --body-file "${review_file}" 2>"${review_stderr}"; then
    echo "Requested changes for ${RECORDED_HEAD} on PR #${PR_NUMBER} (attempt $((n + 1))/${MAX_AUTOFIX_ATTEMPTS}) — fix agent should run"
  else
    echo "::warning::Failed to submit CHANGES_REQUESTED review: $(sanitize_for_gha "$(cat "${review_stderr}")")"
  fi
  rm -f "${review_file}" "${review_stderr}"
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

if ! jq empty "${RESULT_FILE}" 2>/dev/null; then
  echo "::error::agent-result.json is not valid JSON"
  exit 1
fi

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
# 3. Resolve PR number and comment body
# ---------------------------------------------------------------------------
PR_NUMBER="$(jq -r '.pr_number // empty' "${RESULT_FILE}")"
if [[ ! "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
  # Fall back to parsing the PR number from the trigger URL. GITHUB_ISSUE_URL
  # is documented as optional — reference it with :- so this doesn't trip
  # "unbound variable" under set -u when it's unset entirely.
  PR_NUMBER="${GITHUB_ISSUE_URL:-}"
  PR_NUMBER="${PR_NUMBER##*/}"
fi
if [[ ! "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
  echo "::error::Could not resolve a numeric PR number (result=$(sanitize_for_gha "${PR_NUMBER}"), url=$(sanitize_for_gha "${GITHUB_ISSUE_URL:-unset}"))"
  exit 1
fi

BODY_FILE="$(mktemp)"
jq -r '.comment_body // empty' "${RESULT_FILE}" > "${BODY_FILE}"
if [[ ! -s "${BODY_FILE}" ]]; then
  echo "::error::agent-result.json has no comment_body"
  rm -f "${BODY_FILE}"
  exit 1
fi

# Guard: the body must carry the sticky marker so future runs can find it.
if ! grep -qF "${STICKY_MARKER}" "${BODY_FILE}"; then
  echo "::error::comment_body is missing the sticky marker '${STICKY_MARKER}' — refusing to post"
  rm -f "${BODY_FILE}"
  exit 1
fi

VERDICT="$(jq -r '.verdict // "unknown"' "${RESULT_FILE}")"
CHECK_COUNT="$(jq -r '.checks | length' "${RESULT_FILE}")"
echo "PR #${PR_NUMBER} — verdict: ${VERDICT} — ${CHECK_COUNT} check(s)"

# ---------------------------------------------------------------------------
# 4. Refuse to post a stale diagnosis
# ---------------------------------------------------------------------------
# The agent can run for up to timeout_minutes; a new commit may land on the
# PR before it finishes. head_sha is the commit the agent actually analyzed
# (read at agent runtime, per the schema) — compare it against the PR's
# CURRENT head rather than trusting the trigger event.
RECORDED_HEAD="$(jq -r '.head_sha // empty' "${RESULT_FILE}")"
STALE="false"
if [[ -n "${RECORDED_HEAD}" ]]; then
  CURRENT_HEAD="$(gh api "repos/${REPO_FULL_NAME}/pulls/${PR_NUMBER}" --jq '.head.sha' 2>/dev/null || true)"
  if [[ -n "${CURRENT_HEAD}" && "${RECORDED_HEAD}" != "${CURRENT_HEAD}" ]]; then
    STALE="true"
    echo "::warning::Analyzed head $(sanitize_for_gha "${RECORDED_HEAD}") is stale (current head $(sanitize_for_gha "${CURRENT_HEAD}")) — posting a stale notice instead"
    {
      echo "${STICKY_MARKER}"
      echo "### 🔍 CI Diagnosis"
      echo ""
      echo "This PR advanced before the diagnosis finished, so the result below is outdated and was not posted."
      echo ""
      echo "- Analyzed head: \`${RECORDED_HEAD}\`"
      echo "- Current head: \`${CURRENT_HEAD}\`"
      echo ""
      echo "A fresh diagnosis will run automatically as CI completes on the new commit."
    } > "${BODY_FILE}"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Find the existing sticky comment
# ---------------------------------------------------------------------------
EXISTING_ID="$(gh api "repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/comments" --paginate \
  --jq "[.[] | select(.body | contains(\"${STICKY_MARKER}\"))] | last | .id // empty" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# 6. Upsert the comment
# ---------------------------------------------------------------------------
if [[ -n "${EXISTING_ID}" ]]; then
  echo "Editing existing sticky comment #${EXISTING_ID}..."
  patch_stderr="$(mktemp)"
  if jq -n --rawfile body "${BODY_FILE}" '{body: $body}' \
    | gh api "repos/${REPO_FULL_NAME}/issues/comments/${EXISTING_ID}" \
        -X PATCH --input - --silent 2>"${patch_stderr}"; then
    echo "Updated sticky comment #${EXISTING_ID} on PR #${PR_NUMBER}"
  else
    echo "::error::Failed to edit comment #${EXISTING_ID}: $(sanitize_for_gha "$(cat "${patch_stderr}")")"
    rm -f "${patch_stderr}" "${BODY_FILE}"
    exit 1
  fi
  rm -f "${patch_stderr}"
else
  echo "No existing sticky comment — creating a new one..."
  create_stderr="$(mktemp)"
  if gh pr comment "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" \
      --body-file "${BODY_FILE}" 2>"${create_stderr}"; then
    echo "Created sticky comment on PR #${PR_NUMBER}"
  else
    echo "::error::Failed to create comment on PR #${PR_NUMBER}: $(sanitize_for_gha "$(cat "${create_stderr}")")"
    rm -f "${create_stderr}" "${BODY_FILE}"
    exit 1
  fi
  rm -f "${create_stderr}"
fi

rm -f "${BODY_FILE}"

# ---------------------------------------------------------------------------
# 7. Maybe hand off pr_regression findings to the fix agent
# ---------------------------------------------------------------------------
if ! maybe_handoff_to_fix; then
  echo "::warning::Fix hand-off failed unexpectedly"
fi

echo ""
if [[ "${STALE}" == "true" ]]; then
  echo "=== CI Diagnose posted (stale notice) ==="
  echo "PR:            #${PR_NUMBER}"
  echo "Analyzed head: ${RECORDED_HEAD}"
  echo "Current head:  ${CURRENT_HEAD}"
else
  echo "=== CI Diagnose posted ==="
  echo "PR:      #${PR_NUMBER}"
  echo "Verdict: ${VERDICT}"
  echo "Checks:  ${CHECK_COUNT}"
fi
echo ""
echo "Post-ci-diagnose complete."
