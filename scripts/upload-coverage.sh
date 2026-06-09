#!/usr/bin/env bash
#
# Upload Istanbul/lcov coverage to Codecov, attributed to THIS repo's commit.
#
# Usage:
#   ./scripts/upload-coverage.sh <workspace-name>
#
# Example:
#   E2E_COLLECT_COVERAGE=true ./run-e2e.sh -w tech-radar
#   ./scripts/upload-coverage.sh tech-radar
#
# Coverage is uploaded to the Codecov project of this overlay repo
# (redhat-developer/rhdh-plugin-export-overlays), flagged `e2e-<workspace>`,
# against the overlay commit currently being tested. Earlier versions attributed
# coverage to the upstream source repo + the historical `repo-ref` commit from
# source.json, but Codecov finalizes a commit's report shortly after that
# commit's own CI completes — uploads to an already-finalized historical commit
# are accepted by the API and never displayed. Uploading to the fresh overlay
# commit keeps the data live, avoids needing other orgs' tokens, and keeps
# RHDH-specific E2E numbers off upstream community dashboards.
#
# Trade-off: this repo does not contain the plugin source files, so Codecov
# cannot render line-level annotations — only the per-flag coverage percentage
# and its trend, which is the metric we want from E2E runs.
#
# Required environment:
#   CODECOV_TOKEN       - Codecov upload token for this repo's project.
#                         Falls back to VAULT_CODECOV_TOKEN (see below).
# Optional environment:
#   CODECOV_UPLOAD_SLUG - GitHub slug of the Codecov project to upload to.
#                         Default: redhat-developer/rhdh-plugin-export-overlays.
#   PULL_PULL_SHA       - PR head SHA (set by Prow presubmits).
#   PULL_NUMBER         - PR number (set by Prow presubmits).
#   GITHUB_SHA          - Commit SHA (set by GitHub Actions).
#   GIT_PR_NUMBER       - PR number fallback (exported by the E2E CI step).

set -euo pipefail

# OpenShift CI auto-exports Vault secret keys prefixed with VAULT_ (the
# rhdh-plugin-export-overlays ocp-helm step mounts the test-credentials secret
# and exports every VAULT_* key). Accept VAULT_CODECOV_TOKEN as a fallback so the
# token only has to be added to that Vault secret — no openshift/release change.
: "${CODECOV_TOKEN:=${VAULT_CODECOV_TOKEN:-}}"

readonly AWK_FIRST_FIELD='{print $1}'

WORKSPACE="${1:?Usage: $0 <workspace-name>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COVERAGE_DIR="$REPO_ROOT/coverage"
LCOV_FILE="$COVERAGE_DIR/lcov.info"

if [[ ! -f "$LCOV_FILE" ]]; then
  echo "ERROR: No lcov file found at $LCOV_FILE" >&2
  echo "Run tests with E2E_COLLECT_COVERAGE=true first" >&2
  exit 1
fi

UPLOAD_SLUG="${CODECOV_UPLOAD_SLUG:-redhat-developer/rhdh-plugin-export-overlays}"

# Resolve the overlay commit to attribute the coverage to. Codecov requires a
# SHA that exists on GitHub:
#   - Prow presubmits check out a synthetic merge of the PR onto the base
#     branch, so `git rev-parse HEAD` would yield a commit GitHub doesn't know.
#     Use PULL_PULL_SHA (the PR head) instead.
#   - GitHub Actions exposes GITHUB_SHA.
#   - Periodics / local runs sit on a real pushed commit; HEAD is fine.
if [[ -n "${PULL_PULL_SHA:-}" ]]; then
  UPLOAD_SHA="$PULL_PULL_SHA"
elif [[ -n "${GITHUB_SHA:-}" ]]; then
  UPLOAD_SHA="$GITHUB_SHA"
else
  UPLOAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
fi

if [[ ! "$UPLOAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: Could not resolve a 40-char overlay commit SHA (got '$UPLOAD_SHA')" >&2
  exit 1
fi

PR_NUMBER="${PULL_NUMBER:-${GIT_PR_NUMBER:-}}"

echo "=== Uploading E2E coverage to Codecov ==="
echo "  Workspace:  $WORKSPACE"
echo "  LCOV file:  $LCOV_FILE"
echo "  Target repo: $UPLOAD_SLUG"
echo "  Target SHA:  $UPLOAD_SHA"
[[ -n "$PR_NUMBER" ]] && echo "  PR:          #$PR_NUMBER"
echo "  Flag:        e2e-$WORKSPACE"

if [[ -z "${CODECOV_TOKEN:-}" ]]; then
  echo ""
  echo "[WARN] CODECOV_TOKEN is not set — skipping Codecov upload"
  echo "[INFO] Coverage report is still available locally at: $LCOV_FILE"
  exit 0
fi

# Download Codecov CLI binary with SHA256 verification.
# Uses the standalone Go binary (not pip codecov-cli) for supply-chain safety.
CODECOV_VERSION="v11.2.8"
CODECOV_BIN="/tmp/codecov"
if [[ ! -x "$CODECOV_BIN" ]]; then
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$OS" in
    linux)  CODECOV_OS="linux" ;;
    darwin) CODECOV_OS="macos" ;;
    *)
      echo "ERROR: Unsupported OS: $OS" >&2
      exit 1
      ;;
  esac

  echo ""
  echo "Downloading Codecov CLI $CODECOV_VERSION for ${CODECOV_OS}..."
  curl -sL -o "$CODECOV_BIN" "https://cli.codecov.io/${CODECOV_VERSION}/${CODECOV_OS}/codecov"
  curl -sL -o "${CODECOV_BIN}.SHA256SUM" "https://cli.codecov.io/${CODECOV_VERSION}/${CODECOV_OS}/codecov.SHA256SUM"

  EXPECTED=$(awk "$AWK_FIRST_FIELD" "${CODECOV_BIN}.SHA256SUM")
  if command -v sha256sum &>/dev/null; then
    ACTUAL=$(sha256sum "$CODECOV_BIN" | awk "$AWK_FIRST_FIELD")
  else
    ACTUAL=$(shasum -a 256 "$CODECOV_BIN" | awk "$AWK_FIRST_FIELD")
  fi
  rm -f "${CODECOV_BIN}.SHA256SUM"

  if [[ "$EXPECTED" != "$ACTUAL" ]]; then
    echo "ERROR: Codecov CLI checksum verification failed" >&2
    echo "  Expected: $EXPECTED" >&2
    echo "  Actual:   $ACTUAL" >&2
    rm -f "$CODECOV_BIN"
    exit 1
  fi

  chmod +x "$CODECOV_BIN"
  echo "  Codecov CLI downloaded and verified"
fi

CODECOV_ARGS=(
  --file "$LCOV_FILE"
  --flag "e2e-$WORKSPACE"
  --sha "$UPLOAD_SHA"
  --slug "$UPLOAD_SLUG"
  --token "$CODECOV_TOKEN"
  --git-service github
  --name "overlay-e2e-$WORKSPACE"
  --disable-search
  --fail-on-error
)
[[ -n "$PR_NUMBER" ]] && CODECOV_ARGS+=(--pr "$PR_NUMBER")

echo ""
# Codecov upload failures are intentionally non-blocking (exit 0).
# Coverage is informational — CI jobs should not fail if Codecov is down or
# has transient errors. The lcov report is still available locally for review.
# This approach prioritizes CI stability while ensuring coverage visibility when
# Codecov is available.
if "$CODECOV_BIN" upload-process "${CODECOV_ARGS[@]}"; then
  echo ""
  echo "=== Upload complete ==="
  echo "  View coverage at: https://app.codecov.io/gh/$UPLOAD_SLUG/commit/$UPLOAD_SHA"
  echo "  Filter by flag: e2e-$WORKSPACE"
else
  echo ""
  echo "=================================================="
  echo "  ⚠️  Codecov upload failed"
  echo "=================================================="
  echo "  This is non-fatal — coverage data is still available locally"
  echo "  LCOV report: $LCOV_FILE"
  echo "  Target repo: $UPLOAD_SLUG"
  echo "  Target SHA:  $UPLOAD_SHA"
  echo "=================================================="
  # Exit 0 (success) — upload failure should not fail the CI job
  exit 0
fi
