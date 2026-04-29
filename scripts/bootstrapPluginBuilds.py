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

# Global debug flag
DEBUG = False


class Colors:
    """ANSI color codes for terminal output"""
    NORM = "\033[0;39m"
    GREEN = "\033[1;32m"
    BLUE = "\033[1;34m"
    RED = "\033[1;31m"
    ORANGE = "\033[38;5;208m"
    YELLOW = "\033[1;33m"


def log_debug(message: str) -> None:
    if DEBUG:
        print(f"{Colors.ORANGE}[DEBUG]{Colors.NORM} {message}")


def log_info(message: str) -> None:
    print(f"{Colors.GREEN}[INFO]{Colors.NORM} {message}")


def log_warn(message: str) -> None:
    print(f"{Colors.YELLOW}[WARN]{Colors.NORM} {message}")


def log_error(message: str) -> None:
    print(f"{Colors.RED}[ERROR]{Colors.NORM} {message}")


def load_packages_filter(filter_files: list[str]) -> set[str] | None:
    """Load plugin paths from one or more package list files.
    Returns None if no filter files are specified (include all)."""
    if not filter_files:
        return None

    plugins = set()
    for file_path in filter_files:
        path = Path(file_path)
        if not path.exists():
            log_warn(f"Filter file not found: {file_path}")
            continue
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                plugins.add(line)

    return plugins


def check_plugin_in_filter(workspace_path: str, filter_set: set[str]) -> bool:
    """Check if a workspace path matches any entry in the filter set."""
    for entry in filter_set:
        if entry in workspace_path or workspace_path in entry:
            return True
        if '/' in entry and '/' in workspace_path:
            entry_parts = entry.split('/')
            path_parts = workspace_path.split('/')
            if len(entry_parts) >= 2 and len(path_parts) >= 2:
                if entry_parts[0] == path_parts[0] and entry_parts[-1] in path_parts[-1]:
                    return True
    return False


def read_plugins_list(workspace_dir: Path) -> list[str]:
    """Read plugins-list.yaml and return list of plugin paths (without trailing colon/args)."""
    plugins_list_file = workspace_dir / "plugins-list.yaml"
    if not plugins_list_file.exists():
        return []

    paths = []
    with open(plugins_list_file, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            # Strip trailing colon and any CLI args (e.g., "plugins/acr:" or "plugins/foo: --embed-package bar")
            path = line.split(':')[0].strip()
            if path:
                paths.append(path)
    return paths


def match_metadata_to_plugin_path(metadata_name: str, plugin_paths: list[str]) -> str | None:
    """
    Match a metadata file stem to a plugins-list.yaml entry.
    metadata_name: e.g., 'backstage-community-plugin-acr'
    plugin_paths:  e.g., ['plugins/acr']
    Returns the matching path or None.
    """
    # Sort by longest last segment first for most specific match
    sorted_paths = sorted(plugin_paths, key=lambda p: -len(p.split('/')[-1]))
    for path in sorted_paths:
        last_segment = path.split('/')[-1]
        if metadata_name == last_segment:
            return path
        if metadata_name.endswith('-' + last_segment):
            return path
        if metadata_name.endswith(last_segment):
            return path
    return None


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
    # Strip !fragment (e.g., oci://ghcr.io/.../plugin:tag!plugin-name)
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
    Construct a registryReference for a plugin.
    If dynamicArtifact already has an OCI ref matching the registry, use it.
    Otherwise construct from convention:
      - ghcr.io: bs_{backstage_version}__{version}
      - quay.io/rhdh: {rhdh_version}--{version}
    """
    existing_ref = parse_dynamic_artifact(dynamic_artifact)

    # If the existing ref already points to this registry, use it
    if existing_ref and existing_ref.startswith(registry_base + '/'):
        return existing_ref

    # Construct based on registry convention
    if 'ghcr.io' in registry_base:
        tag = f"bs_{backstage_version}__{version}"
    else:
        tag = f"{rhdh_version}--{version}"

    return f"{registry_base}/{image_name}:{tag}"


def main():
    usage="""
Usage: python3 bootstrapPluginBuilds.py [--debug] \\
    -d|--overlays-dir  /path/to/overlays \\
    -b|--plugin-builds-dir /path/to/plugin_builds \\
    -r|--registry image-registry \\
    [-v|--rhdh-version VERSION] \\
    [-s|--support-filter LEVEL [LEVEL ...]] \\
    [-f|--packages-filter FILE [FILE ...]]

Examples:
    # All plugins on ghcr.io (no --rhdh-version needed)
    python3 bootstrapPluginBuilds.py \\
        -d . \\
        -b plugin_builds/all \\
        -r ghcr.io/redhat-developer/rhdh-plugin-export-overlays

    # Supported + tech-preview plugins on quay.io/rhdh (--rhdh-version required)
    python3 bootstrapPluginBuilds.py \\
        -d . \\
        -b plugin_builds/supported \\
        -r quay.io/rhdh \\
        -v 1.5 \\
        -s generally-available tech-preview

    # Filter by package list files
    python3 bootstrapPluginBuilds.py \\
        -d . \\
        -b plugin_builds/custom \\
        -r ghcr.io/redhat-developer/rhdh-plugin-export-overlays \\
        -f rhdh-supported-packages.txt rhdh-techpreview-packages.txt
"""

    global DEBUG

    if len(sys.argv) == 1:
        print(usage)
        sys.exit(1)

    parser = argparse.ArgumentParser(
        description='Bootstrap plugin_builds/ from workspace metadata.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=usage
    )
    parser.add_argument(
        '-d', '--overlays-dir',
        type=str,
        required=True,
        metavar='PATH',
        help='Path to overlays directory containing workspaces/',
    )
    parser.add_argument(
        '-b', '--plugin-builds-dir',
        type=str,
        required=True,
        metavar='PATH',
        help='Output directory for plugin_builds/',
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
        '-f', '--packages-filter',
        type=str,
        nargs='+',
        metavar='FILE',
        help='Only process plugins listed in these package list files (mutually exclusive with --support-filter)',
    )
    parser.add_argument(
        '-s', '--support-filter',
        type=str,
        nargs='+',
        metavar='LEVEL',
        help='Only process plugins whose spec.support matches one of these values '
             '(e.g., community, generally-available, tech-preview, dev-preview). '
             'Mutually exclusive with --packages-filter.',
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug output',
    )

    args = parser.parse_args()
    DEBUG = args.debug

    if args.packages_filter and args.support_filter:
        log_error("--packages-filter and --support-filter are mutually exclusive. Use one or the other.")
        sys.exit(1)

    overlays_dir = Path(args.overlays_dir)
    plugin_builds_dir = Path(args.plugin_builds_dir)
    registry_base = args.registry.rstrip('/')
    rhdh_version = args.rhdh_version or ""

    if 'ghcr.io' not in registry_base and not rhdh_version:
        log_error("--rhdh-version is required when registry is not ghcr.io")
        sys.exit(1)

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
        with open(versions_file, 'r') as f:
            versions = json.load(f)
            backstage_version = versions.get("backstage", "")
    if not backstage_version:
        log_warn("Could not read backstage version from versions.json")

    # Load packages filter
    filter_set = load_packages_filter(args.packages_filter or [])
    if filter_set is not None:
        log_info(f"Filtering to {len(filter_set)} entries from package list files")

    # Load support-level filter
    support_filter = set(args.support_filter) if args.support_filter else None
    if support_filter is not None:
        log_info(f"Filtering to support levels: {', '.join(sorted(support_filter))}")

    print(f"\n{Colors.GREEN}=== Bootstrap plugin_builds from workspace metadata ==={Colors.NORM}\n")

    # Find all workspace directories with metadata
    workspace_dirs = sorted([
        d for d in workspaces_dir.iterdir()
        if d.is_dir() and (d / "metadata").is_dir()
    ])

    created_count = 0
    updated_count = 0
    skipped_count = 0
    no_ref_count = 0

    for workspace_dir in workspace_dirs:
        workspace_name = workspace_dir.name
        metadata_dir = workspace_dir / "metadata"
        plugin_paths = read_plugins_list(workspace_dir)

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

                # Derive workspacePath
                matched_path = match_metadata_to_plugin_path(stem, plugin_paths)
                if matched_path:
                    workspace_path = f"{workspace_name}/{matched_path}"
                else:
                    workspace_path = f"{workspace_name}/{stem}"
                    log_debug(f"No plugins-list match for {stem}, using fallback: {workspace_path}")

                # Check packages filter
                if filter_set is not None:
                    if not check_plugin_in_filter(workspace_path, filter_set):
                        skipped_count += 1
                        continue

                # Check support-level filter
                if support_filter is not None:
                    if support_level not in support_filter:
                        skipped_count += 1
                        continue

                # Construct registryReference
                image_name = package_name_to_image_name(package_name) if package_name else stem
                registry_reference = construct_registry_reference(
                    registry_base, image_name, version, backstage_version, rhdh_version, dynamic_artifact,
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
                        with open(json_file, 'r') as f:
                            existing_data = json.load(f)
                    except (json.JSONDecodeError, Exception):
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

                with open(json_file, 'w') as f:
                    json.dump(new_data, f, indent=2)
                    f.write('\n')

                log_debug(f"{action} {json_file.relative_to(plugin_builds_dir)}")

            except Exception as e:
                log_error(f"Error processing {yaml_file}: {e}")

    # Summary
    total = created_count + updated_count
    print(f"\n{Colors.GREEN}=== Results ==={Colors.NORM}")
    log_info(f"Created: {Colors.GREEN}{created_count}{Colors.NORM}")
    if updated_count > 0:
        log_info(f"Updated: {Colors.BLUE}{updated_count}{Colors.NORM}")
    if skipped_count > 0:
        log_info(f"Filtered out: {skipped_count}")
    if no_ref_count > 0:
        log_warn(f"No OCI reference (local path): {Colors.YELLOW}{no_ref_count}{Colors.NORM}")
    log_info(f"Total: {total}")


if __name__ == "__main__":
    main()
