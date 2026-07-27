#!/usr/bin/env bash
#
# Copyright (c) Red Hat, Inc.
#
# Orchestrator script to generate plugin_builds/ and catalog-index/ directories.
#
# Usage examples (defaults: --overlays-dir=. --output-dir=catalog-index --plugin-builds-dir=plugin_builds):
#
#   # Supported index (union of default.packages.yaml + rhdh-supported-packages.txt)
#   scripts/update-index.sh \
#     --overlays-dir . \
#     --registry quay.io/rhdh-community \
#     --output-dir catalog-index/supported \
#     --plugin-builds-dir plugin_builds/supported \
#     --packages-file catalog-index/default.packages.yaml \
#     --packages-file rhdh-supported-packages.txt
#
#   # Community index (from rhdh-community-packages.txt)
#   scripts/update-index.sh \
#     --overlays-dir . \
#     --registry ghcr.io/redhat-developer/rhdh-plugin-export-overlays \
#     --output-dir catalog-index/community \
#     --plugin-builds-dir plugin_builds/community \
#     --packages-file rhdh-community-packages.txt
#
#   # Midstream (quay.io/rhdh → registry.access.redhat.com)
#   scripts/update-index.sh \
#     --overlays-dir /path/to/overlay-repo \
#     --registry quay.io/rhdh \
#     --output-dir /path/to/catalog-index \
#     --plugin-builds-dir /path/to/plugin_builds \
#     --packages-file /path/to/catalog-index/default.packages.yaml \
#     --packages-file /path/to/rhdh-supported-packages.txt

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

norm="\033[0;39m"
green="\033[1;32m"
red="\033[1;31m"
blue="\033[1;34m"

OVERLAYS_DIR="."
REGISTRY=""
RHDH_VERSION=""
COMMUNITY_REGISTRY="ghcr.io/redhat-developer/rhdh-plugin-export-overlays"
OUTPUT_DIR="catalog-index"
PLUGIN_BUILDS_DIR="plugin_builds"
PACKAGES_FILES=()
REPORT_FILE=""
DEBUG_FLAG=""
DEBUG=0

usage() {
    cat <<'USAGE'
Orchestrator script to generate plugin_builds/ and catalog-index/.

Usage:
    update-index.sh \
        -r|--registry BASE \
        [-d|--overlays-dir PATH] \
        [-o|--output-dir PATH] \
        [-b|--plugin-builds-dir PATH] \
        [-v|--rhdh-version VERSION] \
        [-p|--packages-file PATH ...] \
        [-cr|--community-registry BASE] \
        [--debug] \
        [-h|--help]

Arguments:
  -r,  --registry              Registry base (e.g., ghcr.io/redhat-developer/rhdh-plugin-export-overlays)
  -d,  --overlays-dir          Path to overlays repo root (contains workspaces/)
                               (default: .)
  -o,  --output-dir            Output directory for catalog-index
                               (default: catalog-index)
  -b,  --plugin-builds-dir     Directory for plugin_builds/ JSON files
                               (default: plugin_builds)
  -v,  --rhdh-version          RHDH version for non-ghcr.io tag convention (e.g., 1.5).
                               Required when registry is not ghcr.io.
  -cr, --community-registry    Registry base for community-tier plugins
                               (default: ghcr.io/redhat-developer/rhdh-plugin-export-overlays)
  -p,  --packages-file         Package list file (YAML or txt). Can be specified multiple times.
                               Files are unioned. Supports default.packages.yaml (npm names)
                               and txt files with workspace paths (e.g., rhdh-supported-packages.txt).
                               DPDY generation runs only when a file named default.packages.yaml is provided.
       --report-file           Path to build-report.json for tracking generation stages (optional).
       --debug                 Enable debug output
  -h,  --help                  Show this help
USAGE
    exit 1
}

while [[ "$#" -gt 0 ]]; do
    case $1 in
    '-d' | '--overlays-dir')
        OVERLAYS_DIR="$2"
        shift 2
        ;;
    '-r' | '--registry')
        REGISTRY="$2"
        shift 2
        ;;
    '-v' | '--rhdh-version')
        RHDH_VERSION="$2"
        shift 2
        ;;
    '-o' | '--output-dir')
        OUTPUT_DIR="$2"
        shift 2
        ;;
    '-b' | '--plugin-builds-dir')
        PLUGIN_BUILDS_DIR="$2"
        shift 2
        ;;
    '-p' | '--packages-file')
        PACKAGES_FILES+=("$2")
        shift 2
        ;;
    '-cr' | '--community-registry')
        COMMUNITY_REGISTRY="$2"
        shift 2
        ;;
    '--report-file')
        REPORT_FILE="$2"
        shift 2
        ;;
    '--debug')
        DEBUG=1
        DEBUG_FLAG="--debug"
        shift 1
        ;;
    '-h' | '--help')
        usage
        ;;
    *)
        echo -e "${red}[ERROR] Invalid parameter: $1${norm}" >&2
        echo
        usage
        ;;
    esac
done

# Validate required args
if [[ -z "$REGISTRY" ]]; then
    echo -e "${red}[ERROR] Missing required argument: --registry${norm}\n" >&2
    usage
fi

if [[ $DEBUG -eq 1 ]]; then
    echo "#################################"
    echo "OVERLAYS_DIR       = $OVERLAYS_DIR"
    echo "REGISTRY           = $REGISTRY"
    echo "RHDH_VERSION       = $RHDH_VERSION"
    echo "COMMUNITY_REGISTRY = $COMMUNITY_REGISTRY"
    echo "OUTPUT_DIR         = $OUTPUT_DIR"
    echo "PLUGIN_BUILDS_DIR  = $PLUGIN_BUILDS_DIR"
    echo "PACKAGES_FILES     = ${PACKAGES_FILES[*]:-<none>}"
    echo "REPORT_FILE        = ${REPORT_FILE:-<none>}"
    echo "#################################"
fi

# Build --report-file arg
REPORT_FILE_ARG=""
if [[ -n "$REPORT_FILE" ]]; then
    if ! command -v jq >/dev/null 2>&1; then
        echo -e "${red}[ERROR] jq is required when --report-file is used${norm}" >&2
        exit 1
    fi
    REPORT_FILE_ARG="--report-file $REPORT_FILE"
fi

# Build --packages-file args for bootstrapPluginBuilds.py
BOOTSTRAP_FILTER_ARGS=""
COMMUNITY_REGISTRY_ARG=""
if [[ ${#PACKAGES_FILES[@]} -gt 0 ]]; then
    for pf in "${PACKAGES_FILES[@]}"; do
        BOOTSTRAP_FILTER_ARGS="$BOOTSTRAP_FILTER_ARGS --packages-file $pf"
    done
    if [[ "$COMMUNITY_REGISTRY" != "$REGISTRY" ]]; then
        COMMUNITY_REGISTRY_ARG="--community-registry $COMMUNITY_REGISTRY"
    fi
fi

##############################################
# Step 1: Bootstrap plugin_builds/ from metadata
##############################################
echo -e "\n${green}=== Step 1: Bootstrap plugin_builds/ from metadata ===${norm}"
RHDH_VERSION_ARG=""
if [[ -n "$RHDH_VERSION" ]]; then
    RHDH_VERSION_ARG="--rhdh-version $RHDH_VERSION"
fi
# shellcheck disable=SC2086
if ! python "$SCRIPT_DIR/bootstrapPluginBuilds.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $RHDH_VERSION_ARG \
    $BOOTSTRAP_FILTER_ARGS \
    $COMMUNITY_REGISTRY_ARG \
    $REPORT_FILE_ARG \
    $DEBUG_FLAG; then
    echo -e "${red}[ERROR] bootstrapPluginBuilds.py failed!${norm}" >&2; exit 1
fi

##############################################
# Backup metadata files before Step 2 modifies them (write-back adds sha256 digests).
# Restored on exit so digests don't persist in source for future runs.
##############################################
METADATA_BACKUP=""
OVERLAYS_DIR_ABS=$(cd "$OVERLAYS_DIR" && pwd)
if [[ -d "$OVERLAYS_DIR_ABS/workspaces" ]]; then
    METADATA_BACKUP=$(mktemp -d)
    echo -e "${blue}Backing up workspaces/*/metadata/ to $METADATA_BACKUP${norm}"
    (cd "$OVERLAYS_DIR_ABS" && find workspaces -path "*/metadata/*.yaml" -print0 | tar cf "$METADATA_BACKUP/metadata.tar" --null -T -)
fi

restore_metadata() {
    if [[ -n "$METADATA_BACKUP" && -f "$METADATA_BACKUP/metadata.tar" ]]; then
        echo -e "\n${blue}Restoring original metadata files...${norm}"
        (cd "$OVERLAYS_DIR_ABS" && tar xf "$METADATA_BACKUP/metadata.tar")
        rm -rf "$METADATA_BACKUP"
        echo -e "${blue}Metadata restored.${norm}"
    fi
}
trap restore_metadata EXIT

##############################################
# Step 2: Enrich plugin_builds/ with registry metadata (includes fallback tag resolution)
##############################################
echo -e "\n${green}=== Step 2: Enrich plugin_builds/ with registry metadata ===${norm}"
# shellcheck disable=SC2086
if ! python "$SCRIPT_DIR/generatePluginBuildInfo.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $REPORT_FILE_ARG \
    $DEBUG_FLAG; then
    echo -e "${red}[ERROR] generatePluginBuildInfo.py failed!${norm}" >&2; exit 1
fi

##############################################
# Step 3: Generate dynamic-plugins.default.yaml
##############################################
# Find the default.packages.yaml file among the provided --packages-file args
DEFAULT_PACKAGES_FILE=""
for pf in "${PACKAGES_FILES[@]+"${PACKAGES_FILES[@]}"}"; do
    if [[ "$(basename "$pf")" == "default.packages.yaml" ]]; then
        DEFAULT_PACKAGES_FILE="$pf"
        break
    fi
done

if [[ -n "$DEFAULT_PACKAGES_FILE" ]]; then
    echo -e "\n${green}=== Step 3: Generate dynamic-plugins.default.yaml ===${norm}"
    echo -e "${blue}Using default packages file: $DEFAULT_PACKAGES_FILE${norm}"
    mkdir -p "$OUTPUT_DIR"
    DPDY_STATUS="pass"
    # shellcheck disable=SC2086
    if ! "$SCRIPT_DIR/generateDynamicPluginsDefaultYaml.sh" \
        --packages-file "$DEFAULT_PACKAGES_FILE" \
        --output-file "$OUTPUT_DIR/dynamic-plugins.default.yaml" \
        --overlays-dir "$OVERLAYS_DIR" \
        --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
        $DEBUG_FLAG; then
        DPDY_STATUS="fail"
        echo -e "${red}[ERROR] generateDynamicPluginsDefaultYaml.sh failed!${norm}" >&2
        if [[ -n "$REPORT_FILE" && -f "$REPORT_FILE" ]]; then
            python -c "
import sys; sys.path.insert(0, '$SCRIPT_DIR')
from plugin_utils import BuildReport
r = BuildReport('$REPORT_FILE')
r.set_stage_all('dpdy', 'fail')
r.save()
"
        fi
        exit 1
    fi
    cp "$DEFAULT_PACKAGES_FILE" "$OUTPUT_DIR/default.packages.yaml"
    echo -e "${blue}Copied $DEFAULT_PACKAGES_FILE to $OUTPUT_DIR/default.packages.yaml${norm}"
    if [[ -n "$REPORT_FILE" && -f "$REPORT_FILE" ]]; then
        jq --arg status "$DPDY_STATUS" \
          '.plugins |= with_entries(.value.stages.dpdy = {status: $status})' \
          "$REPORT_FILE" > "${REPORT_FILE}.tmp" && mv "${REPORT_FILE}.tmp" "$REPORT_FILE"
    fi
else
    echo -e "\n${blue}=== Step 3: DPDY Generation — Skipped (no default.packages.yaml provided) ===${norm}"
    if [[ -n "$REPORT_FILE" && -f "$REPORT_FILE" ]]; then
        jq '.plugins |= with_entries(.value.stages.dpdy = {status: "skip"})' \
          "$REPORT_FILE" > "${REPORT_FILE}.tmp" && mv "${REPORT_FILE}.tmp" "$REPORT_FILE"
    fi
fi

##############################################
# Step 4: Generate catalog index
##############################################
echo -e "\n${green}=== Step 4: Generate catalog index ===${norm}"
# shellcheck disable=SC2086
if ! python "$SCRIPT_DIR/generateCatalogIndex.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --output-dir "$OUTPUT_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $REPORT_FILE_ARG \
    $DEBUG_FLAG; then
    echo -e "${red}[ERROR] generateCatalogIndex.py failed!${norm}" >&2; exit 1
fi

echo -e "\n${green}=== Done ===${norm}"
echo -e "${blue}Output: $OUTPUT_DIR${norm}"
echo -e "${blue}Plugin builds: $PLUGIN_BUILDS_DIR${norm}"
