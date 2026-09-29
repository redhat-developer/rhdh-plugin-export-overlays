#!/usr/bin/env bash
# NFS Readiness Report Generator
#
# Scans all workspace metadata to classify frontend plugins by their
# backstage.features content, aligned with the nfsModuleFilter logic
# in RHDH (NFS_FEATURE_TYPES: @backstage/FrontendPlugin, @backstage/FrontendModule).
#
# Classification:
#   nfs-ready          — All entry points have NFS feature types
#   mixed              — Some NFS entry points, some legacy/unrecognized
#   legacy-only        — Entry points present but none are NFS types
#   no-features        — backstage.features field absent or empty in OCI artifact
#   unknown            — Could not determine status (no --oci flag or OCI pull failed)
#   backend-only       — Plugin role is backend-plugin (not applicable)
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

# Roles that constitute frontend surface. Both carry backstage.features and reach the
# browser through the same module-federation remote.
FRONTEND_ROLES=("frontend-plugin" "frontend-plugin-module")

# Exact membership, not a prefix or glob match: `frontend-plugin` must not admit a
# hypothetical `frontend-plugin-widget` that the classifier would then call backend-only.
contains_exact() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [[ "$needle" == "$item" ]]; then
      return 0
    fi
  done
  return 1
}

is_frontend_role() {
  local role="$1"
  contains_exact "$role" "${FRONTEND_ROLES[@]}"
}

is_nfs_type() {
  local feature_type="$1"
  contains_exact "$feature_type" "${NFS_FEATURE_TYPES[@]}"
}

# Read support tier files into associative arrays
declare -A TIER_MAP
while IFS= read -r line; do
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  TIER_MAP["$line"]="supported"
done < "$REPO_ROOT/rhdh-supported-packages.txt"

while IFS= read -r line; do
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  TIER_MAP["$line"]="community"
done < "$REPO_ROOT/rhdh-community-packages.txt"

# Build per-workspace tier sets for fallback matching
declare -A WS_TIERS
for entry in "${!TIER_MAP[@]}"; do
  ws="${entry%%/*}"
  tier="${TIER_MAP[$entry]}"
  existing="${WS_TIERS[$ws]:-}"
  if [[ -z "$existing" ]]; then
    WS_TIERS["$ws"]="$tier"
  elif [[ "$existing" != "$tier" ]]; then
    WS_TIERS["$ws"]="mixed"
  fi
done

# Read plugins-list.yaml paths for a workspace (cached)
declare -A PLUGINS_LIST_CACHE
load_plugin_paths() {
  local ws="$1"
  if [[ -n "${PLUGINS_LIST_CACHE[$ws]+set}" ]]; then
    return
  fi
  local pl_file="$REPO_ROOT/workspaces/$ws/plugins-list.yaml"
  local paths=""
  if [[ -f "$pl_file" ]]; then
    while IFS= read -r pl_line <&3; do
      [[ "$pl_line" =~ ^#.*$ || -z "$pl_line" ]] && continue
      local path="${pl_line%%:*}"
      path="$(echo "$path" | tr -d '[:space:]')"
      [[ -n "$path" ]] && paths="$paths $path"
    done 3< "$pl_file"
  fi
  PLUGINS_LIST_CACHE["$ws"]="$paths"
}

# Determine support tier for a package by matching against txt files
get_support_tier() {
  local ws="$1"
  local pkg_name="$2"
  local bare="${pkg_name#@*/}"  # strip npm scope
  local stripped_plugin="${bare#plugin-}"
  local stripped_backstage="${bare#backstage-plugin-}"

  # Try to match package name to a plugins-list.yaml path
  load_plugin_paths "$ws"
  local paths="${PLUGINS_LIST_CACHE[$ws]:-}"
  for pp in $paths; do
    local folder="${pp##*/}"
    if [[ "$folder" == "$bare" || \
          "$folder" == "$stripped_plugin" || \
          "$folder" == "$stripped_backstage" ]]; then
      local key="$ws/$pp"
      if [[ -n "${TIER_MAP[$key]:-}" ]]; then
        echo "${TIER_MAP[$key]}"
        return
      fi
    fi
  done

  # Fallback: if all entries for this workspace are the same tier, use that
  local ws_tier="${WS_TIERS[$ws]:-}"
  if [[ -n "$ws_tier" && "$ws_tier" != "mixed" ]]; then
    echo "$ws_tier"
    return
  fi

  echo "other"
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
TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT
RESULTS_FILE="$TMPDIR_WORK/results.jsonl"
touch "$RESULTS_FILE"
WORKDIR="$TMPDIR_WORK/oci"

for yaml_file in "$REPO_ROOT"/workspaces/*/metadata/*.yaml; do
  [[ -f "$yaml_file" ]] || continue

  workspace=$(echo "$yaml_file" | sed "s|$REPO_ROOT/workspaces/||;s|/metadata/.*||")
  package_name=$(grep "packageName:" "$yaml_file" | head -1 | sed "s/.*packageName: *['\"]*//" | sed "s/['\"].*//")
  role=$(grep "role:" "$yaml_file" | head -1 | sed 's/.*role: *//' | tr -d '[:space:]')
  oci_ref=$(grep "dynamicArtifact:" "$yaml_file" | head -1 | sed "s/.*dynamicArtifact: *//" | sed 's|^"||;s|"$||' | sed "s|^oci://||" | sed 's|!.*||')

  [[ -z "$package_name" ]] && continue

  support_tier=$(get_support_tier "$workspace" "$package_name")

  # frontend-plugin-module counts as frontend surface: those packages carry
  # backstage.features and load through the same module-federation remote. Filtering on
  # frontend-plugin alone bucketed them as backend-only, understating the denominator
  # (80 frontend packages reported as 75) and hiding 4 already-NFS-ready modules.
  #
  # One decision, taken once. It travels in the emitted JSON as `frontend` so the markdown
  # filters select on it rather than re-deriving it — a second expression of the same
  # predicate is how the classifier and the denominator drifted apart in the first place.
  is_frontend=true
  if ! is_frontend_role "$role"; then
    is_frontend=false
    status="backend-only"
    features_json="{}"
  elif [[ -z "$oci_ref" || "$oci_ref" == "./"* ]]; then
    # Plugin ships inside the RHDH container image (local path).
    # Infer NFS readiness from source package.json exports field.
    features_json="{}"
    source_json="$REPO_ROOT/workspaces/$workspace/source.json"
    if [[ -f "$source_json" ]]; then
      repo_url=$(jq -r '.repo // empty' "$source_json" 2>/dev/null) || repo_url=""
      repo_ref=$(jq -r '."repo-ref" // empty' "$source_json" 2>/dev/null) || repo_ref=""
      repo_flat=$(jq -r '."repo-flat" // empty' "$source_json" 2>/dev/null) || repo_flat=""

      if [[ -n "$repo_url" && -n "$repo_ref" && "$repo_url" == *"github.com"* ]]; then
        # Convert GitHub URL to raw content URL
        raw_base=$(echo "$repo_url" | sed 's|github.com|raw.githubusercontent.com|')

        # Build path to source package.json
        load_plugin_paths "$workspace"
        baked_paths="${PLUGINS_LIST_CACHE[$workspace]:-}"
        baked_bare="${package_name#@*/}"
        baked_stripped_plugin="${baked_bare#plugin-}"
        baked_stripped_backstage="${baked_bare#backstage-plugin-}"
        matched_pp=""
        for pp in $baked_paths; do
          folder="${pp##*/}"
          if [[ "$folder" == "$baked_bare" || "$folder" == "$baked_stripped_plugin" || "$folder" == "$baked_stripped_backstage" ]]; then
            matched_pp="$pp"
            break
          fi
        done

        if [[ -n "$matched_pp" ]]; then
          if [[ "$repo_flat" == "true" ]]; then
            pkg_url="$raw_base/$repo_ref/$matched_pp/package.json"
          else
            pkg_url="$raw_base/$repo_ref/workspaces/$workspace/$matched_pp/package.json"
          fi

          src_exports=$(curl -fsSL --proto '=https' --tlsv1.2 "$pkg_url" 2>/dev/null | jq -c '.exports // {}' 2>/dev/null || echo '{}')
          if [[ -n "$src_exports" && "$src_exports" != "{}" ]]; then
            # Build inferred features from exports keys that look like NFS entry points
            inferred=$(echo "$src_exports" | jq -c '
              [to_entries[]
               | select((.key | startswith("./")) and .key != "./package.json")
              ]
              | map({(.key): "@backstage/FrontendPlugin"})
              | add // {}
            ' 2>/dev/null || echo '{}')
            features_json="$inferred"
          fi
        fi
      fi
    fi
    if [[ "$features_json" == "{}" || -z "$features_json" ]]; then
      # Inference failed or no exports found — can't determine status
      status="unknown"
    else
      status=$(classify_features "$features_json")
    fi
  elif [[ "$USE_OCI" == "true" ]]; then
    # Pull OCI artifact and extract backstage.features
    mkdir -p "$WORKDIR"
    subdir="$WORKDIR/$(echo "$package_name" | tr '/@' '__')"
    mkdir -p "$subdir"

    features_json="{}"
    if oras copy "$oci_ref" --to-oci-layout "$subdir/layout" >/dev/null 2>&1; then
      manifest_digest=$(jq -r '.manifests[0].digest' "$subdir/layout/index.json" | sed 's/sha256://')
      layer_digests=$(jq -r '.layers[].digest' "$subdir/layout/blobs/sha256/$manifest_digest" | sed 's/sha256://')

      pkg_json_path=""
      matched_layer=""
      for layer_digest in $layer_digests; do
        pkg_json_path=$(tar tzf "$subdir/layout/blobs/sha256/$layer_digest" 2>/dev/null | grep -E "^[^/]+/package\.json$" | head -1)
        if [[ -n "$pkg_json_path" ]]; then
          matched_layer="$layer_digest"
          break
        fi
      done

      if [[ -n "$pkg_json_path" && -n "$matched_layer" ]]; then
        tar xzf "$subdir/layout/blobs/sha256/$matched_layer" -C "$subdir" "$pkg_json_path" 2>/dev/null
        features_json=$(jq -c '.backstage.features // {}' "$subdir/$pkg_json_path" 2>/dev/null || echo '{}')
      else
        echo "Warning: no package.json found in any layer of $oci_ref" >&2
      fi
      status=$(classify_features "$features_json")
    else
      echo "Warning: failed to pull $oci_ref" >&2
      status="unknown"
    fi
    rm -rf "$subdir"
  else
    # No --oci flag — can't determine status
    status="unknown"
    features_json="{}"
  fi

  jq -n -c \
    --arg ws "$workspace" \
    --arg pkg "$package_name" \
    --arg role "$role" \
    --arg status "$status" \
    --arg tier "$support_tier" \
    --arg oci "$oci_ref" \
    --argjson features "$features_json" \
    --argjson frontend "$is_frontend" \
    '{
      workspace: $ws,
      packageName: $pkg,
      role: $role,
      frontend: $frontend,
      status: $status,
      supportTier: $tier,
      ociRef: $oci,
      features: $features
    }' >> "$RESULTS_FILE"
done

# Convert JSONL to JSON array
RESULTS=$(jq -s '.' "$RESULTS_FILE")

if [[ "$OUTPUT_JSON" == "true" ]]; then
  echo "$RESULTS" | jq .
fi

if [[ "$OUTPUT_MARKDOWN" == "true" ]]; then
  # Generate markdown report
  total_frontend=$(echo "$RESULTS" | jq '[.[] | select(.frontend)] | length')
  nfs_ready=$(echo "$RESULTS" | jq '[.[] | select(.status == "nfs-ready")] | length')
  mixed=$(echo "$RESULTS" | jq '[.[] | select(.status == "mixed")] | length')
  legacy_only=$(echo "$RESULTS" | jq '[.[] | select(.status == "legacy-only")] | length')
  no_features=$(echo "$RESULTS" | jq '[.[] | select(.status == "no-features")] | length')
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
| :white_circle: unknown | $unknown | Could not determine status (no \`--oci\` flag or pull failed) |
| — backend-only | $backend_only | Backend plugin (not applicable) |

**Frontend plugins:** $total_frontend total — **$nfs_ready** NFS-ready ($(( total_frontend > 0 ? nfs_ready * 100 / total_frontend : 0 ))%)

### By Support Tier

EOF

  for tier in supported community other; do
    case "$tier" in
      supported) tier_label="Red Hat Supported (GA + Tech Preview)" ;;
      community) tier_label="Community" ;;
      other)     tier_label="Other" ;;
      *)         tier_label="$tier" ;;
    esac
    tier_frontend=$(echo "$RESULTS" | jq --arg t "$tier" '[.[] | select(.supportTier == $t and .frontend)] | length')
    tier_ready=$(echo "$RESULTS" | jq --arg t "$tier" '[.[] | select(.supportTier == $t and .status == "nfs-ready")] | length')

    [[ "$tier_frontend" -eq 0 ]] && continue

    pct=$(( tier_frontend > 0 ? tier_ready * 100 / tier_frontend : 0 ))
    echo "#### $tier_label ($tier_ready/$tier_frontend frontend plugins NFS-ready — $pct%)"
    echo ""
    echo "| Plugin | Workspace | Status | Features |"
    echo "|--------|-----------|--------|----------|"

    echo "$RESULTS" | jq -r --arg t "$tier" '
      [.[] | select(.supportTier == $t and .frontend)]
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

#### Reading the counts

Only **nfs-ready** and **no-features** are informative here. **mixed** and
**legacy-only** require \`backstage.features\` to be non-empty while containing no NFS
type — but the CLI populates that field *from* the Module Federation entry points it
detects, so a plugin with no NFS entry point ends up with an empty field and lands in
**no-features** instead. A \`mixed: 0 / legacy-only: 0\` line therefore is not evidence
of anything; it is the expected output shape. Read **no-features** as "not migrated".

**no-features** also merges two states worth telling apart, which this report cannot
distinguish on its own: a package that ships no Module Federation bundle at all, and a
package that ships a servable remote whose exposed modules simply are not NFS feature
types (\`@roadiehq/backstage-plugin-{argo-cd,datadog,github-insights}\` expose an
\`alpha\` module in their MF manifest but declare no features). The second group is much
closer to ready than the first. \`smoke-tests-native\` reports that distinction per
package as \`frontend.bundles[].mf\` in its \`results.json\`.

EOF
fi
