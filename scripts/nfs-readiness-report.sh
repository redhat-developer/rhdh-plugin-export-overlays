#!/usr/bin/env bash
# NFS Readiness Report Generator
#
# Scans all workspace metadata to classify frontend plugins by their
# backstage.features content, aligned with the nfsModuleFilter logic
# in RHDH (NFS_FEATURE_TYPES: @backstage/FrontendPlugin, @backstage/FrontendModule).
#
# Classification:
#   nfs-ready    — All entry points have NFS feature types
#   mixed        — Some NFS entry points, some legacy/unrecognized
#   legacy-only  — Entry points present but none are NFS types
#   unknown      — backstage.features field absent or empty
#   backend-only — Plugin role is backend-plugin (not applicable)
#
# Usage:
#   ./scripts/nfs-readiness-report.sh [--json] [--markdown] [--oci]
#
# Options:
#   --json       Output raw JSON classification (default if no format specified)
#   --markdown   Output markdown report
#   --oci        Pull OCI artifacts to check backstage.features (slow, requires oras)
#                Without --oci, classifies from metadata role only (backend-only vs unknown)
#
# Environment:
#   REPO_ROOT    Override the repository root (default: script's parent directory)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

OUTPUT_JSON=false
OUTPUT_MARKDOWN=false
USE_OCI=false

for arg in "$@"; do
  case "$arg" in
    --json) OUTPUT_JSON=true ;;
    --markdown) OUTPUT_MARKDOWN=true ;;
    --oci) USE_OCI=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# Default to JSON if no format specified
if [[ "$OUTPUT_JSON" == "false" && "$OUTPUT_MARKDOWN" == "false" ]]; then
  OUTPUT_JSON=true
fi

# NFS feature types (must match nfsModuleFilter.ts)
NFS_FEATURE_TYPES=("@backstage/FrontendPlugin" "@backstage/FrontendModule")

is_nfs_type() {
  local type="$1"
  for nfs_type in "${NFS_FEATURE_TYPES[@]}"; do
    if [[ "$type" == "$nfs_type" ]]; then
      return 0
    fi
  done
  return 1
}

# Read support tier files
declare -A SUPPORT_TIER
while IFS= read -r line; do
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  SUPPORT_TIER["$line"]="supported"
done < "$REPO_ROOT/rhdh-supported-packages.txt"

while IFS= read -r line; do
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  SUPPORT_TIER["$line"]="community"
done < "$REPO_ROOT/rhdh-community-packages.txt"

get_support_tier() {
  local workspace="$1"
  local plugin_path="$2"
  # Try exact match first: workspace/plugins/plugin-folder
  local key="${workspace}/plugins/${plugin_path}"
  if [[ -n "${SUPPORT_TIER[$key]:-}" ]]; then
    echo "${SUPPORT_TIER[$key]}"
    return
  fi
  # Try matching by scanning all keys for this workspace
  for k in "${!SUPPORT_TIER[@]}"; do
    if [[ "$k" == "${workspace}/"* ]]; then
      # At least one plugin in this workspace is tracked
      echo "${SUPPORT_TIER[$k]}"
      return
    fi
  done
  echo "other"
}

get_plugin_folder() {
  local package_name="$1"
  # Extract the plugin folder name from the package name
  # e.g. @backstage-community/plugin-tech-radar -> tech-radar (strip scope + plugin- prefix)
  echo "$package_name" | sed 's|^@[^/]*/||; s|^plugin-||; s|^backstage-plugin-||'
}

classify_features() {
  local features_json="$1"

  if [[ -z "$features_json" || "$features_json" == "null" || "$features_json" == "{}" ]]; then
    echo "no-features"
    return
  fi

  local total=0
  local nfs_count=0

  while IFS= read -r feature_type; do
    total=$((total + 1))
    if is_nfs_type "$feature_type"; then
      nfs_count=$((nfs_count + 1))
    fi
  done < <(echo "$features_json" | jq -r 'values[]')

  if [[ $total -eq 0 ]]; then
    echo "no-features"
  elif [[ $nfs_count -eq $total ]]; then
    echo "nfs-ready"
  elif [[ $nfs_count -gt 0 ]]; then
    echo "mixed"
  else
    echo "legacy-only"
  fi
}

# Collect all plugins from metadata
RESULTS="[]"
WORKDIR=""

if [[ "$USE_OCI" == "true" ]]; then
  WORKDIR=$(mktemp -d)
  trap "rm -rf $WORKDIR" EXIT
fi

for yaml_file in "$REPO_ROOT"/workspaces/*/metadata/*.yaml; do
  [[ -f "$yaml_file" ]] || continue

  workspace=$(echo "$yaml_file" | sed "s|$REPO_ROOT/workspaces/||;s|/metadata/.*||")
  package_name=$(grep "packageName:" "$yaml_file" | head -1 | sed "s/.*packageName: *['\"]*//" | sed "s/['\"].*//")
  role=$(grep "role:" "$yaml_file" | head -1 | sed 's/.*role: *//' | tr -d '[:space:]')
  oci_ref=$(grep "dynamicArtifact:" "$yaml_file" | head -1 | sed "s/.*dynamicArtifact: *//" | sed 's|^"||;s|"$||' | sed "s|^oci://||" | sed 's|!.*||')

  [[ -z "$package_name" ]] && continue

  plugin_folder=$(get_plugin_folder "$package_name")
  support_tier=$(get_support_tier "$workspace" "$plugin_folder")

  if [[ "$role" != "frontend-plugin" ]]; then
    status="backend-only"
    features_json="{}"
  elif [[ -z "$oci_ref" || "$oci_ref" == "./"* ]]; then
    # Plugin ships inside the RHDH container image (local path)
    status="baked-in"
    features_json="{}"
  elif [[ "$oci_ref" == *"quay.io"* ]]; then
    # Hosted on a non-GHCR registry we can't inspect
    status="external-registry"
    features_json="{}"
  elif [[ "$USE_OCI" == "true" ]]; then
    # Pull OCI artifact and extract backstage.features
    subdir="$WORKDIR/$(echo "$package_name" | tr '/@' '__')"
    mkdir -p "$subdir"

    features_json="{}"
    if oras copy "$oci_ref" --to-oci-layout "$subdir/layout" >/dev/null 2>&1; then
      manifest_digest=$(jq -r '.manifests[0].digest' "$subdir/layout/index.json" | sed 's/sha256://')
      layer_digest=$(jq -r '.layers[0].digest' "$subdir/layout/blobs/sha256/$manifest_digest" | sed 's/sha256://')
      pkg_json_path=$(tar tzf "$subdir/layout/blobs/sha256/$layer_digest" 2>/dev/null | grep -E "^[^/]+/package\.json$" | head -1)

      if [[ -n "$pkg_json_path" ]]; then
        tar xzf "$subdir/layout/blobs/sha256/$layer_digest" -C "$subdir" "$pkg_json_path" 2>/dev/null
        features_json=$(jq -c '.backstage.features // {}' "$subdir/$pkg_json_path" 2>/dev/null || echo '{}')
      fi
    else
      echo "Warning: failed to pull $oci_ref" >&2
    fi
    rm -rf "$subdir"

    status=$(classify_features "$features_json")
  else
    # No --oci flag — can't determine status
    status="unknown"
    features_json="{}"
  fi

  RESULTS=$(echo "$RESULTS" | jq \
    --arg ws "$workspace" \
    --arg pkg "$package_name" \
    --arg role "$role" \
    --arg status "$status" \
    --arg tier "$support_tier" \
    --arg oci "$oci_ref" \
    --argjson features "$features_json" \
    '. += [{
      workspace: $ws,
      packageName: $pkg,
      role: $role,
      status: $status,
      supportTier: $tier,
      ociRef: $oci,
      features: $features
    }]')
done

if [[ "$OUTPUT_JSON" == "true" ]]; then
  echo "$RESULTS" | jq .
fi

if [[ "$OUTPUT_MARKDOWN" == "true" ]]; then
  # Generate markdown report
  total_frontend=$(echo "$RESULTS" | jq '[.[] | select(.role == "frontend-plugin")] | length')
  nfs_ready=$(echo "$RESULTS" | jq '[.[] | select(.status == "nfs-ready")] | length')
  mixed=$(echo "$RESULTS" | jq '[.[] | select(.status == "mixed")] | length')
  legacy_only=$(echo "$RESULTS" | jq '[.[] | select(.status == "legacy-only")] | length')
  no_features=$(echo "$RESULTS" | jq '[.[] | select(.status == "no-features")] | length')
  baked_in=$(echo "$RESULTS" | jq '[.[] | select(.status == "baked-in")] | length')
  external_reg=$(echo "$RESULTS" | jq '[.[] | select(.status == "external-registry")] | length')
  unknown=$(echo "$RESULTS" | jq '[.[] | select(.status == "unknown")] | length')
  backend_only=$(echo "$RESULTS" | jq '[.[] | select(.status == "backend-only")] | length')

  cat <<EOF
## NFS Readiness Report

**Generated:** $(date -u '+%Y-%m-%d %H:%M UTC')

### Summary

| Status | Count | Description |
|--------|-------|-------------|
| :green_circle: nfs-ready | $nfs_ready | All entry points are NFS feature types |
| :yellow_circle: mixed | $mixed | Some NFS entry points, some legacy/unrecognized |
| :orange_circle: legacy-only | $legacy_only | Entry points present but none are NFS types |
| :red_circle: no-features | $no_features | \`backstage.features\` field absent or empty in OCI artifact |
| :blue_circle: baked-in | $baked_in | Ships inside the RHDH container image (local path, not OCI) |
| :purple_circle: external-registry | $external_reg | Hosted on a non-GHCR registry (cannot inspect) |
| :white_circle: unknown | $unknown | Could not determine status (no \`--oci\` flag or pull failed) |
| — backend-only | $backend_only | Backend plugin (not applicable) |

**Frontend plugins:** $total_frontend total — **$nfs_ready** NFS-ready ($(( total_frontend > 0 ? nfs_ready * 100 / total_frontend : 0 ))%)

### By Support Tier

EOF

  for tier in supported community other; do
    case "$tier" in
      supported) tier_label="Red Hat Supported" ;;
      community) tier_label="Community" ;;
      other)     tier_label="Other" ;;
    esac
    tier_frontend=$(echo "$RESULTS" | jq --arg t "$tier" '[.[] | select(.supportTier == $t and .role == "frontend-plugin")] | length')
    tier_ready=$(echo "$RESULTS" | jq --arg t "$tier" '[.[] | select(.supportTier == $t and .status == "nfs-ready")] | length')

    [[ "$tier_frontend" -eq 0 ]] && continue

    pct=$(( tier_frontend > 0 ? tier_ready * 100 / tier_frontend : 0 ))
    echo "#### $tier_label ($tier_ready/$tier_frontend frontend plugins NFS-ready — $pct%)"
    echo ""
    echo "| Plugin | Workspace | Status | Features |"
    echo "|--------|-----------|--------|----------|"

    echo "$RESULTS" | jq -r --arg t "$tier" '
      [.[] | select(.supportTier == $t and .role == "frontend-plugin")]
      | sort_by(.status, .workspace, .packageName)
      | .[]
      | {
          pkg: .packageName,
          ws: .workspace,
          status: .status,
          icon: (if .status == "nfs-ready" then ":green_circle:"
                 elif .status == "mixed" then ":yellow_circle:"
                 elif .status == "legacy-only" then ":orange_circle:"
                 elif .status == "no-features" then ":red_circle:"
                 elif .status == "baked-in" then ":blue_circle:"
                 elif .status == "external-registry" then ":purple_circle:"
                 else ":white_circle:" end),
          features_str: (if (.features | length) == 0 then "—"
                         else (.features | to_entries | map("`\(.key)` → \(.value)") | join(", ")) end)
        }
      | "| \(.pkg) | \(.ws) | \(.icon) \(.status) | \(.features_str) |"
    ' 2>/dev/null || true

    echo ""
  done

  # Non-frontend (backend-only) summary
  echo "### Backend-Only Plugins (not applicable)"
  echo ""
  echo "<details>"
  echo "<summary>$backend_only backend plugins (no NFS classification needed)</summary>"
  echo ""
  echo "| Plugin | Workspace | Tier |"
  echo "|--------|-----------|------|"
  echo "$RESULTS" | jq -r '
    .[] | select(.status == "backend-only") |
    "| \(.packageName) | \(.workspace) | \(.supportTier) |"
  ' 2>/dev/null || true
  echo ""
  echo "</details>"

  cat <<EOF

---

### Classification Reference

The NFS readiness status is derived from the \`backstage.features\` field in each plugin's
\`dist-dynamic/package.json\`, which is populated by \`rhdh-cli >= 1.11.3\` during
\`export-dynamic-plugin\`.

The classification aligns with the [\`nfsModuleFilter\`](https://github.com/redhat-developer/rhdh/blob/main/packages/backend/src/modules/nfsModuleFilter.ts)
logic in RHDH, which recognizes these NFS feature types:

- \`@backstage/FrontendPlugin\`
- \`@backstage/FrontendModule\`

Plugins classified as **no-features** were exported with \`rhdh-cli >= 1.11.3\` but don't
have standard Module Federation exports that the CLI can detect.

Plugins classified as **baked-in** ship inside the RHDH container image and are not
published as separate OCI artifacts.

Plugins classified as **external-registry** are hosted on a non-GHCR registry
(e.g., \`quay.io\`) and cannot be inspected by this report.

EOF
fi
