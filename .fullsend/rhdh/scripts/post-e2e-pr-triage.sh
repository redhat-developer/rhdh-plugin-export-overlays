#!/usr/bin/env bash
# Report a read-only PR triage result on the originating pull request.
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
REPO_FULL_NAME="${REPO_FULL_NAME:-redhat-developer/rhdh-plugin-export-overlays}"

: "${GH_TOKEN:?GH_TOKEN is required}"
PUSH_TOKEN="${PUSH_TOKEN:-${GH_TOKEN}}"
export GH_TOKEN="${PUSH_TOKEN}"
echo "::add-mask::${GH_TOKEN}"

PR_URL="${GITHUB_ISSUE_URL:-}"
PR_NUMBER="${PR_URL##*/}"
if [[ ! "${PR_NUMBER}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::Could not extract PR number from GITHUB_ISSUE_URL"
  exit 1
fi

remove_trigger_label() {
  local encoded
  encoded="$(printf '%s' 'e2e-pr-triage' | jq -sRr @uri)"
  gh api "repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/labels/${encoded}" \
    -X DELETE --silent 2>/dev/null || true
}

# Always make the PR eligible for another distinct Prow failure, including
# when output validation, secret scanning, or result posting fails.
trap remove_trigger_label EXIT

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1; then
    return 0
  fi
  local install_dir archive
  install_dir="${RUNNER_TEMP:-/tmp}/e2e-pr-triage-bin"
  archive="${RUNNER_TEMP:-/tmp}/gitleaks-${GITLEAKS_VERSION}.tar.gz"
  mkdir -p "${install_dir}"
  curl -fsSL --proto =https \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    -o "${archive}"
  echo "${GITLEAKS_SHA256}  ${archive}" | sha256sum -c --quiet
  tar xzf "${archive}" -C "${install_dir}" gitleaks
  export PATH="${install_dir}:${PATH}"
}

RESULT_FILE=""
for output_dir in iteration-*/output; do
  if [[ -f "${output_dir}/agent-result.json" ]]; then
    RESULT_FILE="${output_dir}/agent-result.json"
  elif [[ -f "${output_dir}/result.json" ]]; then
    RESULT_FILE="${output_dir}/result.json"
  fi
done
if [[ -z "${RESULT_FILE}" ]]; then
  echo "::warning::No PR triage result was produced"
  exit 0
fi

if ! jq empty "${RESULT_FILE}" >/dev/null 2>&1; then
  echo "::error::PR triage result is not valid JSON"
  exit 1
fi

if [[ "$(jq -r '.pr_number' "${RESULT_FILE}")" != "${PR_NUMBER}" ]]; then
  echo "::error::Triage result targets a different PR"
  exit 1
fi

install_gitleaks
scan_dir="$(mktemp -d)"
cp "${RESULT_FILE}" "${scan_dir}/agent-result.json"
if ! gitleaks detect --source "${scan_dir}" --no-git --redact 2>/dev/null; then
  echo "::error::Secret detected in PR triage result — refusing to post"
  rm -rf "${scan_dir}"
  exit 1
fi
rm -rf "${scan_dir}"

recorded_head="$(jq -r '.pr_head_sha' "${RESULT_FILE}")"
current_head="$(gh api "repos/${REPO_FULL_NAME}/pulls/${PR_NUMBER}" --jq '.head.sha')"
if [[ "${recorded_head}" != "${current_head}" ]]; then
  message_file="$(mktemp)"
  printf '%s\n' \
    '<!-- fullsend:e2e-pr-triage-stale -->' \
    'E2E triage finished after this PR advanced, so the result was not posted.' \
    '' \
    "Analyzed head: \`${recorded_head}\`" \
    "Current head: \`${current_head}\`" > "${message_file}"
  gh pr comment "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" --body-file "${message_file}"
  rm -f "${message_file}"
  exit 0
fi

comment_file="$(mktemp)"
jq -r '
  "<!-- fullsend:e2e-pr-triage-result workspace=\(.workspace) head=\(.pr_head_sha) job=\(.job_id) -->\n" +
  "## E2E triage result\n\n" +
  "| Field | Result |\n|---|---|\n" +
  "| Workspace | `\(.workspace)` |\n" +
  "| Classification | `\(.fix_category)` |\n" +
  "| Recommendation | `\(.recommended_action)` |\n" +
  "| Prow job | `\(.job_id)` |\n\n" +
  "### Root cause\n\n\(.root_cause)\n\n" +
  "### Evidence\n\n" + (.evidence | map("- " + .) | join("\n")) + "\n\n" +
  "### Suggested remediation\n\n" +
  (if (.remediation.instructions | length) == 0 then "No repository change recommended."
   else (.remediation.instructions | map("- " + .) | join("\n")) end) + "\n\n" +
  "Allowed paths: " + (.remediation.allowed_paths | map("`" + . + "`") | join(", ")) + "\n\n" +
  (if (.remediation.verification | length) == 0 then ""
   else "Verification:\n" + (.remediation.verification | map("- `" + . + "`") | join("\n")) + "\n\n" end) +
  "[Build log](\(.build_log_url))\n\n" +
  "> Read-only pilot: Fullsend has not changed this PR."
' "${RESULT_FILE}" > "${comment_file}"

gh pr comment "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" --body-file "${comment_file}"
rm -f "${comment_file}"

echo "Posted read-only E2E triage result on PR #${PR_NUMBER}"
