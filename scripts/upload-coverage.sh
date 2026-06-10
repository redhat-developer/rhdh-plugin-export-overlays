#!/usr/bin/env bash
#
# Upload Istanbul/lcov coverage to Codecov with cross-repo attribution.
#
# Usage:
#   ./scripts/upload-coverage.sh <workspace-name>
#
# Example:
#   E2E_COLLECT_COVERAGE=true ./run-e2e.sh -w tech-radar
#   ./scripts/upload-coverage.sh tech-radar
#
# The script reads source.json to determine the upstream repo and SHA, and only
# uploads when that repo is the Codecov project we own (CODECOV_UPLOAD_SLUG,
# default redhat-developer/rhdh-plugins). Plugins sourced from other orgs are
# skipped — see the gate below for why.
#
# Required environment:
#   CODECOV_TOKEN       - Codecov upload token for the owned project.
#                         Falls back to VAULT_CODECOV_TOKEN (see below).
# Optional environment:
#   CODECOV_UPLOAD_SLUG - GitHub slug of the owned Codecov project to upload to.
#                         Default: redhat-developer/rhdh-plugins.

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
WORKSPACE_DIR="$REPO_ROOT/workspaces/$WORKSPACE"
COVERAGE_DIR="$REPO_ROOT/coverage"
LCOV_FILE="$COVERAGE_DIR/lcov.info"

if [[ ! -f "$LCOV_FILE" ]]; then
  echo "ERROR: No lcov file found at $LCOV_FILE" >&2
  echo "Run tests with E2E_COLLECT_COVERAGE=true first" >&2
  exit 1
fi

if [[ ! -f "$WORKSPACE_DIR/source.json" ]]; then
  echo "ERROR: source.json not found at $WORKSPACE_DIR/source.json" >&2
  exit 1
fi

REPO_URL=$(jq -r '.repo // empty' "$WORKSPACE_DIR/source.json")
REPO_REF=$(jq -r '.["repo-ref"] // empty' "$WORKSPACE_DIR/source.json")

if [[ -z "$REPO_URL" || "$REPO_URL" == "null" ]]; then
  echo "ERROR: Invalid or missing 'repo' field in source.json" >&2
  exit 1
fi

if [[ -z "$REPO_REF" || "$REPO_REF" == "null" ]]; then
  echo "ERROR: Invalid or missing 'repo-ref' field in source.json" >&2
  exit 1
fi

# Codecov --sha requires a 40-char commit SHA. source.json repo-ref can be a
# tag name (e.g., "v1.49.4") — resolve it to a commit SHA via git ls-remote.
# For annotated tags, ls-remote returns the tag object and the dereferenced
# commit (^{}); tail -1 picks the commit in both cases.
#
# OPTIMIZATION OPPORTUNITY: This network call could be eliminated by storing
# full 40-char SHAs in source.json (updated by update-plugins-repo-refs.yaml).
# For now, we resolve at upload time and cache the result in /tmp.
if [[ ! "$REPO_REF" =~ ^[0-9a-f]{40}$ ]]; then
  CACHE_FILE="/tmp/codecov-sha-${WORKSPACE}.cache"
  if [[ -f "$CACHE_FILE" ]]; then
    RESOLVED=$(cat "$CACHE_FILE")
    echo "  Using cached SHA for '$REPO_REF': $RESOLVED"
  else
    RESOLVED=$(git ls-remote "$REPO_URL" "$REPO_REF" "${REPO_REF}^{}" 2>/dev/null | tail -1 | awk "$AWK_FIRST_FIELD")
    if [[ -n "$RESOLVED" ]]; then
      echo "  Resolved ref '$REPO_REF' -> $RESOLVED"
      echo "$RESOLVED" > "$CACHE_FILE"
    else
      echo "ERROR: Could not resolve '$REPO_REF' to a commit SHA" >&2
      echo "Codecov requires a valid 40-char commit SHA" >&2
      exit 1
    fi
  fi
  REPO_REF="$RESOLVED"
fi

# Extract GitHub slug from repo URL (e.g., "redhat-developer/rhdh-plugins")
SLUG=$(echo "$REPO_URL" | sed 's|https://github.com/||; s|\.git$||')

# Only upload coverage for plugins whose source repo we can attribute it to.
# Codecov anchors every report to a repo + commit + file tree, so the metric is
# only accurate when uploaded to the repo where those source files and commits
# actually live. We own the Codecov project for redhat-developer/rhdh-plugins;
# plugins sourced from other orgs (e.g. backstage/community-plugins) can't be
# reported accurately without that org's token, so skip them for now. Override
# the owned slug with CODECOV_UPLOAD_SLUG if the target project ever changes.
UPLOAD_SLUG="${CODECOV_UPLOAD_SLUG:-redhat-developer/rhdh-plugins}"
if [[ "$SLUG" != "$UPLOAD_SLUG" ]]; then
  echo "[INFO] Skipping Codecov upload for '$WORKSPACE': source repo '$SLUG' is not the owned project '$UPLOAD_SLUG'."
  echo "[INFO] Cross-org coverage attribution isn't supported; lcov is available locally at $LCOV_FILE."
  exit 0
fi

echo "=== Uploading E2E coverage to Codecov ==="
echo "  Workspace:  $WORKSPACE"
echo "  LCOV file:  $LCOV_FILE"
echo "  Target repo: $SLUG"
echo "  Target SHA:  $REPO_REF"
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

echo ""
# Codecov upload failures are intentionally non-blocking (exit 0).
# Coverage is informational — CI jobs should not fail if Codecov is down or
# has transient errors. The lcov report is still available locally for review.
# This approach prioritizes CI stability while ensuring coverage visibility when
# Codecov is available.
if "$CODECOV_BIN" upload-process \
  --file "$LCOV_FILE" \
  --flag "e2e-$WORKSPACE" \
  --sha "$REPO_REF" \
  --slug "$SLUG" \
  --token "$CODECOV_TOKEN" \
  --git-service github \
  --name "overlay-e2e-$WORKSPACE" \
  --disable-search \
  --fail-on-error; then
  echo ""
  echo "=== Upload complete ==="
  echo "  View coverage at: https://app.codecov.io/gh/$SLUG/commit/$REPO_REF"
  echo "  Filter by flag: e2e-$WORKSPACE"
else
  echo ""
  echo "=================================================="
  echo "  ⚠️  Codecov upload failed"
  echo "=================================================="
  echo "  This is non-fatal — coverage data is still available locally"
  echo "  LCOV report: $LCOV_FILE"
  echo "  Target repo: $SLUG"
  echo "  Target SHA:  $REPO_REF"
  echo "=================================================="
  # Exit 0 (success) — upload failure should not fail the CI job
  exit 0
fi
