#!/usr/bin/env bash
#
# Shared E2E code quality checks.
# Runs ESLint, Prettier, and TypeScript checks for the given workspaces.
#
# Usage:
#   scripts/e2e-code-quality.sh <workspace1> [workspace2] ...
#
# Called by:
#   - .githooks/pre-commit (staged file detection)
#   - .github/workflows/e2e-code-quality.yaml (PR diff detection)
#

set -euo pipefail

# Print error message to stderr. Uses GitHub Actions annotation syntax
# in CI, plain text locally.
report_error() {
  local msg="$1"
  if [[ -n "${CI:-}" ]]; then
    echo "::error::${msg}" >&2
  else
    echo "ERROR: ${msg}" >&2
  fi
}

if [[ $# -eq 0 ]]; then
  echo "No workspaces provided. Nothing to validate."
  exit 0
fi

FAILED=0
RESULTS=""

for WORKSPACE in "$@"; do
  E2E_DIR="workspaces/${WORKSPACE}/e2e-tests"

  if [[ ! -d "$E2E_DIR" ]]; then
    echo "Warning: ${E2E_DIR} does not exist, skipping"
    continue
  fi

  echo ""
  echo "========================================"
  echo "Validating: ${WORKSPACE}"
  echo "========================================"

  echo "Installing dependencies..."
  if ! (cd "$E2E_DIR" && yarn install --immutable 2>&1); then
    report_error "yarn install failed for ${WORKSPACE}"
    RESULTS="${RESULTS}| ${WORKSPACE} | FAIL (install) | FAIL (install) | FAIL (install) |\n"
    FAILED=1
    continue
  fi

  LINT_RESULT="pass"
  PRETTIER_RESULT="pass"
  TSC_RESULT="pass"

  echo ""
  echo "--- ESLint ---"
  if (cd "$E2E_DIR" && yarn lint:check 2>&1); then
    echo "ESLint: passed"
  else
    report_error "ESLint failed for ${WORKSPACE}"
    LINT_RESULT="FAIL"
    FAILED=1
  fi

  echo ""
  echo "--- Prettier ---"
  if (cd "$E2E_DIR" && yarn prettier:check 2>&1); then
    echo "Prettier: passed"
  else
    report_error "Prettier failed for ${WORKSPACE}"
    PRETTIER_RESULT="FAIL"
    FAILED=1
  fi

  echo ""
  echo "--- TypeScript ---"
  if (cd "$E2E_DIR" && yarn tsc:check 2>&1); then
    echo "TypeScript: passed"
  else
    report_error "TypeScript failed for ${WORKSPACE}"
    TSC_RESULT="FAIL"
    FAILED=1
  fi

  RESULTS="${RESULTS}| ${WORKSPACE} | ${LINT_RESULT} | ${PRETTIER_RESULT} | ${TSC_RESULT} |\n"
done

echo ""
echo "========================================"
echo "Summary"
echo "========================================"

# Write GitHub step summary in CI
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### E2E Code Quality Results"
    echo ""
    echo "| Workspace | ESLint | Prettier | TypeScript |"
    echo "|-----------|--------|----------|------------|"
    printf '%b' "$RESULTS"
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo ""
printf '%s\n' "| Workspace | ESLint | Prettier | TypeScript |"
printf '%s\n' "|-----------|--------|----------|------------|"
printf '%b' "$RESULTS"

if [[ "$FAILED" -ne 0 ]]; then
  echo ""
  echo "One or more checks failed."
  exit 1
fi

echo ""
echo "All checks passed."
