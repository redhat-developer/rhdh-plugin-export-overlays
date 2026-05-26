#!/usr/bin/env bash
#
# Upload Istanbul/lcov coverage to Codecov with cross-repo attribution.
#
# Usage:
#   ./scripts/upload-coverage.sh <workspace-name>
#
# Example:
#   E2E_COLLECT_COVERAGE=1 ./run-e2e.sh -w tech-radar
#   ./scripts/upload-coverage.sh tech-radar
#
# The script reads source.json to determine the upstream repo and SHA,
# then uploads the lcov coverage to Codecov attributed to that repo.
#
# Required environment:
#   CODECOV_TOKEN  - Codecov upload token (org-level for cross-repo uploads)

set -euo pipefail

WORKSPACE="${1:?Usage: $0 <workspace-name>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$REPO_ROOT/workspaces/$WORKSPACE"
COVERAGE_DIR="$REPO_ROOT/coverage"
LCOV_FILE="$COVERAGE_DIR/lcov.info"

if [[ ! -f "$LCOV_FILE" ]]; then
  echo "ERROR: No lcov file found at $LCOV_FILE" >&2
  echo "Run tests with E2E_COLLECT_COVERAGE=1 first" >&2
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
if [[ ! "$REPO_REF" =~ ^[0-9a-f]{40}$ ]]; then
  RESOLVED=$(git ls-remote "$REPO_URL" "$REPO_REF" "${REPO_REF}^{}" 2>/dev/null | tail -1 | awk '{print $1}')
  if [[ -n "$RESOLVED" ]]; then
    echo "  Resolved ref '$REPO_REF' -> $RESOLVED"
    REPO_REF="$RESOLVED"
  else
    echo "ERROR: Could not resolve '$REPO_REF' to a commit SHA" >&2
    echo "Codecov requires a valid 40-char commit SHA" >&2
    exit 1
  fi
fi

# Extract GitHub slug from repo URL (e.g., "redhat-developer/rhdh-plugins")
SLUG=$(echo "$REPO_URL" | sed 's|https://github.com/||; s|\.git$||')

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
  echo "Downloading Codecov CLI for ${CODECOV_OS}..."
  curl -sL -o "$CODECOV_BIN" "https://cli.codecov.io/latest/${CODECOV_OS}/codecov"
  curl -sL -o "${CODECOV_BIN}.SHA256SUM" "https://cli.codecov.io/latest/${CODECOV_OS}/codecov.SHA256SUM"

  EXPECTED=$(awk '{print $1}' "${CODECOV_BIN}.SHA256SUM")
  if command -v sha256sum &>/dev/null; then
    ACTUAL=$(sha256sum "$CODECOV_BIN" | awk '{print $1}')
  else
    ACTUAL=$(shasum -a 256 "$CODECOV_BIN" | awk '{print $1}')
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
"$CODECOV_BIN" upload-process \
  --file "$LCOV_FILE" \
  --flag "e2e-$WORKSPACE" \
  --sha "$REPO_REF" \
  --slug "$SLUG" \
  --token "$CODECOV_TOKEN" \
  --git-service github \
  --name "overlay-e2e-$WORKSPACE" \
  --disable-search \
  --fail-on-error || {
    echo "[WARN] Codecov upload failed (non-fatal)"
    exit 0
  }

echo ""
echo "=== Upload complete ==="
echo "  View coverage at: https://app.codecov.io/gh/$SLUG/commit/$REPO_REF"
echo "  Filter by flag: e2e-$WORKSPACE"
