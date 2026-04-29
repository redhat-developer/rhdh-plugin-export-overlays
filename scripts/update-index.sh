#!/usr/bin/env bash
#
# Copyright (c) Red Hat, Inc.
#
# Orchestrator script to generate plugin_builds/ and catalog-index/ directories.
#
# Usage examples:
#
#   # Community index (filtered by support level, no DPDY)
#   scripts/update-index.sh \
#     --overlays-dir . \
#     --registry ghcr.io/redhat-developer/rhdh-plugin-export-overlays \
#     --output-dir catalog-index/community \
#     --plugin-builds-dir plugin_builds/community \
#     --support-filter community
#
#   # Supported index (filtered by support level, with DPDY)
#   scripts/update-index.sh \
#     --overlays-dir . \
#     --registry quay.io/rhdh-community \
#     --output-dir catalog-index/supported \
#     --plugin-builds-dir plugin_builds/supported \
#     --support-filter generally-available tech-preview \
#     --packages-file catalog-index/default.packages.yaml
#
#   # Community index (legacy: filtered by package list files)
#   scripts/update-index.sh \
#     --overlays-dir . \
#     --registry ghcr.io/redhat-developer/rhdh-plugin-export-overlays \
#     --output-dir catalog-index/community \
#     --plugin-builds-dir plugin_builds/community \
#     --packages-filter rhdh-community-packages.txt \
#     --packages-file catalog-index/default.packages.yaml
#
#   # Midstream (quay.io/rhdh → registry.access.redhat.com)
#   scripts/update-index.sh \
#     --overlays-dir /path/to/overlay-repo \
#     --registry quay.io/rhdh \
#     --output-dir /path/to/catalog-index \
#     --plugin-builds-dir /path/to/plugin_builds \
#     --packages-file /path/to/catalog-index/default.packages.yaml

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

norm="\033[0;39m"
green="\033[1;32m"
red="\033[1;31m"
blue="\033[1;34m"

OVERLAYS_DIR=""
REGISTRY=""
OUTPUT_DIR=""
PLUGIN_BUILDS_DIR=""
PACKAGES_FILE=""
PACKAGES_FILTER=()
SUPPORT_FILTER=()
DEBUG_FLAG=""
DEBUG=0

usage() {
    cat <<'USAGE'
Orchestrator script to generate plugin_builds/ and catalog-index/.

Usage:
    update-index.sh \
        --overlays-dir PATH \
        --registry BASE \
        --output-dir PATH \
        --plugin-builds-dir PATH \
        [--packages-file PATH] \
        [--packages-filter FILE [FILE ...]] \
        [--support-filter LEVEL [LEVEL ...]] \
        [--debug] \
        [-h | --help]

Arguments:
  --overlays-dir       Path to overlays repo root (contains workspaces/)
  --registry           Registry base (e.g., ghcr.io/redhat-developer/rhdh-plugin-export-overlays)
  --output-dir         Output directory for catalog-index
  --plugin-builds-dir  Directory for plugin_builds/ JSON files
  --packages-file      Path to default.packages.yaml (optional; skips DPDY generation if omitted)
  --packages-filter    One or more package list files to filter by (mutually exclusive with --support-filter)
  --support-filter     One or more support levels to filter by (e.g., community, generally-available)
                       Mutually exclusive with --packages-filter.
  --debug              Enable debug output
USAGE
    exit 1
}

while [[ "$#" -gt 0 ]]; do
    case $1 in
    '--overlays-dir')
        OVERLAYS_DIR="$2"
        shift 2
        ;;
    '--registry')
        REGISTRY="$2"
        shift 2
        ;;
    '--output-dir')
        OUTPUT_DIR="$2"
        shift 2
        ;;
    '--plugin-builds-dir')
        PLUGIN_BUILDS_DIR="$2"
        shift 2
        ;;
    '--packages-file')
        PACKAGES_FILE="$2"
        shift 2
        ;;
    '--packages-filter')
        shift 1
        while [[ "$#" -gt 0 ]] && [[ "$1" != --* ]]; do
            PACKAGES_FILTER+=("$1")
            shift 1
        done
        ;;
    '--support-filter')
        shift 1
        while [[ "$#" -gt 0 ]] && [[ "$1" != --* ]]; do
            SUPPORT_FILTER+=("$1")
            shift 1
        done
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
        echo -e "${red}[ERROR] Invalid parameter: $1${norm}"
        echo
        usage
        ;;
    esac
done

# Validate required args
if [[ -z "$OVERLAYS_DIR" ]] || [[ -z "$REGISTRY" ]] || [[ -z "$OUTPUT_DIR" ]] || [[ -z "$PLUGIN_BUILDS_DIR" ]]; then
    echo -e "${red}[ERROR] Missing required arguments${norm}\n"
    usage
fi

# Validate mutual exclusivity
if [[ ${#PACKAGES_FILTER[@]} -gt 0 ]] && [[ ${#SUPPORT_FILTER[@]} -gt 0 ]]; then
    echo -e "${red}[ERROR] --packages-filter and --support-filter are mutually exclusive${norm}"
    exit 1
fi

# Build filter args
FILTER_ARGS=""
if [[ ${#PACKAGES_FILTER[@]} -gt 0 ]]; then
    FILTER_ARGS="--packages-filter ${PACKAGES_FILTER[*]}"
fi

SUPPORT_FILTER_ARGS=""
if [[ ${#SUPPORT_FILTER[@]} -gt 0 ]]; then
    SUPPORT_FILTER_ARGS="--support-filter ${SUPPORT_FILTER[*]}"
fi

if [[ $DEBUG -eq 1 ]]; then
    echo "#################################"
    echo "OVERLAYS_DIR     = $OVERLAYS_DIR"
    echo "REGISTRY         = $REGISTRY"
    echo "OUTPUT_DIR       = $OUTPUT_DIR"
    echo "PLUGIN_BUILDS_DIR = $PLUGIN_BUILDS_DIR"
    echo "PACKAGES_FILE    = $PACKAGES_FILE"
    echo "PACKAGES_FILTER  = ${PACKAGES_FILTER[*]:-<none>}"
    echo "SUPPORT_FILTER   = ${SUPPORT_FILTER[*]:-<none>}"
    echo "#################################"
fi

##############################################
# Step 1: Bootstrap plugin_builds/ from metadata
##############################################
echo -e "\n${green}=== Step 1: Bootstrap plugin_builds/ from metadata ===${norm}"
# shellcheck disable=SC2086
python3 "$SCRIPT_DIR/bootstrapPluginBuilds.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $FILTER_ARGS \
    $SUPPORT_FILTER_ARGS \
    $DEBUG_FLAG
if [[ $? -ne 0 ]]; then echo -e "${red}[ERROR] bootstrapPluginBuilds.py failed!${norm}"; exit 1; fi

##############################################
# Step 2: Enrich plugin_builds/ with registry metadata
##############################################
echo -e "\n${green}=== Step 2: Enrich plugin_builds/ with registry metadata ===${norm}"
# shellcheck disable=SC2086
python3 "$SCRIPT_DIR/generatePluginBuildInfo.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $DEBUG_FLAG
if [[ $? -ne 0 ]]; then echo -e "${red}[ERROR] generatePluginBuildInfo.py failed!${norm}"; exit 1; fi

##############################################
# Step 3: Generate dynamic-plugins.default.yaml
##############################################
if [[ -n "$PACKAGES_FILE" ]]; then
    echo -e "\n${green}=== Step 3: Generate dynamic-plugins.default.yaml ===${norm}"
    mkdir -p "$OUTPUT_DIR"
    # shellcheck disable=SC2086
    "$SCRIPT_DIR/generateDynamicPluginsDefaultYaml.sh" \
        --packages-file "$PACKAGES_FILE" \
        --output-file "$OUTPUT_DIR/dynamic-plugins.default.yaml" \
        --overlays-dir "$OVERLAYS_DIR" \
        $DEBUG_FLAG
    if [[ $? -ne 0 ]]; then echo -e "${red}[ERROR] generateDynamicPluginsDefaultYaml.sh failed!${norm}"; exit 1; fi
else
    echo -e "\n${blue}=== Step 3: Skipped (no --packages-file provided) ===${norm}"
fi

##############################################
# Step 4: Generate catalog index
##############################################
echo -e "\n${green}=== Step 4: Generate catalog index ===${norm}"
# shellcheck disable=SC2086
python3 "$SCRIPT_DIR/generateCatalogIndex.py" \
    --overlays-dir "$OVERLAYS_DIR" \
    --output-dir "$OUTPUT_DIR" \
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR" \
    --registry "$REGISTRY" \
    $DEBUG_FLAG
if [[ $? -ne 0 ]]; then echo -e "${red}[ERROR] generateCatalogIndex.py failed!${norm}"; exit 1; fi

echo -e "\n${green}=== Done ===${norm}"
echo -e "${blue}Output: $OUTPUT_DIR${norm}"
echo -e "${blue}Plugin builds: $PLUGIN_BUILDS_DIR${norm}"
