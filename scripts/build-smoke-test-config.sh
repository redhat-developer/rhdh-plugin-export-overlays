#!/usr/bin/env bash
#
# Build dynamic-plugins.test.yaml for workspace smoke tests.
#
# Resolves published exports, parses workspace metadata YAML files,
# validates environment variables against smoke-tests/test.env, and generates
# $WORKSPACE_PATH/smoke-tests/dynamic-plugins.test.yaml.
#
# Usage:
#   scripts/build-smoke-test-config.sh [workspace-path] [published-exports]
#
# Environment variables:
#   WORKSPACE_PATH            Path to workspace (e.g. workspaces/todo)
#   PUBLISHED_EXPORTS         Space-separated list of published image references
#   INPUT_PUBLISHED_EXPORTS   Alternative env var for published exports
#   GITHUB_WORKSPACE          Optional repo root (defaults to script's repo root)
#   GITHUB_OUTPUT             GitHub Actions output file
#
# Outputs (to $GITHUB_OUTPUT if set):
#   has-runnable-plugins      "true" or "false"
#   skip-tests-missing-env    "true" or "false"
#   missing-metadata-plugins  newline-separated list of plugin names
#

set -euo pipefail

YQ="yq"
if [[ -x "/usr/bin/yq" ]] && /usr/bin/yq --version 2>&1 | grep -q "mikefarah"; then
  YQ="/usr/bin/yq"
fi

WORKSPACE_PATH="${1:-${WORKSPACE_PATH:-}}"
if [[ -z "$WORKSPACE_PATH" ]]; then
  echo "Error: WORKSPACE_PATH is required (via argument or env var)" >&2
  exit 1
fi

PUBLISHED_EXPORTS="${2:-${PUBLISHED_EXPORTS:-${INPUT_PUBLISHED_EXPORTS:-}}}"

PLUGINS_FOUND=0
PLUGINS_SKIPPED_MISSING_METADATA=0
PLUGINS_SKIPPED_MISSING_ENV=0
TEST_PLUGINS_SKIPPED=0
TOTAL_PLUGINS=0
HAS_RUNNABLE_PLUGINS="false"
SKIP_TESTS_MISSING_ENV="false"
MISSING_METADATA_PLUGINS=()

emit_outputs() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "has-runnable-plugins=$HAS_RUNNABLE_PLUGINS" >> "$GITHUB_OUTPUT"
    echo "skip-tests-missing-env=$SKIP_TESTS_MISSING_ENV" >> "$GITHUB_OUTPUT"
    echo "missing-metadata-plugins<<EOF" >> "$GITHUB_OUTPUT"
    if [[ ${#MISSING_METADATA_PLUGINS[@]} -gt 0 ]]; then
      printf "%s\n" "${MISSING_METADATA_PLUGINS[@]}" >> "$GITHUB_OUTPUT"
    fi
    echo "EOF" >> "$GITHUB_OUTPUT"
  fi
}

if [[ -z "$PUBLISHED_EXPORTS" ]]; then
  EXPORTS_FILE=""
  if [[ -f "./published-exports/published-exports.txt" ]]; then
    EXPORTS_FILE="./published-exports/published-exports.txt"
  elif [[ -f "./published-exports/published-exports/published-exports.txt" ]]; then
    EXPORTS_FILE="./published-exports/published-exports/published-exports.txt"
  elif [[ -f "./published-exports.txt" ]]; then
    EXPORTS_FILE="./published-exports.txt"
  fi
  if [[ -n "$EXPORTS_FILE" && -f "$EXPORTS_FILE" ]]; then
    PUBLISHED_EXPORTS=$(cat "$EXPORTS_FILE")
  fi
fi

if [[ -z "$PUBLISHED_EXPORTS" ]]; then
  echo "No published exports provided."
  emit_outputs
  exit 0
fi

TOTAL_PLUGINS=$(echo "$PUBLISHED_EXPORTS" | wc -w)

OUT_DIR="$WORKSPACE_PATH/smoke-tests"
OUT_FILE="$OUT_DIR/dynamic-plugins.test.yaml"
mkdir -p "$OUT_DIR"

# Build map of <stripped packageName> -> metadata file path
declare -A META_MAP
for file in "$WORKSPACE_PATH"/metadata/*.yaml; do
  [[ -e "$file" ]] || continue
  pkg=$("$YQ" -r '.spec.packageName // ""' "$file")
  if [[ -n "$pkg" && "$pkg" != "null" ]]; then
    stripped=$(echo "$pkg" | sed 's|^@||; s|/|-|')
    META_MAP["$stripped"]="$file"
  fi
done

# Always include the root-level default config
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_CONFIG="${GITHUB_WORKSPACE:-$REPO_ROOT}/smoke-tests/app-config.yaml"
[[ -f "$ROOT_CONFIG" ]] && cp "$ROOT_CONFIG" "$OUT_DIR/app-config.yaml"

# Read workspace-wide test.env if it exists
WORKSPACE_ENV_FILE="$WORKSPACE_PATH/smoke-tests/test.env"
WORKSPACE_ENV_CONTENT=""
if [[ -f "$WORKSPACE_ENV_FILE" ]]; then
  echo "Found workspace test.env file: $WORKSPACE_ENV_FILE"
  WORKSPACE_ENV_CONTENT=$(cat "$WORKSPACE_ENV_FILE")
else
  echo "No workspace test.env file found at: $WORKSPACE_ENV_FILE"
fi

# Start the resulting YAML file
echo "plugins:" > "$OUT_FILE"

# For each published export, extract plugin name and read its metadata
# Expected export format: ghcr.io/<repo_path>/<plugin_name>:<tag>
for export in $PUBLISHED_EXPORTS; do
  if [[ "$export" =~ ^ghcr\.io/(.+):([^[:space:]]+)$ ]]; then
    IMAGE_PATH_AND_PLUGIN="${BASH_REMATCH[1]}"   # <repo_path>/<plugin_name>
    NEW_TAG="${BASH_REMATCH[2]}"                 # <tag>
    PLUGIN_NAME="${IMAGE_PATH_AND_PLUGIN##*/}"
    METADATA_FILE="${META_MAP[$PLUGIN_NAME]:-}"
    if [[ -z "$METADATA_FILE" ]]; then
      # if the name of the plugin ends with -test, it is a test plugin without metadata:
      # skip it without cancelling the test workflow
      if [[ "$PLUGIN_NAME" =~ -test$ ]]; then
        echo "Plugin $PLUGIN_NAME is a test plugin without metadata, skipping this individual plugin test"
        TEST_PLUGINS_SKIPPED=$((TEST_PLUGINS_SKIPPED + 1))
      else
        echo "Metadata mapping not found for $PLUGIN_NAME: skipping this plugin"
        PLUGINS_SKIPPED_MISSING_METADATA=$((PLUGINS_SKIPPED_MISSING_METADATA + 1))
        MISSING_METADATA_PLUGINS+=("$PLUGIN_NAME")
      fi
      continue
    fi

    PACKAGE_NAME=$("$YQ" -r '.spec.packageName' "$METADATA_FILE")
    if [[ -z "$PACKAGE_NAME" || "$PACKAGE_NAME" == "null" ]]; then
      echo "spec.packageName not found in $METADATA_FILE, skipping"
      PLUGINS_SKIPPED_MISSING_METADATA=$((PLUGINS_SKIPPED_MISSING_METADATA + 1))
      MISSING_METADATA_PLUGINS+=("$PLUGIN_NAME")
      continue
    fi

    # npm-style package name with scope/path → image-style id (matches OCI image basename)
    STRIPPED=$(echo "$PACKAGE_NAME" | sed 's|^@||; s|/|-|')
    # Published export tags may still include a legacy `!<stripped package id>` suffix; drop it when present
    OCI_TAG="${NEW_TAG%"!${STRIPPED}"}"

    # First appConfigExamples item is used for testing
    CONFIG_CONTENT=$("$YQ" -o=yaml '.spec.appConfigExamples[0].content' "$METADATA_FILE" 2>/dev/null || echo "")
    if [[ -z "$CONFIG_CONTENT" || "$CONFIG_CONTENT" == "null" ]]; then
      echo "spec.appConfigExamples[0].content not found in $METADATA_FILE: assuming empty config"
      CONFIG_CONTENT=""
    fi

    ENV_VARS=$(echo "$CONFIG_CONTENT" | "$YQ" -o=yaml '.dynamicPlugins' 2>/dev/null | grep -oE '\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*' | sed 's/\${//; s/}//; s/^\$//' | sort -u || true)

    if [[ -n "$ENV_VARS" ]]; then
      # Config contains environment variables
      if [[ -z "$WORKSPACE_ENV_CONTENT" ]]; then
        echo "::warning::Config for $PLUGIN_NAME contains environment variables but workspace test.env is missing. Tests will be skipped."
        SKIP_TESTS_MISSING_ENV="true"
        PLUGINS_SKIPPED_MISSING_ENV=$((PLUGINS_SKIPPED_MISSING_ENV + 1))
        continue
      else
        # Validate all ENVs are present in workspace test.env
        MISSING_ENVS=()
        while IFS= read -r env_var; do
          [[ -z "$env_var" ]] && continue
          if ! echo "$WORKSPACE_ENV_CONTENT" | grep -qE "^[[:space:]]*${env_var}[[:space:]]*="; then
            MISSING_ENVS+=("$env_var")
          fi
        done <<< "$ENV_VARS"

        if [[ ${#MISSING_ENVS[@]} -gt 0 ]]; then
          echo "::error::Environment variables missing from test.env: ${MISSING_ENVS[*]}" >&2
          echo "Config for $PLUGIN_NAME references these environment variables but they are not defined in $WORKSPACE_ENV_FILE." >&2
          exit 1
        fi
      fi
    fi
    # If no ENVs in config, continue regardless of env file existence

    echo "- package: \"oci://ghcr.io/${IMAGE_PATH_AND_PLUGIN}:${OCI_TAG}\"" >> "$OUT_FILE"
    echo "  enabled: true" >> "$OUT_FILE"
    if [[ -n "$CONFIG_CONTENT" ]]; then
      echo "  pluginConfig:" >> "$OUT_FILE"
      echo "$CONFIG_CONTENT" | sed 's/^/    /' >> "$OUT_FILE"
    fi
    PLUGINS_FOUND=$((PLUGINS_FOUND + 1))
  else
    echo "Export did not match expected format, skipping: $export"
  fi
done

if [[ "$PLUGINS_FOUND" -eq 0 ]]; then
  echo "plugins: []" > "$OUT_FILE"
else
  HAS_RUNNABLE_PLUGINS="true"
fi

echo "Plugins: $PLUGINS_FOUND/$TOTAL_PLUGINS processed successfully"
[[ "${PLUGINS_SKIPPED_MISSING_METADATA:-0}" -gt 0 ]] && echo "Skipped $PLUGINS_SKIPPED_MISSING_METADATA (missing runnable metadata)"
[[ "${PLUGINS_SKIPPED_MISSING_ENV:-0}" -gt 0 ]] && echo "Skipped $PLUGINS_SKIPPED_MISSING_ENV (missing test.env)"
[[ "${TEST_PLUGINS_SKIPPED:-0}" -gt 0 ]] && echo "Skipped $TEST_PLUGINS_SKIPPED test plugin(s) without metadata"
if [[ "${PLUGINS_SKIPPED_MISSING_METADATA:-0}" -gt 0 ]]; then
  echo "Some published plugins were skipped because they do not have runnable metadata."
fi

emit_outputs
