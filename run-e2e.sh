#!/bin/bash
set -euo pipefail

# =============================================================================
# E2E Test Runner for rhdh-plugin-export-overlays
#
# Runs workspace E2E tests in parallel using Playwright workers.
# Uses yarn workspaces for dependency management (single root node_modules).
#
# Usage:
#   ./run-e2e.sh                              # Run all workspace tests
#   ./run-e2e.sh --list                        # List discovered projects (dry run)
#   ./run-e2e.sh --workers=4                   # Control parallelism
#   ./run-e2e.sh --project=acr                 # Run specific project
#   ./run-e2e.sh --grep="Quick"                # Filter tests by name
#   ./run-e2e.sh -w tech-radar                 # Run only tech-radar workspace
#   ./run-e2e.sh -w backstage -w quickstart    # Run multiple specific workspaces
#   ./run-e2e.sh -w tech-radar --list          # List projects in a workspace
#   ./run-e2e.sh -w backstage --workers=2      # Combine workspace filter with Playwright args
#
#   # Auto-fetch secrets from HashiCorp Vault during global setup
#   VAULT=1 ./run-e2e.sh -w tech-radar
#
#   # Use a local build of e2e-test-utils (for testing unpublished changes)
#   E2E_TEST_UTILS_PATH=/path/to/rhdh-e2e-test-utils ./run-e2e.sh -w tech-radar
#
#   # Pin a specific npm version of e2e-test-utils (default: "latest" for nightly)
#   E2E_TEST_UTILS_VERSION=1.1.24 ./run-e2e.sh -w tech-radar
#
#   # Use an unpublished git branch of e2e-test-utils (clones and builds locally)
#   E2E_TEST_UTILS_GIT_REF=owner/rhdh-e2e-test-utils#my-branch ./run-e2e.sh -w tech-radar
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Configuration ─────────────────────────────────────────────────────────────
# These use defaults that can be overridden via environment variables.

# RHDH deployment
# export RHDH_VERSION="${RHDH_VERSION:-1.10}"             # RHDH version to deploy (e.g., "1.10", "next")
export RHDH_VERSION="1.10-114-CI"                       # Pinned due to RHDHBUGS-3030
export INSTALLATION_METHOD="${INSTALLATION_METHOD:-helm}" # "helm" or "operator"

# Playwright
export CI="${CI:-true}"                                  # Enables CI mode (forbidOnly, teardown)
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.59.1}"       # @playwright/test version to pin

# Keycloak
export SKIP_KEYCLOAK_DEPLOYMENT="${SKIP_KEYCLOAK_DEPLOYMENT:-}" # Set "true" to skip Keycloak deploy

# Plugin metadata (set for nightly/periodic to skip metadata injection)
export JOB_NAME="${JOB_NAME:-}"                          # If contains "periodic-", skips metadata injection
export GIT_PR_NUMBER="${GIT_PR_NUMBER:-}"                 # PR number for OCI URL generation

# Catalog index image — only set if you need to override the default baked into the RHDH chart
export CATALOG_INDEX_IMAGE="${CATALOG_INDEX_IMAGE:-}"

# Nightly mode
E2E_NIGHTLY_MODE="${E2E_NIGHTLY_MODE:-false}"

# Local e2e-test-utils: absolute path to use a local build instead of npm
E2E_TEST_UTILS_PATH="${E2E_TEST_UTILS_PATH:-}"
# Pin specific e2e-test-utils version.
E2E_TEST_UTILS_VERSION="${E2E_TEST_UTILS_VERSION:-}"
# Git ref for e2e-test-utils: "owner/repo#branch" — clones and sets E2E_TEST_UTILS_PATH
E2E_TEST_UTILS_GIT_REF="${E2E_TEST_UTILS_GIT_REF:-}"

if [[ -n "$E2E_TEST_UTILS_GIT_REF" ]]; then
    CLONE_DIR="/tmp/rhdh-e2e-test-utils-${E2E_TEST_UTILS_GIT_REF##*#}"
    rm -rf "$CLONE_DIR"
    git clone --depth 1 --branch "${E2E_TEST_UTILS_GIT_REF#*#}" \
        "https://github.com/${E2E_TEST_UTILS_GIT_REF%%#*}.git" "$CLONE_DIR"
    E2E_TEST_UTILS_PATH="$CLONE_DIR"
fi

# ── Parse arguments ───────────────────────────────────────────────────────────

SELECTED_WORKSPACES=()
PLAYWRIGHT_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        -w|--workspace)
            SELECTED_WORKSPACES+=("$2")
            shift 2
            ;;
        -w=*|--workspace=*)
            SELECTED_WORKSPACES+=("${1#*=}")
            shift
            ;;
        *)
            PLAYWRIGHT_ARGS+=("$1")
            shift
            ;;
    esac
done

# Auto-skip tests tagged @skip-<job-suffix> based on JOB_NAME.
# (?!-) ensures exact match — @skip-ocp-helm won't match @skip-ocp-helm-nightly.
if [[ -n "$JOB_NAME" ]]; then
    JOB_SUFFIX=$(echo "$JOB_NAME" | sed -n 's/.*-e2e-//p')
    if [[ -n "$JOB_SUFFIX" ]]; then
        E2E_SKIP_TAG="@skip-${JOB_SUFFIX}(?!-)"
        PLAYWRIGHT_ARGS=("--grep-invert" "$E2E_SKIP_TAG" "${PLAYWRIGHT_ARGS[@]}")
        echo "[INFO] Skip tag: $E2E_SKIP_TAG (derived from JOB_NAME)"
    fi
fi

GENERATED_FILES=()

# ── Prerequisites ─────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════════════════"
echo "  RHDH Plugin Export Overlays — E2E Test Runner"
echo "═══════════════════════════════════════════════════════════════════"

for bin in node yarn jq; do
    command -v "$bin" &>/dev/null || { echo "[ERROR] Missing: $bin"; exit 1; }
done

corepack enable 2>/dev/null || true
echo "[INFO] Node $(node --version) | Yarn $(yarn --version)"

if command -v oc &>/dev/null && oc whoami &>/dev/null 2>&1; then
    echo "[INFO] Cluster: $(oc whoami --show-server) ($(oc whoami))"
elif [[ "${PLAYWRIGHT_ARGS[0]:-}" != "--list" ]]; then
    echo "[ERROR] Not logged into a cluster. Login with 'oc login' first."
    exit 1
fi

# ── Discover workspaces ───────────────────────────────────────────────────────

ALL_WORKSPACES=()
for dir in workspaces/*/e2e-tests; do
    [[ -f "$dir/package.json" && -f "$dir/playwright.config.ts" ]] && \
        ALL_WORKSPACES+=("$(echo "$dir" | cut -d'/' -f2)")
done

if [[ ${#ALL_WORKSPACES[@]} -eq 0 ]]; then
    echo "[ERROR] No workspaces with E2E tests found."
    exit 1
fi

# Apply workspace filter if -w flags were provided
if [[ ${#SELECTED_WORKSPACES[@]} -gt 0 ]]; then
    E2E_WORKSPACES=()
    for ws in "${SELECTED_WORKSPACES[@]}"; do
        if printf '%s\n' "${ALL_WORKSPACES[@]}" | grep -qx "$ws"; then
            E2E_WORKSPACES+=("$ws")
        else
            echo "[ERROR] Workspace '$ws' not found or has no E2E tests."
            echo "[INFO] Available: ${ALL_WORKSPACES[*]}"
            exit 1
        fi
    done
    echo "[INFO] Workspaces (filtered): ${E2E_WORKSPACES[*]}"
else
    E2E_WORKSPACES=("${ALL_WORKSPACES[@]}")
    echo "[INFO] Workspaces (all): ${E2E_WORKSPACES[*]}"
fi

# ── Install dependencies (yarn workspaces) ────────────────────────────────────


WORKSPACE_PATHS=$(printf ', "workspaces/%s/e2e-tests"' "${E2E_WORKSPACES[@]}")
WORKSPACE_PATHS="[${WORKSPACE_PATHS:2}]"

RESOLUTIONS="\"@playwright/test\": \"${PLAYWRIGHT_VERSION}\""
if [[ -n "$E2E_TEST_UTILS_PATH" ]]; then
    echo "[INFO] Using local e2e-test-utils: $E2E_TEST_UTILS_PATH"
    echo "[INFO] Building local e2e-test-utils..."
    (cd "$E2E_TEST_UTILS_PATH" && yarn install --immutable && yarn build)
    RESOLUTIONS+=", \"@red-hat-developer-hub/e2e-test-utils\": \"file:${E2E_TEST_UTILS_PATH}\""
elif [[ -n "$E2E_TEST_UTILS_VERSION" ]]; then
    echo "[INFO] Pinning e2e-test-utils to version: $E2E_TEST_UTILS_VERSION"
    RESOLUTIONS+=", \"@red-hat-developer-hub/e2e-test-utils\": \"${E2E_TEST_UTILS_VERSION}\""
fi

cat > package.json <<EOF
{
  "name": "overlay-e2e-nightly",
  "private": true,
  "type": "module",
  "packageManager": "yarn@4.12.0",
  "workspaces": ${WORKSPACE_PATHS},
  "resolutions": { ${RESOLUTIONS} }
}
EOF

cat > .yarnrc.yml <<< 'nodeLinker: node-modules'
GENERATED_FILES+=("package.json" ".yarnrc.yml")

# Clean all node_modules and yarn.lock to ensure fresh resolution
# (prevents stale cached resolutions when switching between npm and local file: builds)
rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/yarn.lock" 2>/dev/null
for ws in "${E2E_WORKSPACES[@]}"; do
    rm -rf "$SCRIPT_DIR/workspaces/$ws/e2e-tests/node_modules" 2>/dev/null
done

echo "[INFO] Installing dependencies (@playwright/test pinned to $PLAYWRIGHT_VERSION)..."
YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install

# ── Generate root playwright.config.ts ────────────────────────────────────────
# Extracts project definitions directly from workspace configs via sed instead of
# importing them. Importing executes top-level code (e.g., process.env mutations)
# which can pollute the environment for other workspaces.

PROJECT_ENTRIES=""
for ws in "${E2E_WORKSPACES[@]}"; do
    WS_DIR="workspaces/${ws}/e2e-tests"
    WS_CONFIG="${WS_DIR}/playwright.config.ts"

    # Extract content between "projects: [" and "]," (the project objects)
    PROJECTS_BLOCK=$(sed -n '/projects: \[/,/^\s*\],/{ /projects: \[/d; /^\s*\],/d; p; }' "$WS_CONFIG")

    if [[ -z "$PROJECTS_BLOCK" ]]; then
        echo "[WARN] No projects found in $WS_CONFIG, skipping"
        continue
    fi

    # Inject testDir into each project's opening brace using depth tracking.
    # Depth 0 = project-level brace, depth 1+ = nested objects (metadata, use, etc.)
    DEPTH=0
    while IFS= read -r line; do
        opens=$(echo "$line" | tr -cd '{' | wc -c | tr -d ' ')
        closes=$(echo "$line" | tr -cd '}' | wc -c | tr -d ' ')

        if [[ $DEPTH -eq 0 && $opens -gt 0 ]]; then
            PROJECT_ENTRIES+="    { testDir: path.resolve('${WS_DIR}', 'tests'),"$'\n'
        else
            PROJECT_ENTRIES+="$line"$'\n'
        fi

        DEPTH=$((DEPTH + opens - closes))
    done <<< "$PROJECTS_BLOCK"
done

cat > playwright.config.ts <<CONFIGEOF
// Auto-generated by run-e2e.sh
import { baseConfig } from '@red-hat-developer-hub/e2e-test-utils/playwright-config';
import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  ...baseConfig,
  projects: [
${PROJECT_ENTRIES}  ],
});
CONFIGEOF

GENERATED_FILES+=("playwright.config.ts")
echo "[INFO] Generated playwright.config.ts (${#E2E_WORKSPACES[@]} workspaces)"

# ── List mode ─────────────────────────────────────────────────────────────────
# Skip globalSetup and teardown reporter — just list test names.

if [[ "${PLAYWRIGHT_ARGS[0]:-}" == "--list" ]]; then
    # Generate a lightweight config that skips setup/teardown
    sed 's/\.\.\.baseConfig,/...baseConfig, globalSetup: undefined, globalTeardown: undefined, reporter: [["list"]],/' \
        playwright.config.ts > playwright.list.config.ts
    GENERATED_FILES+=("playwright.list.config.ts")

    echo ""
    echo "Listing tests:"
    npx playwright test --list --config playwright.list.config.ts \
        "${PLAYWRIGHT_ARGS[@]:1}" 2>&1 || true
    exit 0
fi

# ── Install browser ───────────────────────────────────────────────────────────

npx playwright install chromium

# ── Run tests ─────────────────────────────────────────────────────────────────

echo ""
TEST_EXIT_CODE=0
npx playwright test "${PLAYWRIGHT_ARGS[@]+"${PLAYWRIGHT_ARGS[@]}"}" || TEST_EXIT_CODE=$?

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════"
if [[ -f "playwright-report/results.json" ]]; then
    jq -r '"  Duration: \((.stats.duration // 0) / 1000 | floor | "\(. / 60 | floor)m \(. % 60)s")
  Passed:   \(.stats.expected // 0)
  Failed:   \(.stats.unexpected // 0)
  Flaky:    \(.stats.flaky // 0)
  Skipped:  \(.stats.skipped // 0)"' playwright-report/results.json 2>/dev/null
fi
echo "  Status:   $([ $TEST_EXIT_CODE -eq 0 ] && echo 'PASSED' || echo "FAILED ($TEST_EXIT_CODE)")"
echo "  Report:   playwright-report/index.html"
echo "═══════════════════════════════════════════════════════════════════"

exit $TEST_EXIT_CODE
