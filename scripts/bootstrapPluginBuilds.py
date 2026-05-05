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


def load_core_packages_from_yaml(packages_file: str) -> set[str]:
    """Load core package names from default.packages.yaml.
    Returns set of npm package names from both enabled and disabled sections."""
    path = Path(packages_file)
    if not path.exists():
        log_error(f"Core packages file not found: {packages_file}")
        sys.exit(1)

    with open(path, 'r') as f:
        data = yaml.safe_load(f)

    packages = set()
    for section in ['enabled', 'disabled']:
        for entry in data.get('packages', {}).get(section, []) or []:
            pkg = entry.get('package', '').strip()
            if pkg:
                packages.add(pkg)

    return packages


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
    [-cr|--community-registry BASE] \\
    [-c|--core-packages-file FILE] \\
    [-e|--exclude-packages-file FILE]

Examples:
    # All plugins on ghcr.io (no --rhdh-version needed)
    python3 bootstrapPluginBuilds.py \\
        -d . \\
        -b plugin_builds/all \\
        -r ghcr.io/redhat-developer/rhdh-plugin-export-overlays

    # Core plugins from default.packages.yaml
    python3 bootstrapPluginBuilds.py \\
        -d . \\
        -b plugin_builds/supported \\
        -r quay.io/rhdh \\
        -v 1.5 \\
        -c catalog-index/default.packages.yaml
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
    parser.error = lambda msg: (print(f"\n{Colors.RED}[ERROR] {msg}{Colors.NORM}\n{usage}", file=sys.stderr), sys.exit(2))
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
        '-c', '--core-packages-file',
        type=str,
        metavar='FILE',
        help='Path to default.packages.yaml. Filter to only include packages whose '
             'spec.packageName appears in this file (enabled + disabled sections). '
             'Mutually exclusive with --exclude-packages-file.',
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
        '-e', '--exclude-packages-file',
        type=str,
        metavar='FILE',
        help='Path to default.packages.yaml. Exclude packages whose '
             'spec.packageName appears in this file (enabled + disabled sections). '
             'Mutually exclusive with --core-packages-file.',
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug output',
    )

    args = parser.parse_args()
    DEBUG = args.debug

    if args.core_packages_file and args.exclude_packages_file:
        log_error("--core-packages-file and --exclude-packages-file are mutually exclusive.")
        sys.exit(1)

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
        with open(versions_file, 'r') as f:
            versions = json.load(f)
            backstage_version = versions.get("backstage", "")
    if not backstage_version:
        log_warn("Could not read backstage version from versions.json")

    # Load core packages filter (from default.packages.yaml)
    core_packages_set = None
    if args.core_packages_file:
        core_packages_set = load_core_packages_from_yaml(args.core_packages_file)
        log_info(f"Filtering to {len(core_packages_set)} core packages from {args.core_packages_file}")

    # Load exclude packages filter (inverse of core)
    exclude_packages_set = None
    if args.exclude_packages_file:
        exclude_packages_set = load_core_packages_from_yaml(args.exclude_packages_file)
        log_info(f"Excluding {len(exclude_packages_set)} packages from {args.exclude_packages_file}")

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

                # Check core packages filter (by npm package name)
                if core_packages_set is not None:
                    if package_name not in core_packages_set:
                        skipped_count += 1
                        continue

                # Check exclude packages filter (inverse of core)
                if exclude_packages_set is not None:
                    if package_name in exclude_packages_set:
                        skipped_count += 1
                        continue

                # Construct registryReference
                # Use community registry for community-tier plugins
                image_name = package_name_to_image_name(package_name) if package_name else stem
                effective_registry = registry_base
                if support_level == 'community' and community_registry != registry_base:
                    effective_registry = community_registry
                registry_reference = construct_registry_reference(
                    effective_registry, image_name, version, backstage_version, rhdh_version, dynamic_artifact,
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
