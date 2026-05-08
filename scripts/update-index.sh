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
                               DPDY generation uses only the first .yaml file.
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
    echo "#################################"
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
if ! python3 "$SCRIPT_DIR/bootstrapPluginBuilds.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $RHDH_VERSION_ARG \
    $BOOTSTRAP_FILTER_ARGS \
    $COMMUNITY_REGISTRY_ARG \
    $DEBUG_FLAG; then
    echo -e "${red}[ERROR] bootstrapPluginBuilds.py failed!${norm}" >&2; exit 1
fi

##############################################
# Step 2: Enrich plugin_builds/ with registry metadata
##############################################
echo -e "\n${green}=== Step 2: Enrich plugin_builds/ with registry metadata ===${norm}"
# shellcheck disable=SC2086
if ! python3 "$SCRIPT_DIR/generatePluginBuildInfo.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $DEBUG_FLAG; then
    echo -e "${red}[ERROR] generatePluginBuildInfo.py failed!${norm}" >&2; exit 1
fi

##############################################
# Step 3: Generate dynamic-plugins.default.yaml
##############################################
# DPDY only uses the first .yaml file (needs enabled/disabled structure)
DPDY_PACKAGES_FILE=""
for pf in "${PACKAGES_FILES[@]+"${PACKAGES_FILES[@]}"}"; do
    if [[ "$pf" == *.yaml ]] || [[ "$pf" == *.yml ]]; then
        DPDY_PACKAGES_FILE="$pf"
        break
    fi
done

if [[ -n "$DPDY_PACKAGES_FILE" ]]; then
    echo -e "\n${green}=== Step 3: Generate dynamic-plugins.default.yaml ===${norm}"
    mkdir -p "$OUTPUT_DIR"
    # shellcheck disable=SC2086
    if ! "$SCRIPT_DIR/generateDynamicPluginsDefaultYaml.sh" \
        --packages-file "$DPDY_PACKAGES_FILE" \
        --output-file "$OUTPUT_DIR/dynamic-plugins.default.yaml" \
        --overlays-dir "$OVERLAYS_DIR" \
        $DEBUG_FLAG; then
        echo -e "${red}[ERROR] generateDynamicPluginsDefaultYaml.sh failed!${norm}" >&2; exit 1
    fi
else
    echo -e "\n${blue}=== Step 3: Skipped (no .yaml packages file provided) ===${norm}"
fi

##############################################
# Step 4: Generate catalog index
##############################################
echo -e "\n${green}=== Step 4: Generate catalog index ===${norm}"
PACKAGES_FILE_ARGS=""
for pf in "${PACKAGES_FILES[@]+"${PACKAGES_FILES[@]}"}"; do
    PACKAGES_FILE_ARGS="$PACKAGES_FILE_ARGS --packages-file $pf"
done
# shellcheck disable=SC2086
if ! python3 "$SCRIPT_DIR/generateCatalogIndex.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --output-dir "$OUTPUT_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $PACKAGES_FILE_ARGS \
    $DEBUG_FLAG; then
    echo -e "${red}[ERROR] generateCatalogIndex.py failed!${norm}" >&2; exit 1
fi

echo -e "\n${green}=== Done ===${norm}"
echo -e "${blue}Output: $OUTPUT_DIR${norm}"
echo -e "${blue}Plugin builds: $PLUGIN_BUILDS_DIR${norm}"
