#!/usr/bin/env bash
#
# Generate dynamic-plugins.default.yaml (DPDY) from default.packages.yaml and overlay-repo/workspaces/*/metadata/*.yaml
# See also build/ci/update-index.sh
#

usage() {
  cat <<'USAGE'
Script to generate dynamic-plugins.default.yaml from default.packages.yaml
and metadata YAML files from rhdh-plugin-export-overlays.

Usage: generateDynamicPluginsDefaultYaml.sh [--debug] \
    --overlays-dir  /home/user/rhdh-plugin-catalog/overlay-repo \\
    --packages-file /home/user/rhdh-plugin-catalog/catalog-index/default.packages.yaml \\
    --output-file   /home/user/rhdh-plugin-catalog/catalog-index/dynamic-plugins.default.yaml

Arguments (required):
  -d, --overlays-dir   Path to directory where
                       https://github.com/redhat-developer/rhdh-plugin-export-overlays
                       is checked out, or to the overlay-repo folder in the rhdh-plugin-catalog repo
  -p, --packages-file  Path to default.packages.yaml
  -o, --output-file    Path to output dynamic-plugins.default.yaml file

The script will:
1. Read all packages from default.packages.yaml
2. Find corresponding metadata files in the overlay-repo directory
3. Extract the appConfigExamples content from each metadata file
4. Generate dynamic-plugins.default.yaml

Once complete, you should:
5. Run generateCatalogIndex.py to generate the catalog index, and to
6. Add oci ref comments into the DPDY file (see build/ci/update-index.sh)

Requires: yq
USAGE
}

PACKAGES_FILE=
OVERLAYS_DIR=
OUTPUT_FILE=
DEBUG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--overlays-dir)
      OVERLAYS_DIR="$2"
      shift 2
      ;;
    -p|--packages-file)
      PACKAGES_FILE="$2"
      shift 2
      ;;
    -o|--output-file)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --debug)
      DEBUG=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${PACKAGES_FILE:-}" || -z "${OVERLAYS_DIR:-}" || -z "${OUTPUT_FILE:-}" ]]; then
  echo "Error: --packages-file, --overlays-dir, and --output-file are required." >&2
  usage >&2
  exit 1
fi

if [[ ! -f "$PACKAGES_FILE" ]]; then
  echo "Error: Packages file not found: $PACKAGES_FILE" >&2
  exit 1
fi

if [[ ! -d "$OVERLAYS_DIR" ]]; then
  echo "Error: Overlays directory not found: $OVERLAYS_DIR" >&2
  exit 1
fi

if ! command -v yq &>/dev/null; then
  echo "Error: yq is required (mikefarah/yq or kislyuk/yq)." >&2
  exit 1
fi

# Detect yq variant: mikefarah uses -o=json for JSON; kislyuk (Python/jq wrapper) outputs JSON by default
if yq -o=json '.' /dev/null 2>/dev/null; then
  YQ_YAML_OPT="-P"
else
  YQ_YAML_OPT="-y"
fi

# -----------------------------------------------------------------------------
# Build metadata map: package name -> path to metadata YAML
# Also index by file stem (basename without .yaml) so fallback lookup works.
# -----------------------------------------------------------------------------
declare -A METADATA_MAP
WORKSPACES_DIR="${OVERLAYS_DIR}/workspaces"

# Fallback: map @red-hat-developer-hub/backstage-plugin-* to file stem redhat-backstage-plugin-*
# (metadata files in rhdh-plugin-export-overlays use redhat-* basenames, e.g. orchestrator metadata).
pkg_to_filestem() {
  local pkg=$1
  if [[ "$pkg" == @red-hat-developer-hub/backstage-plugin-* ]]; then
    echo "redhat-backstage-plugin-${pkg#@red-hat-developer-hub/backstage-plugin-}"
  fi
}

if [[ ! -d "$WORKSPACES_DIR" ]]; then
  echo "Warning: Workspaces directory not found: $WORKSPACES_DIR" >&2
else
  while IFS= read -r -d '' meta_path; do
    package_name=$(yq -r '.spec.packageName // ""' "$meta_path" 2>/dev/null) || continue
    dynamic_artifact=$(yq -r '.spec.dynamicArtifact // ""' "$meta_path" 2>/dev/null)

    # Index by file stem (basename without .yaml) for fallback lookup
    meta_basename=$(basename "$meta_path" .yaml)
    METADATA_MAP["$meta_basename"]=$meta_path

    if [[ -n "$package_name" ]]; then
      METADATA_MAP["$package_name"]=$meta_path
    fi

    if [[ -n "$dynamic_artifact" && "$dynamic_artifact" != .* ]]; then
      if [[ "$dynamic_artifact" == *@* && "$dynamic_artifact" != @* ]]; then
        # package@version
        artifact_pkg="${dynamic_artifact%%@*}"
        METADATA_MAP["$artifact_pkg"]=$meta_path
      elif [[ "$dynamic_artifact" == @* ]]; then
        # @scope/package@version
        if [[ $(echo -n "$dynamic_artifact" | tr -cd '@' | wc -c) -gt 1 ]]; then
          artifact_pkg="${dynamic_artifact%@*}"
          METADATA_MAP["$artifact_pkg"]=$meta_path
        fi
      else
        METADATA_MAP["$dynamic_artifact"]=$meta_path
      fi
    fi
  done < <(find "$WORKSPACES_DIR" -path '*/metadata/*.yaml' -print0 2>/dev/null)
fi

if [[ $DEBUG -eq 1 ]]; then
  echo "Loading packages from: $PACKAGES_FILE"
  echo "Scanning metadata files in: $OVERLAYS_DIR"
  echo "Found ${#METADATA_MAP[@]} metadata files"
fi

explain_missing() {
  local pkg=$1
  echo ""
  echo "Error: No metadata found for package '$pkg'!"
  if [[ ! -d "$WORKSPACES_DIR" ]]; then
    echo "The workspaces directory does not exist under $OVERLAYS_DIR"
  elif [[ ${#METADATA_MAP[@]} -eq 0 ]]; then
    echo "No metadata files were found in $WORKSPACES_DIR/<workspace>/metadata/*.yaml"
  else
    echo "Possible reasons:"
    echo "1. The package name in default.packages.yaml doesn't match the 'packageName' in metadata"
    echo "2. The package name format differs (e.g., with/without version, with/without @scope)"
    echo "3. The metadata file is missing or in an unexpected location"
    echo "4. The package name might need to remove the '-dynamic' suffix (if moving from wrapper to oci artifact)"
  fi
}

# -----------------------------------------------------------------------------
# Build plugin entry YAML from a metadata file
# Outputs YAML to stdout for reuse
# -----------------------------------------------------------------------------
build_plugin_entry() {
  local meta_path=$1
  local disabled=$2

  local dynamic_artifact package_value
  dynamic_artifact=$(yq -r '.spec.dynamicArtifact // ""' "$meta_path" 2>/dev/null)

  if [[ "$dynamic_artifact" == ./.* ]]; then
    package_value=$dynamic_artifact
  elif [[ "$dynamic_artifact" == *"oci://"*"!"* ]]; then
    # Strip !fragment if present (e.g. oci://...!package-name)
    package_value="${dynamic_artifact%%!*}"
  else
    package_value=$dynamic_artifact
  fi

  # Build entry as YAML: package, disabled, and optional pluginConfig from file
  entry=$(yq -y \
    --arg pkg "$package_value" \
    --argjson dis "$disabled" \
    '({package: $pkg, disabled: $dis} +
     (if .spec.appConfigExamples[0].content then {pluginConfig: .spec.appConfigExamples[0].content} else {} end))
     | with_entries(select(.value != null))' \
    "$meta_path")
  # fix indenting so that the entire entry is precended by 2 spaces per line
  # shellcheck disable=SC2001
  entry=$(echo "$entry" | sed 's/^/  /')
  echo "$entry"
}

# -----------------------------------------------------------------------------
# Collect enabled and disabled package entries from default.packages.yaml
# Each plugin entry is built as YAML and appended to a temp file for sort + merge with yq.
# -----------------------------------------------------------------------------
enabled_count=$(yq -r '.packages.enabled // [] | length' "$PACKAGES_FILE")
disabled_count=$(yq -r '.packages.disabled // [] | length' "$PACKAGES_FILE")
echo ""
echo "Processing $enabled_count enabled packages..."

ENTRIES_TMP=$(mktemp) || { echo "Cannot create temp file" >&2; exit 1; }
trap 'rm -f "$ENTRIES_TMP"' EXIT
first=true

idx=0
while [[ $idx -lt $enabled_count ]]; do
  pkg_name=$(yq -r '.packages.enabled['"$idx"'].package // ""' "$PACKAGES_FILE")
  [[ "$pkg_name" == "null" ]] && pkg_name=""
  pkg_name=${pkg_name//\"}; pkg_name=${pkg_name//\'}
  meta_path="${METADATA_MAP[$pkg_name]:-}"
  if [[ -z "$meta_path" ]]; then
    filestem=$(pkg_to_filestem "$pkg_name")
    [[ -n "$filestem" ]] && meta_path="${METADATA_MAP[$filestem]:-}"
  fi
  if [[ -z "$meta_path" ]]; then
    explain_missing "$pkg_name" >&2
    exit 1
  fi
  entry=$(build_plugin_entry "$meta_path" "false") || {
    echo "  ✗ $pkg_name (failed to generate entry)" >&2
    exit 1
  }
  echo "  ✓ $pkg_name"
  if [[ "$first" == true ]]; then
    first=false
  else
    echo "---" >> "$ENTRIES_TMP"
  fi
  echo "$entry" >> "$ENTRIES_TMP"
  ((idx++)) || true
done

echo ""
echo "Processing $disabled_count disabled packages..."
idx=0
while [[ $idx -lt $disabled_count ]]; do
  pkg_name=$(yq -r '.packages.disabled['"$idx"'].package // ""' "$PACKAGES_FILE")
  [[ "$pkg_name" == "null" ]] && pkg_name=""
  pkg_name=${pkg_name//\"}; pkg_name=${pkg_name//\'}
  meta_path="${METADATA_MAP[$pkg_name]:-}"
  if [[ -z "$meta_path" ]]; then
    filestem=$(pkg_to_filestem "$pkg_name")
    [[ -n "$filestem" ]] && meta_path="${METADATA_MAP[$filestem]:-}"
  fi
  if [[ -z "$meta_path" ]]; then
    explain_missing "$pkg_name" >&2
    exit 1
  fi
  entry=$(build_plugin_entry "$meta_path" "true") || {
    echo "  ✗ $pkg_name (failed to generate entry)" >&2
    exit 1
  }
  echo "  ✓ $pkg_name"
  echo "---" >> "$ENTRIES_TMP"
  echo "$entry" >> "$ENTRIES_TMP"
  ((idx++)) || true
done

# -----------------------------------------------------------------------------
# Sort (disabled false first, then by package name) and wrap as {plugins: [...]} with yq
# -----------------------------------------------------------------------------
echo ""
echo "Sorting plugins and writing to $OUTPUT_FILE..."
mkdir -p "$(dirname "$OUTPUT_FILE")"
if [[ "$YQ_YAML_OPT" == "-P" ]]; then
  yq -s 'sort_by([.disabled, (.package | ascii_downcase)]) | {plugins: .}' "$ENTRIES_TMP" | yq -P '.' > "$OUTPUT_FILE"
else
  yq -s -y 'sort_by([.disabled, (.package | ascii_downcase)]) | {plugins: .}' "$ENTRIES_TMP" > "$OUTPUT_FILE"
fi

# -----------------------------------------------------------------------------
# Stats (from final YAML)
# -----------------------------------------------------------------------------
total=$(yq -r '.plugins | length' "$OUTPUT_FILE")
enabled_num=$(yq -r '[.plugins[] | select(.disabled == false)] | length' "$OUTPUT_FILE")
disabled_num=$(yq -r '[.plugins[] | select(.disabled == true)] | length' "$OUTPUT_FILE")
with_config=$(yq -r '[.plugins[] | select(has("pluginConfig"))] | length' "$OUTPUT_FILE")

if [[ $DEBUG -eq 1 ]]; then
  echo ""
  echo "============================================================"
  echo "✓ Successfully generated $OUTPUT_FILE"
  echo "============================================================"
  echo "Total plugins:      $total"
  echo "  - Enabled:        $enabled_num"
  echo "  - Disabled:       $disabled_num"
  echo "  - With config:    $with_config"
  echo "  - Without config: $((total - with_config))"
  echo "============================================================"
else
  echo "Generated: $OUTPUT_FILE"
fi
