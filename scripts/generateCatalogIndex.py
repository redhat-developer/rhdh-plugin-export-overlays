#!/usr/bin/env python3
#
# Copyright (c) Red Hat, Inc.
# This program and the accompanying materials are made
# available under the terms of the Eclipse Public License 2.0
# which is available at https://www.eclipse.org/legal/epl-2.0/
#
# SPDX-License-Identifier: EPL-2.0
#
# Using content in plugin_builds folder:
# - Create a summary index.json file
# - Use that file to update all file refs to oci:// refs

import argparse
import json
import os
import re
import shutil
import sys
from collections import OrderedDict
from pathlib import Path
import requests
import yaml

# Global debug flag
DEBUG = False

# Global registry config
REGISTRY_BASE = ""


class Colors:
    """ANSI color codes for terminal output"""
    NORM = "\033[0;39m"
    GREEN = "\033[1;32m"
    BLUE = "\033[1;34m"
    RED = "\033[1;31m"
    ORANGE = "\033[38;5;208m"
    YELLOW = "\033[1;33m"
    RESET = "\033[0m"


def log_debug(message: str) -> None:
    if DEBUG:
        print(f"{Colors.ORANGE}[DEBUG]{Colors.NORM} {message}")


def log_info(message: str) -> None:
    print(f"{Colors.GREEN}[INFO]{Colors.NORM} {message}")


def log_warn(message: str) -> None:
    print(f"{Colors.BLUE}[WARN]{Colors.NORM} {message}")


def log_error(message: str) -> None:
    print(f"{Colors.RED}[ERROR]{Colors.NORM} {message}")


def is_registry_rarc() -> bool:
    """Check if the registry is registry.access.redhat.com (downstream GA registry)"""
    return REGISTRY_BASE.startswith("registry.access.redhat.com")


def get_query_registry_reference(registry_reference: str) -> str:
    """
    Get the registry reference to use for querying.
    For registry.access.redhat.com refs, swap to quay.io for unauthenticated verification.
    Per-reference check — works with mixed-registry plugin_builds.
    """
    if registry_reference.startswith("registry.access.redhat.com/rhdh/"):
        return registry_reference.replace("registry.access.redhat.com/rhdh/", "quay.io/rhdh/")
    return registry_reference


def get_ghcr_token(repository: str) -> str | None:
    """Get anonymous bearer token for ghcr.io"""
    try:
        url = f"https://ghcr.io/token?scope=repository:{repository}:pull&service=ghcr.io"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return response.json().get("token")
    except Exception as e:
        log_debug(f"Failed to get ghcr.io token for {repository}: {e}")
        return None


def parse_image_reference(registry_reference: str) -> tuple[str, str, str]:
    if not registry_reference:
        return "", "", ""

    name_with_tag, sep, digest = registry_reference.partition('@')

    last_slash = name_with_tag.rfind('/')
    last_colon = name_with_tag.rfind(':')
    if last_colon > last_slash:
        return name_with_tag[:last_colon], name_with_tag[last_colon + 1 :], digest if sep else ""

    return name_with_tag, "", digest if sep else ""


def copy_catalog_entities_extensions(source_dir: Path, output_dir: Path) -> None:
    """Copy content from catalog-entities/extensions source to output catalog-entities/extensions."""
    target_dir = output_dir / "catalog-entities" / "extensions"

    if not source_dir.exists():
        log_warn(f"Source directory {source_dir} does not exist. Skipping.")
        return

    if source_dir.resolve() == target_dir.resolve():
        log_info(f"Source and target are the same directory, skipping copy:\n  {source_dir}")
        return

    log_info(f"Copy content from\n  {source_dir} to\n  {target_dir}")

    for item in source_dir.iterdir():
        target_item = target_dir / item.name
        if target_item.exists():
            if target_item.is_dir():
                shutil.rmtree(target_item)
            else:
                target_item.unlink()
        if item.is_dir():
            shutil.copytree(str(item), str(target_item))
        else:
            target_item.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(item), str(target_item))


def copy_workspace_metadata_files(overlays_dir: Path, output_dir: Path) -> tuple[set, dict[str, str]]:
    """
    Task 2: Find all *.yaml files in workspaces/*/metadata/ and copy them to
    output catalog-entities/extensions/packages/

    Returns: (set of YAML file base names, dict mapping base names to full relative paths)
    """
    overlay_workspaces = overlays_dir / "workspaces"
    target_packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"

    if not overlay_workspaces.exists():
        log_warn(f"Workspaces directory {overlay_workspaces} does not exist. Skipping Task 2.")
        return set(), {}

    target_packages_dir.mkdir(parents=True, exist_ok=True)

    yaml_files = list(overlay_workspaces.glob("*/metadata/*.yaml"))

    if not yaml_files:
        log_warn("No YAML files found in workspace metadata directories")
        return set(), {}

    log_info(f"Found {len(yaml_files)} workspace/*/metadata/*.yaml")

    yaml_file_names = set()
    yaml_file_paths = {}
    for yaml_file in yaml_files:
        target_file = target_packages_dir / yaml_file.name
        log_debug(f"Copy\n  {yaml_file.relative_to(overlay_workspaces)} to\n  {target_file.relative_to(output_dir)}")
        shutil.copy2(str(yaml_file), str(target_file))
        base_name = yaml_file.stem
        yaml_file_names.add(base_name)
        yaml_file_paths[base_name] = Path("workspaces/" + str(yaml_file.relative_to(overlay_workspaces)))

    return yaml_file_names, yaml_file_paths


def check_image_exists(registry_reference: str) -> bool:
    """Check if a container image exists using Docker Registry HTTP API v2"""
    try:
        parts = registry_reference.split('/', 1)
        if len(parts) < 2:
            log_warn(f"Invalid registry reference format: {registry_reference}")
            return False

        registry = parts[0]
        image_and_tag = parts[1]

        if ':' in image_and_tag:
            repository, tag = image_and_tag.rsplit(':', 1)
        else:
            repository = image_and_tag
            tag = 'latest'

        url = f"https://{registry}/v2/{repository}/manifests/{tag}"

        headers = {
            'Accept': 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'
        }

        auth = None
        if registry == "ghcr.io":
            token = get_ghcr_token(repository)
            if token:
                headers['Authorization'] = f"Bearer {token}"
        else:
            username = os.environ.get('REGISTRY_USERNAME')
            password = os.environ.get('REGISTRY_PASSWORD')
            if username and password:
                auth = (username, password)

        response = requests.head(url, headers=headers, auth=auth, timeout=10, allow_redirects=True)

        if response.status_code == 200:
            return True
        elif response.status_code == 401:
            log_warn(f"Image {registry_reference} requires authentication")
            return False
        else:
            return False

    except requests.exceptions.Timeout:
        log_warn(f"Timeout checking image {registry_reference}")
        return False
    except requests.exceptions.RequestException as e:
        log_warn(f"Error checking image {registry_reference}: {e}")
        return False
    except Exception as e:
        log_warn(f"Unexpected error checking image {registry_reference}: {e}")
        return False


def generate_index_json(plugin_builds_dir: Path, output_dir: Path) -> tuple[dict[str, dict], list[str], list[tuple[str, str, str]], dict[str, str], dict[str, dict]]:
    """
    Read *.json files in plugin_builds/ and check if registryReference exists.
    Combine valid ones into index.json.
    No filtering — plugin_builds/ is already pre-filtered by bootstrapPluginBuilds.py.

    Returns: (combined_index, found_plugins, missing_references, plugin_workspace_paths, all_plugin_data)
    """
    catalog_index_json = output_dir / "index.json"

    if not plugin_builds_dir.exists():
        log_error(f"Plugin builds directory {plugin_builds_dir} does not exist")
        sys.exit(1)

    json_files = list(plugin_builds_dir.glob("*/*.json"))

    if not json_files:
        log_error("No JSON files found in plugin_builds/")
        sys.exit(1)

    log_info(f"Found {len(json_files)} JSON file(s) to process")

    combined_index = {}
    found_plugins = []
    missing_references = []
    plugin_workspace_paths = {}
    all_plugin_data = {}
    missing_count = 0
    found_count = 0

    for i, json_file in enumerate(json_files, 1):
        relative_path = json_file.relative_to(plugin_builds_dir)
        print(f"\n{Colors.NORM}[{i}/{len(json_files)}] {relative_path}{Colors.NORM}")

        try:
            with open(json_file, 'r') as f:
                data = json.load(f)

            for plugin_name, plugin_data in data.items():
                registry_reference = plugin_data.get('registryReference')
                workspace_path = plugin_data.get('workspacePath')

                if workspace_path:
                    plugin_workspace_paths[plugin_name] = f"workspaces/{workspace_path}"

                all_plugin_data[plugin_name] = plugin_data

                if not registry_reference:
                    missing_count += 1
                    print(f"{Colors.RED}[{i}/{len(json_files)}] ! No OCI reference found{Colors.NORM} ({missing_count})")
                    missing_references.append((str(relative_path), plugin_name, "no registryReference field"))
                    continue

                query_ref = get_query_registry_reference(registry_reference)
                if check_image_exists(query_ref):
                    found_count += 1
                    print(f"[{i}/{len(json_files)}] {registry_reference} ({found_count})")
                    combined_index[plugin_name] = plugin_data
                    found_plugins.append(plugin_name)
                else:
                    missing_count += 1
                    print(f"{Colors.RED}[{i}/{len(json_files)}]{Colors.NORM} {registry_reference} {Colors.RED}could not be resolved{Colors.NORM} ({missing_count})")
                    missing_references.append((str(relative_path), plugin_name, registry_reference))

        except json.JSONDecodeError as e:
            log_error(f"Error parsing JSON file {json_file}: {e}")
            missing_count += 1
            missing_references.append((str(relative_path), "N/A", f"JSON parse error: {e}"))
        except Exception as e:
            log_error(f"Error processing {json_file}: {e}")
            missing_count += 1
            missing_references.append((str(relative_path), "N/A", f"Error: {e}"))

    if not combined_index:
        log_error("No plugins found! Cannot generate index.json")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    key_order = ['workspacePath', 'registryReference', 'build-date', 'vcs-ref', 'upstream', 'midstream']
    ordered_index = OrderedDict()

    for plugin_name in sorted(combined_index.keys()):
        plugin_data = combined_index[plugin_name]
        ordered_plugin = {}

        registry_reference = plugin_data.get('registryReference', '')
        digest = plugin_data.get('digest', '')

        if registry_reference and digest:
            name_no_tag, image_tag, _ = parse_image_reference(registry_reference)
            plugin_data['imageTag'] = image_tag
            plugin_data['registryReference'] = f"{name_no_tag}@{digest}"
            if 'digest' in plugin_data:
                del plugin_data['digest']

        for key in key_order:
            if key in plugin_data:
                ordered_plugin[key] = plugin_data[key]
        for key, value in plugin_data.items():
            if key not in ordered_plugin:
                ordered_plugin[key] = value
        ordered_index[plugin_name] = ordered_plugin

    with open(catalog_index_json, 'w') as f:
        json.dump(ordered_index, f, indent=2)
        f.write('\n')

    log_info(f"Regenerated index.json with {Colors.GREEN}{found_count}{Colors.NORM} of {Colors.BLUE}{len(json_files)}{Colors.NORM} plugins")

    if missing_count > 0:
        print(f"\n========")
        log_warn(f"Could not find {Colors.RED}{missing_count}{Colors.NORM} plugins - remember to export and publish them, then re-run this script")

    return combined_index, found_plugins, missing_references, plugin_workspace_paths, all_plugin_data


def update_package_files(output_dir: Path, index_data: dict[str, dict], found_plugins: list[str]) -> None:
    """Add OCI reference entries alongside existing file path entries"""
    packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"
    dynamic_plugins_yaml = output_dir / "dynamic-plugins.default.yaml"

    if not packages_dir.exists():
        log_warn(f"Packages directory {packages_dir} does not exist. Skipping.")
        return

    files_updated = 0
    plugins_matched_in_dynamic_yaml = 0

    for plugin_name in found_plugins:
        plugin_data = index_data[plugin_name]
        registry_reference = plugin_data.get('registryReference', '')
        build_date = plugin_data.get('build-date', '')

        name_no_tag, _, parsed_digest = parse_image_reference(registry_reference)
        tag = plugin_data.get('imageTag')
        registry_reference_for_oci = f"{name_no_tag}@{parsed_digest}" if parsed_digest else registry_reference

        comment = f"# Tag: {tag}, Build date: {build_date}"

        plugin_name_alternative = plugin_name.replace("red-hat-developer-hub-", "rhdh-")

        plugin_name_with_dynamic = f"{plugin_name}-dynamic"
        plugin_name_alternative_with_dynamic = f"{plugin_name_alternative}-dynamic"

        log_debug(f"Checking for matches: {plugin_name} (or {plugin_name_alternative}, {plugin_name_with_dynamic}, {plugin_name_alternative_with_dynamic})")

        files_to_update = [
            dynamic_plugins_yaml,
            packages_dir / f"{plugin_name}.yaml",
            packages_dir / f"{plugin_name_alternative}.yaml"
        ]

        for yaml_file in files_to_update:
            if not yaml_file.exists():
                continue

            try:
                with open(yaml_file, 'r') as f:
                    lines = f.readlines()

                new_lines = []
                i = 0
                modified = False

                while i < len(lines):
                    line = lines[i]
                    matched_oci = False

                    for pname in [plugin_name, plugin_name_alternative,
                                  plugin_name_with_dynamic, plugin_name_alternative_with_dynamic]:
                        oci_pattern_old = rf'^  - package: oci://.*!{re.escape(pname)}\s*$'
                        if re.match(oci_pattern_old, line):
                            matched_oci = True
                            break
                    if not matched_oci:
                        oci_pattern_new = rf'^  - package: oci://{re.escape(registry_reference_for_oci)}\s*$'
                        if re.match(oci_pattern_new, line):
                            matched_oci = True

                    if matched_oci:
                        modified = True
                        while new_lines and ('Tag:' in new_lines[-1] or 'Build date:' in new_lines[-1]):
                            new_lines.pop()

                        preserved_lines = []
                        i += 1
                        while i < len(lines):
                            next_line = lines[i]
                            if not next_line.strip():
                                i += 1
                                continue
                            if next_line.startswith(' ') or next_line.startswith('\t'):
                                if not (next_line.strip().startswith('#') and 'Tag:' in next_line):
                                    preserved_lines.append(next_line)
                                i += 1
                                continue
                            if next_line.strip().startswith('#') and ('Tag:' in next_line or 'Build date:' in next_line):
                                i += 1
                                continue
                            break

                        new_lines.append(f"  {comment}\n")
                        new_lines.append(f"  - package: oci://{registry_reference_for_oci}\n")
                        for pl in preserved_lines:
                            new_lines.append(pl)
                        continue

                    matched = False
                    for pname in [plugin_name, plugin_name_alternative,
                                  plugin_name_with_dynamic, plugin_name_alternative_with_dynamic]:
                        pattern = rf'^  - package: \.\/dynamic-plugins\/dist\/{re.escape(pname)}\s*$'
                        if re.match(pattern, line):
                            new_lines.append(f"  # - package: oci://{registry_reference_for_oci}\n")
                            new_lines.append(f"  {comment}\n")
                            new_lines.append(f"  # new approach using oci images: to switch to the new approach, uncomment\n")
                            new_lines.append(f"  # the 'package' line above and remove the next two lines, keeping the pluginConfig.\n")
                            new_lines.append(f"  # disabled: true\n")

                            new_lines.append(line)

                            i += 1
                            while i < len(lines):
                                next_line = lines[i]
                                if next_line.strip() and not next_line.startswith(' ') and not next_line.startswith('\t'):
                                    break
                                new_lines.append(next_line)
                                i += 1

                            modified = True
                            log_debug(f"Added OCI reference for {pname} in {yaml_file.name}")
                            i -= 1
                            matched = True
                            break

                    if not matched:
                        empty_artifact_pattern = r"^(\s*)dynamicArtifact:\s*(''|\"\"|\~|null)?\s*$"
                        empty_match = re.match(empty_artifact_pattern, line)
                        if empty_match:
                            indent = empty_match.group(1)
                            new_lines.append(f"{indent}dynamicArtifact: oci://{registry_reference_for_oci}\n")
                            modified = True
                            log_debug(f"Set dynamicArtifact:oci://{registry_reference_for_oci} in {yaml_file.name}")
                            matched = True

                    if not matched:
                        new_lines.append(line)

                    i += 1

                if modified:
                    with open(yaml_file, 'w') as f:
                        f.writelines(new_lines)
                    files_updated += 1
                    if yaml_file == dynamic_plugins_yaml:
                        plugins_matched_in_dynamic_yaml += 1

            except Exception as e:
                log_error(f"Error updating {yaml_file}: {e}")

    if files_updated > 0:
        log_info(f"Updated {files_updated} file(s) with OCI references")
        if dynamic_plugins_yaml.exists():
            log_info(f"Added OCI references for {plugins_matched_in_dynamic_yaml} plugin(s) in dynamic-plugins.default.yaml")
    else:
        if dynamic_plugins_yaml.exists():
            log_warn("No files were updated with OCI references")
        else:
            log_debug("dynamic-plugins.default.yaml not present, skipping DPDY updates")


def prune_packages_dir(output_dir: Path, found_plugins: list[str]) -> None:
    """Remove package YAML files from the output that don't correspond to plugins in the index."""
    packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"
    if not packages_dir.exists():
        return

    found_set = set(found_plugins)
    removed_count = 0

    for yaml_file in list(packages_dir.glob("*.yaml")):
        if yaml_file.name == "all.yaml":
            continue
        if yaml_file.stem not in found_set:
            yaml_file.unlink()
            removed_count += 1
            log_debug(f"Pruned {yaml_file.name}")

    if removed_count > 0:
        log_info(f"Pruned {removed_count} package file(s) not in the index")


def regenerate_all_yaml_files(output_dir: Path) -> None:
    """Regenerate all.yaml files in plugins/ and packages/ directories"""
    extensions_dir = output_dir / "catalog-entities" / "extensions"

    directories = ["plugins", "packages"]

    for directory in directories:
        dir_path = extensions_dir / directory
        if not dir_path.exists():
            log_warn(f"Directory {dir_path} does not exist. Skipping.")
            continue

        yaml_files = sorted([
            f.name for f in dir_path.iterdir()
            if f.is_file() and f.suffix == '.yaml' and f.name != 'all.yaml'
        ])

        if not yaml_files:
            log_warn(f"No YAML files found in {dir_path}")
            continue

        all_yaml_path = dir_path / "all.yaml"
        with open(all_yaml_path, 'w') as f:
            f.write("apiVersion: backstage.io/v1alpha1\n")
            f.write("kind: Location\n")
            f.write("metadata:\n")
            f.write("  namespace: rhdh\n")
            f.write(f"  name: {directory}\n")
            f.write("spec:\n")
            f.write("  targets:\n")
            for yaml_file in yaml_files:
                f.write(f"    - ./{yaml_file}\n")

        log_info(f"Regenerated {all_yaml_path.relative_to(output_dir)} with {len(yaml_files)} entries")


def _support_label_color(label: str) -> str:
    """Return ANSI color for a support level label."""
    colors = {
        'community': Colors.NORM,
        'generally-available': Colors.GREEN,
        'tech-preview': Colors.YELLOW,
        'dev-preview': Colors.ORANGE,
    }
    return colors.get(label, Colors.RED)


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


def build_npm_to_stem_map(overlays_dir: Path) -> dict[str, str]:
    """Build mapping from npm package names to metadata entity stems.
    Scans workspaces/*/metadata/*.yaml files.
    Returns: {'@backstage/plugin-techdocs': 'backstage-plugin-techdocs', ...}
    """
    mapping = {}
    workspaces = overlays_dir / "workspaces"
    if not workspaces.exists():
        return mapping

    for yaml_file in workspaces.glob("*/metadata/*.yaml"):
        try:
            with open(yaml_file, 'r') as f:
                data = yaml.safe_load(f)
            if not data or data.get('kind') != 'Package':
                continue
            spec = data.get('spec', {})
            package_name = spec.get('packageName', '')
            stem = data.get('metadata', {}).get('name', yaml_file.stem)
            if package_name:
                mapping[package_name] = stem
        except Exception:
            continue

    return mapping


def get_core_stems(core_npm_packages: set[str], npm_to_stem: dict[str, str]) -> set[str]:
    """Convert core npm package names to their metadata entity stems."""
    stems = set()
    for npm_name in core_npm_packages:
        stem = npm_to_stem.get(npm_name)
        if stem:
            stems.add(stem)
        else:
            log_warn(f"Core package '{npm_name}' not found in workspace metadata")
    return stems


def scrub_plugin_entity_file(yaml_file: Path, core_stems: set[str]) -> str:
    """Scrub a single Plugin entity YAML file.
    - If no packages are core: delete the file
    - If all packages are core: keep as-is
    - If mixed: use line-based editing to remove non-core package refs

    Returns: 'removed' | 'stripped' | 'kept' | 'skipped'
    """
    try:
        with open(yaml_file, 'r') as f:
            data = yaml.safe_load(f)

        if not data or data.get('kind') != 'Plugin':
            return 'skipped'

        spec = data.get('spec', {})
        packages = spec.get('packages', [])

        if not packages:
            return 'kept'

        # Ensure packages is a list of strings
        pkg_list = [p for p in packages if isinstance(p, str)]
        if not pkg_list:
            return 'kept'

        core_packages = [p for p in pkg_list if p in core_stems]
        non_core_packages = set(p for p in pkg_list if p not in core_stems)

        if not core_packages:
            yaml_file.unlink()
            return 'removed'

        if not non_core_packages:
            return 'kept'

        # Mixed plugin: remove non-core package lines using line-based editing
        with open(yaml_file, 'r') as f:
            lines = f.readlines()

        new_lines = []
        in_packages = False
        for line in lines:
            stripped = line.strip()

            if stripped.startswith('packages:'):
                in_packages = True
                new_lines.append(line)
                continue

            if in_packages:
                if stripped.startswith('- '):
                    pkg_name = stripped[2:].strip()
                    if pkg_name in non_core_packages:
                        continue
                    new_lines.append(line)
                    continue
                elif not stripped or stripped.startswith('#'):
                    new_lines.append(line)
                    continue
                else:
                    in_packages = False

            new_lines.append(line)

        with open(yaml_file, 'w') as f:
            f.writelines(new_lines)

        return 'stripped'

    except Exception as e:
        log_error(f"Error scrubbing plugin entity {yaml_file}: {e}")
        return 'skipped'


def scrub_plugin_entity_file_exclude(yaml_file: Path, core_stems: set[str]) -> str:
    """Inverse scrub: remove core plugins, keep non-core.
    - If ALL packages are core: delete the file
    - If NO packages are core: keep as-is
    - If mixed: strip core package refs using line-based editing

    Returns: 'removed' | 'stripped' | 'kept' | 'skipped'
    """
    try:
        with open(yaml_file, 'r') as f:
            data = yaml.safe_load(f)

        if not data or data.get('kind') != 'Plugin':
            return 'skipped'

        spec = data.get('spec', {})
        packages = spec.get('packages', [])

        if not packages:
            return 'kept'

        pkg_list = [p for p in packages if isinstance(p, str)]
        if not pkg_list:
            return 'kept'

        core_packages = set(p for p in pkg_list if p in core_stems)
        non_core_packages = [p for p in pkg_list if p not in core_stems]

        if not non_core_packages:
            yaml_file.unlink()
            return 'removed'

        if not core_packages:
            return 'kept'

        # Mixed plugin: remove core package lines using line-based editing
        with open(yaml_file, 'r') as f:
            lines = f.readlines()

        new_lines = []
        in_packages = False
        for line in lines:
            stripped = line.strip()

            if stripped.startswith('packages:'):
                in_packages = True
                new_lines.append(line)
                continue

            if in_packages:
                if stripped.startswith('- '):
                    pkg_name = stripped[2:].strip()
                    if pkg_name in core_packages:
                        continue
                    new_lines.append(line)
                    continue
                elif not stripped or stripped.startswith('#'):
                    new_lines.append(line)
                    continue
                else:
                    in_packages = False

            new_lines.append(line)

        with open(yaml_file, 'w') as f:
            f.writelines(new_lines)

        return 'stripped'

    except Exception as e:
        log_error(f"Error scrubbing plugin entity {yaml_file}: {e}")
        return 'skipped'


def exclude_scrub_catalog_entities(output_dir: Path, overlays_dir: Path, packages_file: str) -> None:
    """Inverse scrub: remove core plugins/packages, keep only non-core content."""
    core_npm_packages = load_core_packages_from_yaml(packages_file)
    log_info(f"Loaded {len(core_npm_packages)} core packages to exclude from {packages_file}")

    npm_to_stem = build_npm_to_stem_map(overlays_dir)
    core_stems = get_core_stems(core_npm_packages, npm_to_stem)
    log_info(f"Resolved {len(core_stems)} core package stems to exclude")

    # Scrub Plugin entity YAMLs (remove core, keep non-core)
    plugins_dir = output_dir / "catalog-entities" / "extensions" / "plugins"
    removed = stripped = kept = skipped = 0
    if plugins_dir.exists():
        for yaml_file in sorted(plugins_dir.glob("*.yaml")):
            if yaml_file.name in ("all.yaml", "1-boilerplate.yaml.sample"):
                continue
            result = scrub_plugin_entity_file_exclude(yaml_file, core_stems)
            if result == 'removed':
                removed += 1
                log_debug(f"Removed core plugin: {yaml_file.name}")
            elif result == 'stripped':
                stripped += 1
                log_info(f"Stripped core packages from: {yaml_file.name}")
            elif result == 'kept':
                kept += 1
            else:
                skipped += 1

    log_info(f"Plugin entities (exclude mode): {kept} kept, {stripped} stripped, {removed} removed" +
             (f", {skipped} skipped" if skipped else ""))

    # Pre-prune Package metadata to remove core packages
    packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"
    if packages_dir.exists():
        pkg_removed = 0
        for yaml_file in sorted(packages_dir.glob("*.yaml")):
            if yaml_file.name == "all.yaml":
                continue
            if yaml_file.stem in core_stems:
                yaml_file.unlink()
                pkg_removed += 1
                log_debug(f"Removed core package metadata: {yaml_file.name}")
        if pkg_removed > 0:
            log_info(f"Package metadata: removed {pkg_removed} core files")


def scrub_catalog_entities(output_dir: Path, overlays_dir: Path, packages_file: str) -> None:
    """Scrub catalog entities to only retain core plugins/packages based on default.packages.yaml."""
    core_npm_packages = load_core_packages_from_yaml(packages_file)
    log_info(f"Loaded {len(core_npm_packages)} core packages from {packages_file}")

    npm_to_stem = build_npm_to_stem_map(overlays_dir)
    log_info(f"Built npm-to-stem mapping with {len(npm_to_stem)} entries")

    core_stems = get_core_stems(core_npm_packages, npm_to_stem)
    log_info(f"Resolved {len(core_stems)} core package stems")

    # Scrub Plugin entity YAMLs
    plugins_dir = output_dir / "catalog-entities" / "extensions" / "plugins"
    removed = stripped = kept = skipped = 0
    if plugins_dir.exists():
        for yaml_file in sorted(plugins_dir.glob("*.yaml")):
            if yaml_file.name in ("all.yaml", "1-boilerplate.yaml.sample"):
                continue
            result = scrub_plugin_entity_file(yaml_file, core_stems)
            if result == 'removed':
                removed += 1
                log_debug(f"Removed non-core plugin: {yaml_file.name}")
            elif result == 'stripped':
                stripped += 1
                log_info(f"Stripped non-core packages from: {yaml_file.name}")
            elif result == 'kept':
                kept += 1
            else:
                skipped += 1

    log_info(f"Plugin entities: {kept} kept, {stripped} stripped, {removed} removed" +
             (f", {skipped} skipped" if skipped else ""))

    # Pre-prune Package metadata to only keep core
    packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"
    if packages_dir.exists():
        pkg_removed = 0
        for yaml_file in sorted(packages_dir.glob("*.yaml")):
            if yaml_file.name == "all.yaml":
                continue
            if yaml_file.stem not in core_stems:
                yaml_file.unlink()
                pkg_removed += 1
                log_debug(f"Removed non-core package metadata: {yaml_file.name}")
        if pkg_removed > 0:
            log_info(f"Package metadata: removed {pkg_removed} non-core files")


def main():
    global DEBUG
    global REGISTRY_BASE

    usage = """
Usage: python3 generateCatalogIndex.py [--debug] \\
    -d|--overlays-dir  /path/to/overlays \\
    -o|--output-dir    /path/to/catalog-index \\
    -b|--plugin-builds-dir /path/to/plugin_builds \\
    -r|--registry image-registry \\
    [-p|--packages-file FILE] \\
    [-e|--exclude-packages-file FILE] \\
    [-c|--catalog-entities-dir PATH]

Examples:
    # Generate catalog index for all plugins
    python3 generateCatalogIndex.py \\
        -d . \\
        -o catalog-index/community \\
        -b plugin_builds/community \\
        -r ghcr.io/redhat-developer/rhdh-plugin-export-overlays

    # Generate productized catalog index (scrub to core packages only)
    python3 generateCatalogIndex.py \\
        -d . \\
        -o catalog-index/supported \\
        -b plugin_builds/supported \\
        -r quay.io/rhdh \\
        -p catalog-index/default.packages.yaml

    # Generate community catalog index (exclude core packages)
    python3 generateCatalogIndex.py \\
        -d . \\
        -o catalog-index/community \\
        -b plugin_builds/community \\
        -r ghcr.io/redhat-developer/rhdh-plugin-export-overlays \\
        -e catalog-index/default.packages.yaml
"""

    if len(sys.argv) == 1:
        print(usage)
        sys.exit(1)

    parser = argparse.ArgumentParser(
        description='Generate catalog index from plugin_builds and workspace metadata. '
                    'No filtering — plugin_builds/ is pre-filtered by bootstrapPluginBuilds.py.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=usage
    )
    parser.error = lambda msg: (print(f"\n{Colors.RED}[ERROR] {msg}{Colors.NORM}\n{usage}", file=sys.stderr), sys.exit(2))

    parser.add_argument(
        '-d', '--overlays-dir',
        type=str,
        required=True,
        metavar='PATH',
        help='Path to overlays directory containing workspaces/ and catalog-entities/',
    )
    parser.add_argument(
        '-o', '--output-dir',
        type=str,
        required=True,
        metavar='PATH',
        help='Output directory for catalog-index (index.json, catalog-entities/, etc.)',
    )
    parser.add_argument(
        '-b', '--plugin-builds-dir',
        type=str,
        required=True,
        metavar='PATH',
        help='Path to plugin_builds/ directory',
    )
    parser.add_argument(
        '-r', '--registry',
        type=str,
        required=True,
        metavar='BASE',
        help='Registry base (e.g., ghcr.io/redhat-developer/rhdh-plugin-export-overlays, quay.io/rhdh)',
    )
    parser.add_argument(
        '-p', '--packages-file',
        type=str,
        metavar='FILE',
        help='Path to default.packages.yaml. When specified, scrub catalog entities to only '
             'include plugins/packages that reference core packages from this file.',
    )
    parser.add_argument(
        '-e', '--exclude-packages-file',
        type=str,
        metavar='FILE',
        help='Path to default.packages.yaml. When specified, scrub catalog entities to EXCLUDE '
             'plugins/packages that reference core packages from this file (inverse of --packages-file).',
    )
    parser.add_argument(
        '-c', '--catalog-entities-dir',
        type=str,
        metavar='PATH',
        help='Path to catalog-entities/extensions/ source directory. '
             'Defaults to <overlays-dir>/catalog-entities/extensions/',
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug output',
    )

    args = parser.parse_args()

    DEBUG = args.debug
    REGISTRY_BASE = args.registry.rstrip('/')

    overlays_dir = Path(args.overlays_dir)
    output_dir = Path(args.output_dir)
    plugin_builds_dir = Path(args.plugin_builds_dir)
    catalog_entities_dir = Path(args.catalog_entities_dir) if args.catalog_entities_dir else overlays_dir / "catalog-entities" / "extensions"

    if not overlays_dir.exists():
        print(f"Error: Overlays directory not found: {overlays_dir}")
        sys.exit(1)

    print(f"{Colors.GREEN}=== Generate Catalog Index ==={Colors.NORM}\n")

    print(f"{Colors.GREEN}=== Copy catalog-entities/extensions to output ==={Colors.NORM}")
    copy_catalog_entities_extensions(catalog_entities_dir, output_dir)

    print(f"\n{Colors.GREEN}=== Copy workspaces/*/metadata/*.yaml to output packages/ ==={Colors.NORM}")
    yaml_file_names, _ = copy_workspace_metadata_files(overlays_dir, output_dir)

    # Scrub catalog entities based on default.packages.yaml
    if args.packages_file:
        print(f"\n{Colors.GREEN}=== Scrub catalog entities to core packages ==={Colors.NORM}")
        scrub_catalog_entities(output_dir, overlays_dir, args.packages_file)
    elif args.exclude_packages_file:
        print(f"\n{Colors.GREEN}=== Scrub catalog entities (exclude core) ==={Colors.NORM}")
        exclude_scrub_catalog_entities(output_dir, overlays_dir, args.exclude_packages_file)

    print(f"\n{Colors.GREEN}=== Generate index.json from plugin_builds ==={Colors.NORM}")
    index_data, found_plugins, missing_references, plugin_workspace_paths, all_plugin_data = generate_index_json(plugin_builds_dir, output_dir)

    print(f"\n{Colors.GREEN}=== Prune packages/ to match index ==={Colors.NORM}")
    prune_packages_dir(output_dir, found_plugins)

    print(f"\n{Colors.GREEN}=== Update package files with OCI references ==={Colors.NORM}")
    log_debug(f"Found {len(found_plugins)} plugins with valid OCI images")
    update_package_files(output_dir, index_data, found_plugins)

    print(f"\n{Colors.GREEN}=== Regenerate all.yaml files ==={Colors.NORM}")
    regenerate_all_yaml_files(output_dir)

    # Re-derive yaml_file_names from what actually remains after scrub+prune
    packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"
    if packages_dir.exists():
        yaml_file_names = set(
            f.stem for f in packages_dir.glob("*.yaml") if f.name != "all.yaml"
        )

    # Compare YAML files vs plugins found
    if yaml_file_names:
        found_plugins_set = set(found_plugins)
        yaml_without_plugin = yaml_file_names - found_plugins_set
        plugin_without_yaml = found_plugins_set - yaml_file_names

        if yaml_without_plugin or plugin_without_yaml:
            print(f"\n========")
            print(f"{Colors.BLUE}[INFO] Catalog Entity vs Plugin Analysis:{Colors.NORM}")
            print(f"  - {len(yaml_file_names)} Catalog Entity Package yaml files moved")
            print(f"  - {len(found_plugins)} plugins found with valid OCI images")

        if yaml_without_plugin:
            print(f"\n{Colors.BLUE}[INFO] {len(yaml_without_plugin)} catalog entity package file(s) without corresponding plugin in index - has the plugin been published?{Colors.NORM}")
            for name in sorted(yaml_without_plugin):
                support = all_plugin_data.get(name, {}).get('support', '')
                workspace_path = plugin_workspace_paths.get(name, name)
                label = support if support else '?UNKNOWN?'
                color = _support_label_color(label)
                print(f"  - {color}[{label}]{Colors.NORM} {workspace_path}")

        if plugin_without_yaml:
            print(f"\n{Colors.BLUE}[INFO] {len(plugin_without_yaml)} plugin(s) without corresponding catalog entity package yaml file - maybe the catalog entity file needs to be renamed?{Colors.NORM}")
            for name in sorted(plugin_without_yaml):
                workspace_path = plugin_workspace_paths.get(name, name)
                support = index_data.get(name, {}).get('support', '')
                label = support if support else '?UNKNOWN?'
                color = _support_label_color(label)
                print(f"  - {color}[{label}]{Colors.NORM} {workspace_path}")

    if missing_references:
        print(f"\n========")
        log_warn(f"Could not find {Colors.RED}{len(missing_references)}{Colors.NORM} plugins listed in plugin_builds/ folder! Remember to export and publish them, then re-run this script.")
        for json_file, plugin_name, reference in missing_references:
            print(f"  - {json_file} > {Colors.RED}https://{reference}{Colors.NORM}")


if __name__ == "__main__":
    main()