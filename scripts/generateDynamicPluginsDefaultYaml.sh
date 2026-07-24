#!/usr/bin/env bash
#
# Generate dynamic-plugins.default.yaml (DPDY) from default.packages.yaml and overlay-repo/workspaces/*/metadata/*.yaml
# See also scripts/update-index.sh
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

Arguments (optional):
  -b, --plugin-builds-dir  plugin_builds/ tree (default: derived from --output-file)
      --debug              Enable debug output

The script will:
1. Read all packages from default.packages.yaml
2. Find corresponding metadata files in the overlay-repo directory
3. Extract the appConfigExamples content from each metadata file
4. Generate dynamic-plugins.default.yaml
5. Inject Tag/Build date comments from plugin_builds/*.json (via injectDpdyTagComments.py)

Once complete, run generateCatalogIndex.py to refresh the catalog index and OCI refs.

Requires: yq (kislyuk/pypi-yq or mikefarah/yq). Prefer to use ~/.local/bin/yq_mf

Note: Using mikefarah yq, plugin yaml emission uses --unwrapScalar=false and 
env()+eval --expression to reduce YAML scalar rewrites.
USAGE
}

PACKAGES_FILE=
OVERLAYS_DIR=
OUTPUT_FILE=
PLUGIN_BUILDS_DIR=
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
    -b|--plugin-builds-dir)
      PLUGIN_BUILDS_DIR="$2"
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

if [[ -z "${PLUGIN_BUILDS_DIR:-}" ]]; then
  PLUGIN_BUILDS_DIR="$(cd "$(dirname "$OUTPUT_FILE")/.." && pwd)/plugin_builds"
fi

# Prefer mikefarah installed as yq_mf (e.g. builder image), else yq on PATH.
if command -v yq_mf &>/dev/null; then
  YQ_BIN=$(command -v yq_mf)
elif [[ -x "${HOME}/.local/bin/yq_mf" ]]; then
  YQ_BIN="${HOME}/.local/bin/yq_mf"
elif command -v yq &>/dev/null; then
  YQ_BIN=$(command -v yq)
else
  echo "Error: yq is required (mikefarah or kislyuk)." >&2
  exit 1
fi

# Detect yq variant: only mikefarah accepts -o=json here; kislyuk fails this probe.
if "$YQ_BIN" -o=json '.' /dev/null >/dev/null 2>&1; then
  YQ_IS_MIKE_FARAH=1
else
  YQ_IS_MIKE_FARAH=0
fi

# Yaml-output flag for kislyuk `yq -s …` / plugin entry (replacing hardcoded -y).
YQ_YAML_OPT="-y"

# Raw jq-style scalar read (kislyuk: yq -r; mikefarah: yq eval -r).
yq_raw() {
  local expr=$1
  shift
  if [[ "${YQ_IS_MIKE_FARAH:-0}" -eq 1 ]]; then
    "$YQ_BIN" eval -r "$expr" "$@"
  else
    "$YQ_BIN" -r "$expr" "$@"
  fi
}

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
    package_name=$(yq_raw '.spec.packageName // ""' "$meta_path" 2>/dev/null) || continue
    dynamic_artifact=$(yq_raw '.spec.dynamicArtifact // ""' "$meta_path" 2>/dev/null)

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
  echo "Using yq binary: $YQ_BIN (mikefarah=$YQ_IS_MIKE_FARAH)"
  echo "Loading packages from: $PACKAGES_FILE"
  echo "Plugin builds dir: $PLUGIN_BUILDS_DIR"
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
  local enabled=$2

  local dynamic_artifact package_value
  dynamic_artifact=$(yq_raw '.spec.dynamicArtifact // ""' "$meta_path" 2>/dev/null)
  package_value=$dynamic_artifact

  local entry
  if [[ "${YQ_IS_MIKE_FARAH:-0}" -eq 1 ]]; then
    # Preserve nested scalar quoting (pluginConfig); pass package/enabled via env — mikefarah has no jq --arg on eval.
    export MF_PKG="$package_value"
    export MF_ENB="$enabled"
    entry=$("$YQ_BIN" --unwrapScalar=false eval --expression \
      '{"package": env(MF_PKG), "enabled": (env(MF_ENB) == "true"), "pluginConfig": .spec.appConfigExamples[0].content} | with_entries(select(.value != null))' \
      "$meta_path" -o yaml)
  else
    # shellcheck disable=SC2016
    entry=$("$YQ_BIN" "${YQ_YAML_OPT}" \
      --arg pkg "$package_value" \
      --argjson enb "$enabled" \
      '({package: $pkg, enabled: $enb} +
       (if .spec.appConfigExamples[0].content then {pluginConfig: .spec.appConfigExamples[0].content} else {} end))
       | with_entries(select(.value != null))' \
      "$meta_path")
  fi
  # fix indenting so that the entire entry is precended by 2 spaces per line
  # shellcheck disable=SC2001
  entry=$(printf '%s\n' "$entry" | sed 's/^/  /')
  echo "$entry"
}

inject_tag_comments_in_dpdy() {
  local out_file=$1
  local script_dir
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  [[ -f "$out_file" ]] || return 0
  python3 "${script_dir}/injectDpdyTagComments.py" "$out_file" "$PLUGIN_BUILDS_DIR"
}

# -----------------------------------------------------------------------------
# Collect enabled and disabled package entries from default.packages.yaml
# Each plugin entry is appended to a temp file; merged in default.packages.yaml order (enabled then disabled).
# -----------------------------------------------------------------------------
enabled_count=$(yq_raw '.packages.enabled // [] | length' "$PACKAGES_FILE")
disabled_count=$(yq_raw '.packages.disabled // [] | length' "$PACKAGES_FILE")
echo ""
echo "Processing $enabled_count enabled packages..."

ENTRIES_TMP=$(mktemp) || { echo "Cannot create temp file" >&2; exit 1; }
trap 'rm -f "$ENTRIES_TMP"' EXIT
first=true

idx=0
while [[ $idx -lt $enabled_count ]]; do
  pkg_name=$(yq_raw '.packages.enabled['"$idx"'].package // ""' "$PACKAGES_FILE")
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
  pkg_name=$(yq_raw '.packages.disabled['"$idx"'].package // ""' "$PACKAGES_FILE")
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
  echo "---" >> "$ENTRIES_TMP"
  echo "$entry" >> "$ENTRIES_TMP"
  ((idx++)) || true
done

# -----------------------------------------------------------------------------
# Wrap as {plugins: [...]} preserving list order (kislyuk: yq -s; mikefarah: eval-all).
# -----------------------------------------------------------------------------
echo ""
echo "Merging plugin entries and writing to $OUTPUT_FILE..."
mkdir -p "$(dirname "$OUTPUT_FILE")"
if [[ "${YQ_IS_MIKE_FARAH:-0}" -eq 1 ]]; then
  "$YQ_BIN" eval-all --unwrapScalar=false '[.] | {"plugins": .}' "$ENTRIES_TMP" -o yaml > "$OUTPUT_FILE"
else
  "$YQ_BIN" -s "${YQ_YAML_OPT}" '{plugins: .}' "$ENTRIES_TMP" > "$OUTPUT_FILE"
fi

# add header onto file so people stop asking how it's maintained
cat << EOL > "$OUTPUT_FILE".head
# THIS FILE IS GENERATED - DO NOT EDIT!
#
# File dynamic-plugins.default.yaml is now generated from default.packages.yaml
# and default configuration located in the overlays repo under workspaces/*/metadata/*.yaml
# See https://github.com/redhat-developer/rhdh-plugin-export-overlays/
#
# To update this file, trigger a rebuld of the index image from 
# https://gitlab.cee.redhat.com/rhidp/rhdh-plugin-catalog/-/blob/rhdh-1-rhel-9/build/ci/update-index.sh
EOL
cat "$OUTPUT_FILE".head "$OUTPUT_FILE" > "$OUTPUT_FILE"_
mv "$OUTPUT_FILE"_ "$OUTPUT_FILE"
rm -f "$OUTPUT_FILE".head

inject_tag_comments_in_dpdy "$OUTPUT_FILE"

# -----------------------------------------------------------------------------
# Stats (from final YAML)
# -----------------------------------------------------------------------------
total=$(yq_raw '.plugins | length' "$OUTPUT_FILE")
enabled_num=$(yq_raw '[.plugins[] | select(.enabled == true)] | length' "$OUTPUT_FILE")
disabled_num=$(yq_raw '[.plugins[] | select(.enabled == false)] | length' "$OUTPUT_FILE")
with_config=$(yq_raw '[.plugins[] | select(has("pluginConfig"))] | length' "$OUTPUT_FILE")

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
