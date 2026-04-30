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
#
# Optional environment:
#   COVERAGE_OUTPUT_DIR - Override coverage directory (default: coverage/istanbul)

set -euo pipefail

WORKSPACE="${1:?Usage: $0 <workspace-name>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$REPO_ROOT/workspaces/$WORKSPACE"
COVERAGE_DIR="${COVERAGE_OUTPUT_DIR:-$REPO_ROOT/coverage/istanbul}"
LCOV_FILE="$COVERAGE_DIR/lcov.info"

if [[ ! -f "$LCOV_FILE" ]]; then
  echo "ERROR: No lcov file found at $LCOV_FILE"
  echo "Run tests with E2E_COLLECT_COVERAGE=1 first"
  exit 1
fi

if [[ ! -f "$WORKSPACE_DIR/source.json" ]]; then
  echo "ERROR: source.json not found at $WORKSPACE_DIR/source.json"
  exit 1
fi

REPO_URL=$(python3 -c "import json; print(json.load(open('$WORKSPACE_DIR/source.json'))['repo'])")
REPO_REF=$(python3 -c "import json; print(json.load(open('$WORKSPACE_DIR/source.json'))['repo-ref'])")

# Extract GitHub slug from repo URL (e.g., "redhat-developer/rhdh-plugins")
SLUG=$(echo "$REPO_URL" | sed 's|https://github.com/||' | sed 's|\.git$||')

echo "=== Uploading E2E coverage to Codecov ==="
echo "  Workspace:  $WORKSPACE"
echo "  LCOV file:  $LCOV_FILE"
echo "  Target repo: $SLUG"
echo "  Target SHA:  $REPO_REF"
echo "  Flag:        e2e-overlays-$WORKSPACE"

# Check for codecov CLI
if ! command -v codecov &>/dev/null; then
  echo ""
  echo "Installing Codecov CLI..."
  pip install codecov-cli 2>/dev/null || {
    echo "ERROR: Could not install codecov-cli"
    echo "Install manually: pip install codecov-cli"
    exit 1
  }
fi

if [[ -z "${CODECOV_TOKEN:-}" ]]; then
  echo ""
  echo "ERROR: CODECOV_TOKEN is not set"
  echo "Set it to an org-level Codecov token that has upload access to $SLUG"
  exit 1
fi

echo ""
codecov upload-process \
  --file "$LCOV_FILE" \
  --flag "e2e-overlays-$WORKSPACE" \
  --sha "$REPO_REF" \
  --slug "$SLUG" \
  --token "$CODECOV_TOKEN" \
  --name "overlay-e2e-$WORKSPACE" \
  --disable-search

echo ""
echo "=== Upload complete ==="
echo "  View coverage at: https://app.codecov.io/gh/$SLUG/commit/$REPO_REF"
