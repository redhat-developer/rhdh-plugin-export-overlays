#!/usr/bin/env python3
#
# Copyright (c) Red Hat, Inc.
#
# Generate initial plugin_builds/<workspace>/<stem>.json files from
# workspace metadata (workspaces/*/metadata/*.yaml).
#
# This replaces the bootstrap logic in sync-midstream.sh that reads
# package.json from cloned workspace sources — we derive the same
# information from the metadata YAML files instead.

import argparse
import json
import sys
from pathlib import Path

import yaml

from plugin_utils import (
    BuildReport,
    Colors,
    log_debug,
    log_info,
    log_warn,
    log_error,
    set_debug,
    build_workspace_mappings,
    load_and_resolve_to_npm_names,
)


def versions_match_minor(v1: str, v2: str) -> bool:
    """Check if two semver strings share the same major.minor version.
    Returns False for empty or malformed versions.
    """
    if not v1 or not v2:
        return False
    parts1 = v1.split(".")[:2]
    parts2 = v2.split(".")[:2]
    return len(parts1) == 2 and len(parts2) == 2 and parts1 == parts2


def get_outdated_workspaces(
    workspace_dirs: list[Path],
    backstage_version: str,
) -> dict[str, dict[str, str]]:
    """Identify workspaces whose effective backstage version doesn't match the target minor.

    For each workspace, the effective version is determined by:
    1. backstage.json (override) if it exists
    2. source.json repo-backstage-version otherwise

    Returns a dict mapping workspace name to {"expected": ..., "found": ...} for mismatches.
    """
    outdated = {}
    for workspace_dir in workspace_dirs:
        ws_name = workspace_dir.name
        effective_version = ""
        source_json = workspace_dir / "source.json"
        backstage_json = workspace_dir / "backstage.json"

        if backstage_json.exists():
            try:
                with open(backstage_json, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    effective_version = data.get("version", "")
            except (json.JSONDecodeError, OSError) as e:
                log_warn(f"Malformed backstage.json in workspace {ws_name}: {e}")
        elif source_json.exists():
            try:
                with open(source_json, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    effective_version = data.get("repo-backstage-version", "")
            except (json.JSONDecodeError, OSError) as e:
                log_warn(f"Malformed source.json in workspace {ws_name}: {e}")
        else:
            log_warn(f"No source.json or backstage.json found in workspace {ws_name}")

        if not effective_version:
            log_warn(f"Missing backstage version for workspace {ws_name}, treating as outdated")
            outdated[ws_name] = {"expected": backstage_version, "found": "missing"}
        elif not versions_match_minor(effective_version, backstage_version):
            outdated[ws_name] = {"expected": backstage_version, "found": effective_version}

    return outdated


def package_name_to_image_name(package_name: str) -> str:
    """Convert an npm package name to an OCI image name.
    e.g., '@red-hat-developer-hub/backstage-plugin-foo' → 'red-hat-developer-hub-backstage-plugin-foo'
    """
    return package_name.lstrip('@').replace('/', '-')


def parse_dynamic_artifact(dynamic_artifact: str) -> str:
    """
    Extract a bare registry reference from a dynamicArtifact value.
    Strips 'oci://' prefix and '!fragment' suffix.
    Returns empty string for local paths.
    """
    if not dynamic_artifact or dynamic_artifact.startswith('./'):
        return ""

    ref = dynamic_artifact
    if ref.startswith('oci://'):
        ref = ref[len('oci://'):]
    if '!' in ref:
        ref = ref.split('!')[0]
    return ref


def construct_registry_reference(
    registry_base: str,
    image_name: str,
    version: str,
    backstage_version: str,
    rhdh_version: str,
    dynamic_artifact: str,
) -> str:
    """
    Construct a registryReference for a plugin from version fields.
    Always constructs a tag-based ref from spec.version + rhdh_version/backstage_version:
      - ghcr.io: bs_{backstage_version}__{version}
      - quay.io/rhdh: {rhdh_version}--{version}
    """
    existing_ref = parse_dynamic_artifact(dynamic_artifact)
    if existing_ref and '@' in existing_ref:
        log_warn(f"metadata's dynamicArtifact contains digest instead of tag: {dynamic_artifact}")

    if 'ghcr.io' in registry_base:
        tag = f"bs_{backstage_version}__{version}"
    else:
        tag = f"{rhdh_version}--{version}"

    return f"{registry_base}/{image_name}:{tag}"


def main():
    usage="""
Usage: python3 bootstrapPluginBuilds.py [--debug] \\
    -r|--registry image-registry \\
    [-d|--overlays-dir PATH] \\
    [-b|--plugin-builds-dir PATH] \\
    [-v|--rhdh-version VERSION] \\
    [-cr|--community-registry BASE] \\
    [-p|--packages-file FILE ...]

Examples:

    # Supported plugins from multiple package list files
    python3 bootstrapPluginBuilds.py \\
        -b plugin_builds/supported \\
        -r quay.io/rhdh \\
        -cr ghcr.io/redhat-developer/rhdh-plugin-export-overlays \\
        -v 1.10 \\
        -p catalog-index/default.packages.yaml \\
        -p rhdh-supported-packages.txt

    # Community plugins (no --rhdh-version needed)
    python3 bootstrapPluginBuilds.py \\
        -b plugin_builds/community \\
        -r ghcr.io/redhat-developer/rhdh-plugin-export-overlays \\
        -p rhdh-community-packages.txt
"""

    parser = argparse.ArgumentParser(
        description='Bootstrap plugin_builds/ from workspace metadata.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=usage
    )
    parser.error = lambda msg: (print(f"\n{Colors.RED}[ERROR] {msg}{Colors.NORM}\n{usage}", file=sys.stderr), sys.exit(2))
    parser.add_argument(
        '-d', '--overlays-dir',
        type=str,
        default='.',
        metavar='PATH',
        help='Path to overlays directory containing workspaces/ (default: .)',
    )
    parser.add_argument(
        '-b', '--plugin-builds-dir',
        type=str,
        default='plugin_builds',
        metavar='PATH',
        help='Output directory for plugin_builds/ (default: plugin_builds)',
    )
    parser.add_argument(
        '-r', '--registry',
        type=str,
        required=True,
        metavar='BASE',
        help='Registry base for constructing registryReference (e.g., ghcr.io/redhat-developer/rhdh-plugin-export-overlays)',
    )
    parser.add_argument(
        '-v', '--rhdh-version',
        type=str,
        metavar='VERSION',
        help='RHDH version for non-ghcr.io tag convention (e.g., 1.5). Required when registry is not ghcr.io.',
    )
    parser.add_argument(
        '-p', '--packages-file',
        type=str,
        action='append',
        metavar='FILE',
        help='Package list file to filter plugins. Can be specified multiple times. '
             'Accepts YAML (default.packages.yaml format with npm names) or txt '
             '(workspace paths, one per line). Packages from all files are unioned.',
    )
    parser.add_argument(
        '-cr', '--community-registry',
        type=str,
        metavar='BASE',
        default='ghcr.io/redhat-developer/rhdh-plugin-export-overlays',
        help='Registry base for community-tier plugins '
             '(default: ghcr.io/redhat-developer/rhdh-plugin-export-overlays). '
             'Community plugins use this registry instead of --registry.',
    )
    parser.add_argument(
        '--report-file',
        type=str,
        metavar='PATH',
        help='Path to build-report.json for tracking generation stages (optional)',
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug output',
    )

    args = parser.parse_args()
    set_debug(args.debug)

    overlays_dir = Path(args.overlays_dir)
    plugin_builds_dir = Path(args.plugin_builds_dir)
    registry_base = args.registry.rstrip('/')
    community_registry = args.community_registry.rstrip('/')
    rhdh_version = args.rhdh_version or ""

    if 'ghcr.io' not in registry_base and not rhdh_version:
        log_error("--rhdh-version is required when registry is not ghcr.io")
        sys.exit(1)

    if community_registry != registry_base:
        log_info(f"Community plugins will use registry: {community_registry}")

    if not overlays_dir.exists():
        log_error(f"Overlays directory not found: {overlays_dir}")
        sys.exit(1)

    workspaces_dir = overlays_dir / "workspaces"
    if not workspaces_dir.exists():
        log_error(f"Workspaces directory not found: {workspaces_dir}")
        sys.exit(1)

    # Load backstage version from versions.json
    versions_file = overlays_dir / "versions.json"
    backstage_version = ""
    if versions_file.exists():
        with open(versions_file, 'r', encoding='utf-8') as f:
            versions = json.load(f)
            backstage_version = versions.get("backstage", "")
    if not backstage_version:
        log_warn("Could not read backstage version from versions.json")

    # Load packages filter
    packages_set = None
    if args.packages_file:
        packages_set = load_and_resolve_to_npm_names(args.packages_file, overlays_dir)
        log_info(f"Filtering to {len(packages_set)} packages from {len(args.packages_file)} file(s)")

    report = BuildReport(args.report_file)

    print(f"\n{Colors.GREEN}=== Bootstrap plugin_builds from workspace metadata ==={Colors.NORM}\n")

    # Build workspace mappings upfront for stem → workspace path resolution
    ws_mappings = build_workspace_mappings(overlays_dir)

    # Find all workspace directories with metadata
    workspace_dirs = sorted([
        d for d in workspaces_dir.iterdir()
        if d.is_dir() and (d / "metadata").is_dir()
    ])

    # Pre-compute outdated workspaces (backstage minor version mismatch)
    outdated_workspaces = get_outdated_workspaces(workspace_dirs, backstage_version)
    if outdated_workspaces:
        log_warn(f"Found {len(outdated_workspaces)} workspace(s) with backstage version mismatch:")
        for ws_name, info in sorted(outdated_workspaces.items()):
            log_warn(f"  {ws_name}: expected {info['expected']}, found {info['found']}")

    created_count = 0
    updated_count = 0
    skipped_count = 0
    bs_mismatch_count = 0
    no_ref_count = 0

    for workspace_dir in workspace_dirs:
        workspace_name = workspace_dir.name
        metadata_dir = workspace_dir / "metadata"

        yaml_files = sorted(metadata_dir.glob("*.yaml"))
        if not yaml_files:
            continue

        for yaml_file in yaml_files:
            try:
                with open(yaml_file, 'r') as f:
                    data = yaml.safe_load(f)

                if not data or data.get('kind') != 'Package':
                    continue

                metadata = data.get('metadata', {})
                spec = data.get('spec', {})
                stem = metadata.get('name', yaml_file.stem)
                version = spec.get('version', '')
                dynamic_artifact = spec.get('dynamicArtifact', '')
                package_name = spec.get('packageName', '')
                support_level = spec.get('support', '')

                # Check packages filter (by npm package name)
                if packages_set is not None and package_name not in packages_set:
                    skipped_count += 1
                    continue

                # Construct registryReference
                image_name = package_name_to_image_name(package_name) if package_name else stem

                bs_mismatch_info = outdated_workspaces.get(workspace_name)
                tag_backstage_version = backstage_version
                if bs_mismatch_info:
                    bs_mismatch_count += 1
                    found = bs_mismatch_info.get("found", "")
                    if found and found != "missing":
                        tag_backstage_version = found
                    log_debug(
                        f"{stem} (workspace {workspace_name}): "
                        f"backstage version {bs_mismatch_info['found']} != expected "
                        f"{bs_mismatch_info['expected']}, using tag bs version {tag_backstage_version}"
                    )

                # Look up workspacePath from pre-built mappings (uses scored matching
                # + process-of-elimination to handle divergent folder/package names)
                workspace_path = ws_mappings.ws_path_to_npm and next(
                    (wp for wp, npm in ws_mappings.ws_path_to_npm.items() if npm == package_name), None
                )
                if not workspace_path:
                    workspace_path = f"{workspace_name}/{stem}"
                    log_debug(f"No workspace mapping for {package_name}, using fallback: {workspace_path}")
                effective_registry = registry_base
                if support_level == 'community' and community_registry != registry_base:
                    effective_registry = community_registry
                registry_reference = construct_registry_reference(
                    effective_registry, image_name, version, tag_backstage_version, rhdh_version, dynamic_artifact,
                )

                if not registry_reference:
                    no_ref_count += 1
                    log_debug(f"No OCI reference for {stem} (local path: {dynamic_artifact})")

                # Write or update JSON file
                json_dir = plugin_builds_dir / workspace_name
                json_dir.mkdir(parents=True, exist_ok=True)
                json_file = json_dir / f"{image_name}.json"

                existing_data = {}
                if json_file.exists():
                    try:
                        with open(json_file, 'r', encoding='utf-8') as f:
                            existing_data = json.load(f)
                    except (json.JSONDecodeError, OSError):
                        existing_data = {}

                # Preserve existing enrichment fields (digest, build-date, etc.)
                plugin_entry = existing_data.get(image_name, {})
                plugin_entry['workspacePath'] = workspace_path
                if support_level:
                    plugin_entry['support'] = support_level
                if registry_reference:
                    plugin_entry['registryReference'] = registry_reference
                elif 'registryReference' not in plugin_entry:
                    plugin_entry['registryReference'] = ""

                new_data = {image_name: plugin_entry}

                if json_file.exists():
                    updated_count += 1
                    action = "Updated"
                else:
                    created_count += 1
                    action = "Created"

                with open(json_file, 'w', encoding='utf-8') as f:
                    json.dump(new_data, f, indent=2)
                    f.write('\n')

                log_debug(f"{action} {json_file.relative_to(plugin_builds_dir)}")

                report.add_plugin(
                    image_name,
                    package=package_name,
                    version=version,
                    workspace=workspace_name,
                )
                stage_details = {}
                if registry_reference:
                    stage_details["oci_ref"] = registry_reference
                if bs_mismatch_info:
                    stage_details["bs_version_mismatch"] = True
                    stage_details["reason"] = "Backstage version mismatch"
                    stage_details["expected_version"] = bs_mismatch_info["expected"]
                    stage_details["found_version"] = bs_mismatch_info["found"]
                report.set_stage(image_name, "bootstrap", "pass", **stage_details)

            except Exception as e:
                log_error(f"Error processing {yaml_file}: {e}")
                report.set_stage(yaml_file.stem, "bootstrap", "fail", reason=str(e))

    # Summary
    total = created_count + updated_count
    print(f"\n{Colors.GREEN}=== Results ==={Colors.NORM}")
    log_info(f"Created: {Colors.GREEN}{created_count}{Colors.NORM}")
    if updated_count > 0:
        log_info(f"Updated: {Colors.BLUE}{updated_count}{Colors.NORM}")
    if skipped_count > 0:
        log_info(f"Filtered out: {skipped_count}")
    if bs_mismatch_count > 0:
        log_warn(
            f"Backstage version mismatch (included with warning): "
            f"{Colors.YELLOW}{bs_mismatch_count}{Colors.NORM}"
        )
    if no_ref_count > 0:
        log_warn(f"No OCI reference (local path): {Colors.YELLOW}{no_ref_count}{Colors.NORM}")
    log_info(f"Total: {total}")

    report.save()


if __name__ == "__main__":
    main()
