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
#
#   # Fail the run on a validation error, and additionally install+boot every package
#   # the generated index declares (needs Node 24, Yarn 4 and registry access)
#   scripts/update-index.sh \
#     --registry ghcr.io/redhat-developer/rhdh-plugin-export-overlays \
#     --output-dir catalog-index/supported \
#     --plugin-builds-dir plugin_builds/supported \
#     --packages-file default.packages.yaml \
#     --validate-mode gate \
#     --validate-allowlist scripts/catalog-index-validation-allowlist.txt \
#     --validation-json catalog-index/supported/validation.json \
#     --sanity-check

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

norm="\033[0;39m"
green="\033[1;32m"
red="\033[1;31m"
yellow="\033[1;33m"
blue="\033[1;34m"

OVERLAYS_DIR="."
REGISTRY=""
RHDH_VERSION=""
COMMUNITY_REGISTRY="ghcr.io/redhat-developer/rhdh-plugin-export-overlays"
OUTPUT_DIR="catalog-index"
PLUGIN_BUILDS_DIR="plugin_builds"
PACKAGES_FILES=()
REPORT_FILE=""
# Step 5 (static validation) runs on every generation. It defaults to "report" rather
# than "gate" deliberately: the check is new, and the indexes it runs against today
# carry findings nobody has triaged yet (see user-guide/07-plugin-catalog-index.md).
# Landing it as a hard gate would turn those into a red build for work unrelated to
# whoever pushed. Flip to "gate" once the standing findings are fixed or allowlisted.
VALIDATE_MODE="report"
VALIDATE_ALLOWLIST=""
VALIDATION_JSON=""
SANITY_CHECK=0
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
        [--validate-mode report|gate|off] \
        [--validate-allowlist PATH] [--validation-json PATH] \
        [--sanity-check] \
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
       --validate-mode         Step 5, static validation of the generated index
                               (no network). One of:
                                 report (default) — always run, never fail the build
                                 gate             — fail on any validation error
                                 off              — skip validation entirely
       --validate-allowlist    Ticketed exceptions file for Step 5
                               (default: scripts/catalog-index-validation-allowlist.txt)
       --validation-json       Write the Step 5 findings as JSON to this path (optional).
       --sanity-check          Step 6, install and boot every package the generated
                               index declares, via smoke-tests-native. Off by default:
                               it pulls every artifact and needs Node 24 + Yarn 4, which
                               the midstream update-index job has neither the budget nor
                               the toolchain for. See the catalog-index-sanity workflow.
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
    '--validate-mode')
        VALIDATE_MODE="$2"
        shift 2
        ;;
    '--validate-allowlist')
        VALIDATE_ALLOWLIST="$2"
        shift 2
        ;;
    '--validation-json')
        VALIDATION_JSON="$2"
        shift 2
        ;;
    '--sanity-check')
        SANITY_CHECK=1
        shift 1
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

# Rejected here rather than at Step 5: a typo would otherwise be discovered after the
# whole generation has run, and "report" is close enough to a silent skip that a
# mistyped mode must never fall back to it.
case "$VALIDATE_MODE" in
    report|gate|off) ;;
    *)
        echo -e "${red}[ERROR] Invalid --validate-mode: $VALIDATE_MODE (expected report, gate or off)${norm}\n" >&2
        usage
        ;;
esac

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
    echo "VALIDATE_MODE      = $VALIDATE_MODE"
    echo "SANITY_CHECK       = $SANITY_CHECK"
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

##############################################
# Step 5: Validate the generated index (static, no network)
##############################################
if [[ "$VALIDATE_MODE" == "off" ]]; then
    echo -e "\n${blue}=== Step 5: Validation — Skipped (--validate-mode off) ===${norm}"
else
    echo -e "\n${green}=== Step 5: Validate the generated catalog index ===${norm}"
    VALIDATE_ARGS=(
        --output-dir "$OUTPUT_DIR"
        --plugin-builds-dir "$PLUGIN_BUILDS_DIR"
        --registry "$REGISTRY"
    )
    # The supported index legitimately mixes in community-tier packages from a second
    # registry; without this they would all read as registry-not-allowed.
    if [[ "$COMMUNITY_REGISTRY" != "$REGISTRY" ]]; then
        VALIDATE_ARGS+=(--community-registry "$COMMUNITY_REGISTRY")
    fi
    if [[ -n "$VALIDATE_ALLOWLIST" ]]; then
        VALIDATE_ARGS+=(--allowlist "$VALIDATE_ALLOWLIST")
    fi
    if [[ -n "$VALIDATION_JSON" ]]; then
        VALIDATE_ARGS+=(--json "$VALIDATION_JSON")
    fi
    if [[ -n "$REPORT_FILE" ]]; then
        VALIDATE_ARGS+=(--report-file "$REPORT_FILE")
    fi
    if [[ -n "$DEBUG_FLAG" ]]; then
        VALIDATE_ARGS+=("$DEBUG_FLAG")
    fi

    VALIDATE_RC=0
    python "$SCRIPT_DIR/validateCatalogIndex.py" "${VALIDATE_ARGS[@]}" || VALIDATE_RC=$?

    # Exit 2 is a USAGE error (a path that escapes the working directory, a missing
    # --registry) — not a finding about the index. Report mode must not swallow it:
    # continuing would run the rest of the pipeline on arguments the validator refused.
    if [[ $VALIDATE_RC -ge 2 ]]; then
        echo -e "${red}[ERROR] validateCatalogIndex.py rejected its arguments (exit $VALIDATE_RC)${norm}" >&2
        exit 1
    fi

    if [[ $VALIDATE_RC -ne 0 ]]; then
        if [[ "$VALIDATE_MODE" == "gate" ]]; then
            echo -e "${red}[ERROR] Catalog index validation failed (--validate-mode gate)${norm}" >&2
            exit 1
        fi
        # Deliberately not fatal in report mode — see VALIDATE_MODE above. Say so
        # explicitly, so a reader of the log does not mistake the findings for a
        # failure that was swallowed.
        echo -e "${yellow}[WARN] Catalog index validation reported errors; continuing because --validate-mode is '$VALIDATE_MODE'.${norm}" >&2
        echo -e "${yellow}[WARN] Re-run with --validate-mode gate to fail the build on these.${norm}" >&2
    fi
fi

##############################################
# Step 6: Catalog index sanity check (install + boot every declared package)
##############################################
if [[ $SANITY_CHECK -eq 1 ]]; then
    echo -e "\n${green}=== Step 6: Catalog index sanity check ===${norm}"
    SANITY_DIR="$SCRIPT_DIR/../smoke-tests-native"
    SANITY_INDEX="$OUTPUT_DIR/dynamic-plugins.default.yaml"
    if [[ ! -f "$SANITY_INDEX" ]]; then
        echo -e "${red}[ERROR] $SANITY_INDEX not found — nothing to sanity check.${norm}" >&2
        echo -e "${red}        (Step 3 only runs when a default.packages.yaml is passed.)${norm}" >&2
        exit 1
    fi
    if [[ ! -d "$SANITY_DIR" ]]; then
        echo -e "${red}[ERROR] $SANITY_DIR not found — the sanity check needs the smoke-tests-native harness.${norm}" >&2
        exit 1
    fi

    # Resolve BEFORE the subshell. Inside `( cd "$SANITY_DIR" && … && yarn smoke … )`
    # the words of `yarn smoke` are expanded only when it is about to run — that is,
    # after the cd — so a command substitution here would resolve against
    # smoke-tests-native/ instead of the caller's directory. With a relative
    # --output-dir (the default) the inner cd then fails, the substitution yields the
    # empty string, and the harness is handed "/dynamic-plugins.default.yaml". A failed
    # command substitution does not trip `set -e`, so nothing caught it.
    SANITY_INDEX_ABS="$(cd "$(dirname "$SANITY_INDEX")" && pwd)/$(basename "$SANITY_INDEX")"

    # Check what the error message claims. `command -v yarn` passes for a globally
    # installed Yarn 1, which then dies inside the subshell with "Unsupported option
    # name (--immutable)" — attributed to the sanity check rather than to the toolchain.
    SANITY_NODE_MAJOR="$(node --version 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p')"
    SANITY_YARN_MAJOR="$(yarn --version 2>/dev/null | cut -d. -f1)"
    if [[ -z "$SANITY_NODE_MAJOR" || "$SANITY_NODE_MAJOR" -lt 24 ]]; then
        echo -e "${red}[ERROR] --sanity-check needs Node 24+ on PATH (found: ${SANITY_NODE_MAJOR:-none}); see smoke-tests-native/README.md${norm}" >&2
        exit 1
    fi
    if [[ -z "$SANITY_YARN_MAJOR" || "$SANITY_YARN_MAJOR" -lt 4 ]]; then
        echo -e "${red}[ERROR] --sanity-check needs Yarn 4+ on PATH (found: ${SANITY_YARN_MAJOR:-none}); enable corepack, see smoke-tests-native/README.md${norm}" >&2
        exit 1
    fi

    # Split from the run so an install failure is not reported as a plugin failure
    # pointing at a results.json that was never written.
    # --mode=skip-build so no dependency runs an install script; better-sqlite3 is then
    # rebuilt by name because startTestBackend cannot boot without its native binding.
    if ! (cd "$SANITY_DIR" && yarn install --immutable --mode=skip-build \
        && yarn rebuild better-sqlite3); then
        echo -e "${red}[ERROR] yarn install failed in $SANITY_DIR — the sanity check did not run.${norm}" >&2
        exit 1
    fi
    # --out is contained to the harness's own directory by the harness (Sonar S8707),
    # so the results file is written there and reported by path afterwards.
    if ! (cd "$SANITY_DIR" && yarn smoke \
        --catalog-index "$SANITY_INDEX_ABS" \
        --exclusions catalog-index-sanity-excludes.txt \
        --out results-catalog-index.json); then
        echo -e "${red}[ERROR] Catalog index sanity check failed — see $SANITY_DIR/results-catalog-index.json${norm}" >&2
        exit 1
    fi
    echo -e "${blue}Sanity check results: $SANITY_DIR/results-catalog-index.json${norm}"
else
    echo -e "\n${blue}=== Step 6: Catalog index sanity check — Skipped (pass --sanity-check to run it) ===${norm}"
fi

echo -e "\n${green}=== Done ===${norm}"
echo -e "${blue}Output: $OUTPUT_DIR${norm}"
echo -e "${blue}Plugin builds: $PLUGIN_BUILDS_DIR${norm}"

# Last thing logged: clear CTA to rebuild plugins still on older fallback tags
python -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
from pathlib import Path
from generatePluginBuildInfo import collect_fallback_entries, print_fallback_rebuild_cta
print_fallback_rebuild_cta(collect_fallback_entries(Path('$PLUGIN_BUILDS_DIR')))
"
