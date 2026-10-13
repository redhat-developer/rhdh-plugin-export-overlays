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
#     --registry quay.io/rhdh \
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
#   # Midstream product index
#   scripts/update-index.sh \
#     --overlays-dir /path/to/overlay-repo \
#     --registry registry.access.redhat.com/rhdh \
#     --community-registry ghcr.io/redhat-developer/rhdh-plugin-export-overlays \
#     --output-dir /path/to/catalog-index \
#     --plugin-builds-dir /path/to/plugin_builds \
#     --packages-file /path/to/catalog-index/default.packages.yaml \
#     --packages-file /path/to/rhdh-supported-packages.txt \
#     --validate-mode gate
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
COMMUNITY_REGISTRY=""
OUTPUT_DIR="catalog-index"
PLUGIN_BUILDS_DIR="plugin_builds"
PACKAGES_FILES=()
REPORT_FILE=""
# The registry policy is always a hard gate. The other Step 5 checks default to
# "report" because some existing findings still need triage; use "gate" to fail on
# those too (see user-guide/07-plugin-catalog-index.md).
VALIDATE_MODE="report"
VALIDATE_ALLOWLIST=""
VALIDATION_JSON=""
SANITY_CHECK=0
DEBUG_FLAG=""
DEBUG=0
STRICT=0
ALLOW_WARNINGS=()
PREVIOUS_INDEX_REF=""

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
        [--strict] [--allow-warnings RULE] [--previous-index-ref REF] \
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
                               (default: same as --registry)
  -p,  --packages-file         Package list file (YAML or txt). Can be specified multiple times.
                               Files are unioned. Supports default.packages.yaml (npm names)
                               and txt files with workspace paths (e.g., rhdh-supported-packages.txt).
                               DPDY generation runs only when a file named default.packages.yaml is provided.
       --report-file           Path to build-report.json for tracking generation stages (optional).
                               An existing file is removed at the start of the run.
                               Stages from a previous index are not carried forward.
       --validate-mode         Other Step 5 static validation rules (no network).
                               One of:
                                 report (default) — print findings without failing
                                 gate             — fail on any validation error
                                 off              — skip these rules
                               Registry policy always runs and fails on a mismatch.
       --validate-allowlist    Ticketed exceptions file for Step 5
                               (default: scripts/catalog-index-validation-allowlist.txt)
       --validation-json       Write the Step 5 findings as JSON to this path (optional).
       --strict                Treat validation warnings as errors and fail the build.
                               Passed through to validateCatalogIndex.py. On
                               release-* the workflow sets this with --validate-mode gate.
       --allow-warnings        Keep this warning rule non-fatal even under --strict.
                               Repeatable. Passed through to validateCatalogIndex.py.
                               The generate-catalog-index workflow uses this for a
                               release-* emergency rollback (version-regression only).
       --previous-index-ref    OCI ref or local DPDY/dir/index.json for version-regression.
                               OCI refs are extracted with extractCatalogIndex.sh
                               into a directory (DPDY + index.json) before Step 5
                               (the validator itself does not use the network).
                               A missing extractor toolchain (skopeo/jq/tar) or a
                               copy/auth/network failure fails the build. A confirmed
                               missing previous image skips version-regression with
                               a warning.
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
    '--strict')
        STRICT=1
        shift 1
        ;;
    '--allow-warnings')
        ALLOW_WARNINGS+=("$2")
        shift 2
        ;;
    '--previous-index-ref')
        PREVIOUS_INDEX_REF="$2"
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

# With no community override, community packages use the same base as every other
# support tier. This keeps --registry alone sufficient for a single-registry index.
if [[ -z "$COMMUNITY_REGISTRY" ]]; then
    COMMUNITY_REGISTRY="$REGISTRY"
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
    echo "STRICT             = $STRICT"
    echo "ALLOW_WARNINGS     = ${ALLOW_WARNINGS[*]:-<none>}"
    echo "PREVIOUS_INDEX_REF = ${PREVIOUS_INDEX_REF:-<none>}"
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
    # The report is the output of this run. BuildReport loads an existing file and
    # set_stage replaces only the stage it owns, so a renamed stage (registry-enrich)
    # or a validate warning from an earlier fetch would otherwise survive a clean run.
    # Delete before Step 1; bootstrap is the first writer and must start empty.
    if [[ -e "$REPORT_FILE" ]]; then
        echo -e "${blue}[INFO] Removing previous build report so this run starts empty: $REPORT_FILE${norm}"
        rm -f -- "$REPORT_FILE"
    fi
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
# This policy is unconditional: report/off only control the other validation
# findings. A wrong registry must fail before downstream can scrub the ref away.
echo -e "\n${green}=== Step 5a: Enforce registry policy ===${norm}"
REGISTRY_POLICY_ARGS=(
    --output-dir "$OUTPUT_DIR"
    --plugin-builds-dir "$PLUGIN_BUILDS_DIR"
    --registry "$REGISTRY"
    --registry-policy-only
)
if [[ "$COMMUNITY_REGISTRY" != "$REGISTRY" ]]; then
    REGISTRY_POLICY_ARGS+=(--community-registry "$COMMUNITY_REGISTRY")
fi
if ! python "$SCRIPT_DIR/validateCatalogIndex.py" "${REGISTRY_POLICY_ARGS[@]}"; then
    echo -e "${red}[ERROR] Catalog registry policy failed${norm}" >&2
    exit 1
fi

if [[ "$VALIDATE_MODE" == "off" ]]; then
    echo -e "\n${blue}=== Step 5: Validation — Skipped (--validate-mode off) ===${norm}"
else
    echo -e "\n${green}=== Step 5: Validate the generated catalog index ===${norm}"
    VALIDATE_ARGS=(
        --output-dir "$OUTPUT_DIR"
        --plugin-builds-dir "$PLUGIN_BUILDS_DIR"
        --registry "$REGISTRY"
    )
    # Community-tier packages use a separate, exact registry base.
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
    if [[ "$STRICT" -eq 1 ]]; then
        VALIDATE_ARGS+=(--strict)
    fi
    for rule in "${ALLOW_WARNINGS[@]}"; do
        VALIDATE_ARGS+=(--allow-warnings "$rule")
    done
    if [[ -n "$DEFAULT_PACKAGES_FILE" ]]; then
        VALIDATE_ARGS+=(--default-packages-file "$DEFAULT_PACKAGES_FILE")
    fi
    PREV_EXTRACTED=""
    if [[ -n "$PREVIOUS_INDEX_REF" ]]; then
        PREV_DPDY=""
        if [[ -f "$PREVIOUS_INDEX_REF" ]]; then
            PREV_DPDY="$PREVIOUS_INDEX_REF"
        elif [[ -d "$PREVIOUS_INDEX_REF" ]]; then
            # Pass the directory so the validator can prefer index.json imageTag
            # over a digest-only DPDY (the published catalog shape).
            PREV_DPDY="$PREVIOUS_INDEX_REF"
        else
            PREV_DIR="$OUTPUT_DIR/.previous-index"
            mkdir -p "$PREV_DIR"
            EXTRACT_RC=0
            "$SCRIPT_DIR/extractCatalogIndex.sh" "$PREVIOUS_INDEX_REF" "$PREV_DIR" || EXTRACT_RC=$?
            if [[ "$EXTRACT_RC" -eq 0 ]]; then
                PREV_EXTRACTED="$PREV_DIR"
                PREV_DPDY="$PREV_DIR"
            elif [[ "$EXTRACT_RC" -ge 2 ]]; then
                # Exit 2 is a missing toolchain (skopeo/jq/tar) or usage error.
                # Exit 3 is a copy/auth/network failure or an image that exists
                # but carries neither catalog file. Treating either as "image not
                # found" would skip version-regression and publish a catalog the
                # gate never compared.
                echo -e "${red}[ERROR] Cannot extract previous catalog index from $PREVIOUS_INDEX_REF (extractCatalogIndex.sh exit ${EXTRACT_RC}); version-regression cannot run${norm}" >&2
                exit 1
            else
                echo -e "${yellow}[WARN] Previous catalog index not found at $PREVIOUS_INDEX_REF; skipping version-regression${norm}" >&2
                PREV_DPDY=""
            fi
        fi
        if [[ -n "$PREV_DPDY" ]]; then
            VALIDATE_ARGS+=(--previous-index-dpdy "$PREV_DPDY")
        fi
    fi

    VALIDATE_RC=0
    python "$SCRIPT_DIR/validateCatalogIndex.py" "${VALIDATE_ARGS[@]}" || VALIDATE_RC=$?
    if [[ -n "$PREV_EXTRACTED" ]]; then
        rm -rf "$PREV_EXTRACTED"
    fi

    # Exit 2 is a USAGE error (a path that escapes the working directory, a missing
    # --registry) — not a finding about the index. Report mode must not swallow it:
    # continuing would run the rest of the pipeline on arguments the validator refused.
    if [[ $VALIDATE_RC -ge 2 ]]; then
        echo -e "${red}[ERROR] validateCatalogIndex.py rejected its arguments (exit $VALIDATE_RC)${norm}" >&2
        exit 1
    fi

    if [[ $VALIDATE_RC -ne 0 ]]; then
        if [[ "$VALIDATE_MODE" == "gate" || "$STRICT" -eq 1 ]]; then
            echo -e "${red}[ERROR] Catalog index validation failed (--validate-mode ${VALIDATE_MODE})${norm}" >&2
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
