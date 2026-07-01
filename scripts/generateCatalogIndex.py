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
import importlib.util
import json
import os
import re
import shutil
import sys
from collections import OrderedDict
from pathlib import Path
import requests
import yaml

from plugin_utils import (
    BuildReport,
    Colors,
    log_debug,
    log_info,
    log_warn,
    log_error,
    set_debug,
)

# Global registry config
REGISTRY_BASE = ""


def get_image_name_from_package_yaml(yaml_path: Path) -> str | None:
    """Extract the image name from a Package entity YAML file.
    Uses spec.packageName (e.g. @red-hat-developer-hub/backstage-plugin-foo)
    converted to image name format (red-hat-developer-hub-backstage-plugin-foo).
    This matches the key used in plugin_builds JSON and found_plugins.
    Falls back to metadata.name, then filename stem."""
    try:
        with open(yaml_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)
        if not data:
            return yaml_path.stem
        pkg_name = (data.get('spec') or {}).get('packageName', '')
        if pkg_name:
            return pkg_name.lstrip('@').replace('/', '-')
        return data.get('metadata', {}).get('name', yaml_path.stem)
    except Exception:
        return yaml_path.stem


def is_registry_rarc() -> bool:
    """Check if REGISTRY_BASE is registry.access.redhat.com. Used to determine if queries should be routed through quay.io for unauthenticated access."""
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
    """Split a container image reference into its name, tag, and digest components.

    Handles all combinations of tag and digest presence, including references
    with both (tag + digest), tag only, digest only, or empty string input.
    Tag separators vary by registry: ghcr.io uses ``bs_{bsver}__{pluginver}``
    while quay.io/rhdh uses ``{rhdhver}--{pluginver}``.

    Args:
        registry_reference: A container image reference string, e.g.
            ``"quay.io/rhdh/plugin:1.11--1.5.4@sha256:abc123"``.

    Returns:
        A 3-tuple of ``(image_name, tag, digest)`` where any component may
        be an empty string if not present in the input.

    Examples:
        >>> parse_image_reference("quay.io/rhdh/plugin:1.11--1.5.4@sha256:abc123")
        ('quay.io/rhdh/plugin', '1.11--1.5.4', 'sha256:abc123')
        >>> parse_image_reference("quay.io/rhdh/plugin:1.11--1.5.4")
        ('quay.io/rhdh/plugin', '1.11--1.5.4', '')
        >>> parse_image_reference("quay.io/rhdh/plugin@sha256:abc123")
        ('quay.io/rhdh/plugin', '', 'sha256:abc123')
        >>> parse_image_reference("")
        ('', '', '')
    """
    if not registry_reference:
        return "", "", ""

    name_with_tag, sep, digest = registry_reference.partition('@')

    last_slash = name_with_tag.rfind('/')
    last_colon = name_with_tag.rfind(':')
    if last_colon > last_slash:
        return name_with_tag[:last_colon], name_with_tag[last_colon + 1 :], digest if sep else ""

    return name_with_tag, "", digest if sep else ""


TAG_COMMENT_RE = re.compile(r'^\s*# Tag: ([^,]+), Build date: (\S+)\s*$')
OCI_PACKAGE_DIGEST_RE = re.compile(
    r'^\s*(#\s*)?-\s+package:\s+oci://[^\s]+@(sha256:[a-f0-9]+)\s*$'
)
COMMENTED_OCI_PACKAGE_RE = re.compile(r'^\s*#\s*-\s+package:\s+oci://')
MIGRATION_HINT_RE = re.compile(
    r'^\s*#\s*(new approach using oci images|the \'package\' line above|enabled: false)\b'
)


def tag_comment_for_plugin(plugin_data: dict) -> str | None:
    """Build a tag/build-date comment string from plugin build data.

    Constructs a YAML comment line summarizing the image tag and build date
    for a plugin. These comments are inserted above OCI package lines in
    package YAML files and dynamic-plugins.default.yaml to provide
    human-readable provenance.

    Args:
        plugin_data: A dict from plugin_builds JSON containing at minimum
            ``'build-date'``, ``'registryReference'``, and optionally
            ``'imageTag'``. The tag is taken from ``'imageTag'`` if present,
            otherwise extracted from the registryReference.

    Returns:
        A comment string like ``"# Tag: 1.11--1.5.4, Build date: 2025-05-01"``,
        or ``None`` if any of tag, build_date, or digest is missing.

    Example:
        >>> tag_comment_for_plugin({
        ...     'build-date': '2025-05-01',
        ...     'registryReference': 'quay.io/rhdh/plugin:1.11--1.5.4@sha256:abc',
        ...     'imageTag': '1.11--1.5.4',
        ... })
        '# Tag: 1.11--1.5.4, Build date: 2025-05-01'
    """
    build_date = plugin_data.get('build-date') or ''
    tag = plugin_data.get('imageTag') or ''
    _, fallback_tag, digest = parse_image_reference(plugin_data.get('registryReference', ''))
    tag = tag or fallback_tag
    if tag and build_date and digest:
        return f"# Tag: {tag}, Build date: {build_date}"
    return None


def is_tag_comment_line(line: str) -> bool:
    """Check if a line matches the ``# Tag: ..., Build date: ...`` pattern."""
    return bool(TAG_COMMENT_RE.match(line))


def tag_comment_line_text(comment: str) -> str:
    """Wrap a tag comment string with 2-space indentation and trailing newline."""
    return f"  {comment}\n"


def pop_trailing_tag_comments(new_lines: list[str]) -> None:
    """Remove trailing tag comment lines from the end of a line buffer."""
    while new_lines and is_tag_comment_line(new_lines[-1]):
        new_lines.pop()


def trailing_tag_comment_matches(new_lines: list[str], expected_comment: str | None) -> bool:
    """Check if the last non-blank line in the buffer matches the expected tag comment."""
    if not expected_comment:
        return False
    for line in reversed(new_lines):
        if not line.strip():
            continue
        if is_tag_comment_line(line):
            return line.strip() == expected_comment
        return False
    return False


def digest_from_oci_package_line(line: str) -> str | None:
    """Extract the sha256 digest from an OCI package line, or None if not matched."""
    m = OCI_PACKAGE_DIGEST_RE.match(line)
    return m.group(2) if m else None


def peek_digest_after(lines: list[str], idx: int) -> str | None:
    """Look ahead in lines starting after idx to find the next OCI package digest."""
    j = idx + 1
    while j < len(lines):
        nl = lines[j]
        if not nl.strip():
            j += 1
            continue
        if is_tag_comment_line(nl):
            j += 1
            continue
        digest = digest_from_oci_package_line(nl)
        if digest:
            return digest
        return None
    return None


def inject_dpdy_tag_comments(output_dir: Path, plugin_builds_dir: Path) -> None:
    """Delegate to injectDpdyTagComments.py to add Tag/Build date comments to dynamic-plugins.default.yaml."""
    dpdy = output_dir / "dynamic-plugins.default.yaml"
    script = Path(__file__).resolve().parent / "injectDpdyTagComments.py"
    if not dpdy.is_file() or not script.is_file():
        return
    spec = importlib.util.spec_from_file_location("injectDpdyTagComments", script)
    if spec is None or spec.loader is None:
        return
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if mod.inject(dpdy, plugin_builds_dir):
        log_debug(f"Injected Tag/Build date comments into {dpdy.name}")


def build_digest_comment_map(index_data: dict[str, dict]) -> dict[str, str]:
    """Build a mapping from sha256 digests to their tag comment strings.

    Iterates over index data and creates a lookup dict so that OCI package
    lines containing a digest can be matched to their corresponding
    human-readable tag comment.

    Args:
        index_data: The combined index dict mapping plugin names to their
            plugin data dicts (as produced by ``generate_index_json``).

    Returns:
        A dict mapping digest strings to comment strings, e.g.
        ``{"sha256:abc123": "# Tag: 1.11--1.5.4, Build date: 2025-05-01"}``.
        Only entries with a valid tag comment and digest are included.

    Example:
        >>> build_digest_comment_map({
        ...     "my-plugin": {
        ...         "registryReference": "quay.io/rhdh/plugin@sha256:abc123",
        ...         "imageTag": "1.11--1.5.4",
        ...         "build-date": "2025-05-01",
        ...     }
        ... })
        {'sha256:abc123': '# Tag: 1.11--1.5.4, Build date: 2025-05-01'}
    """
    digest_comment_map: dict[str, str] = {}
    for pdata in index_data.values():
        comment = tag_comment_for_plugin(pdata)
        if not comment:
            continue
        _, _, digest = parse_image_reference(pdata.get('registryReference', ''))
        if digest:
            digest_comment_map[digest] = comment
    return digest_comment_map

def copy_catalog_entities_extensions(source_dir: Path, output_dir: Path) -> None:
    """Copy the catalog-entities/extensions/ source directory to the output directory."""
    target_dir = output_dir / "catalog-entities" / "extensions"

    if not source_dir.exists():
        log_warn(f"Source directory {source_dir} does not exist. Skipping.")
        return

    if source_dir.resolve() == target_dir.resolve():
        log_info(f"Source and target are the same directory, skipping copy:\n  {source_dir}")
        return

    log_info(f"Copy content from\n  {source_dir} to\n  {target_dir}")

    for item in source_dir.iterdir():
        if item.name == "README.md":
            continue
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
    """Copy workspace metadata YAML files to the output packages directory.

    Finds all ``workspaces/*/metadata/*.yaml`` files in the overlays directory
    and copies them to ``<output_dir>/catalog-entities/extensions/packages/``.
    These are ``kind: Package`` entity files that describe each built plugin
    artifact (version, OCI reference, appConfigExamples).

    Args:
        overlays_dir: Root of the overlays repository containing the
            ``workspaces/`` directory.
        output_dir: Output directory where the catalog index is being
            assembled.

    Returns:
        A 2-tuple of:
        - A set of YAML file base names (stems without extension), e.g.
          ``{"backstage-plugin-techdocs", "backstage-plugin-catalog"}``.
        - A dict mapping each base name to its relative source path, e.g.
          ``{"backstage-plugin-techdocs": "workspaces/backstage/metadata/backstage-plugin-techdocs.yaml"}``.
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
    """Check if a container image exists in the registry using a Docker Registry HTTP API v2 HEAD request."""
    try:
        parts = registry_reference.split('/', 1)
        if len(parts) < 2:
            log_warn(f"Invalid registry reference format: {registry_reference}")
            return False

        registry = parts[0]
        image_and_tag = parts[1]

        if '@' in image_and_tag:
            name_part, tag = image_and_tag.split('@', 1)
            if ':' in name_part:
                repository = name_part.rsplit(':', 1)[0]
            else:
                repository = name_part
        elif ':' in image_and_tag:
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


def generate_index_json(plugin_builds_dir: Path, output_dir: Path, report: BuildReport | None = None) -> tuple[dict[str, dict], list[str], list[tuple[str, str, str]], dict[str, str], dict[str, dict]]:
    """Generate the catalog index.json from plugin_builds/ metadata.

    This is the core pipeline of the catalog index generator. It reads each
    JSON file in ``plugin_builds/``, where each file is a dict mapping
    plugin image names (e.g. ``"red-hat-developer-hub-backstage-plugin-foo"``)
    to plugin data dicts containing fields like ``registryReference``,
    ``digest``, ``build-date``, ``vcs-ref``, ``workspacePath``, and
    ``support``. For each plugin, it verifies the OCI image exists in the
    registry (swapping registry.access.redhat.com queries to quay.io for
    unauthenticated access), then writes all valid entries into an ordered
    ``index.json``.

    The ``plugin_builds/`` directory is pre-filtered by
    ``bootstrapPluginBuilds.py`` to the appropriate tier (supported,
    community, etc.), so no additional filtering is performed here.

    Args:
        plugin_builds_dir: Path to the ``plugin_builds/`` directory
            containing ``<workspace>/*.json`` files.
        output_dir: Output directory where ``index.json`` will be written.
        report: Optional ``BuildReport`` instance for tracking per-plugin
            pass/fail status of the catalog-index stage.

    Returns:
        A 5-tuple of:
        - ``combined_index``: Dict mapping plugin names to their plugin data
          dicts for all plugins whose OCI images were found.
        - ``found_plugins``: List of plugin names with valid OCI images,
          in processing order.
        - ``missing_references``: List of 3-tuples
          ``(json_file_path, plugin_name, reason)`` for plugins that could
          not be resolved.
        - ``plugin_workspace_paths``: Dict mapping plugin names to their
          workspace paths (e.g. ``"workspaces/backstage"``).
        - ``all_plugin_data``: Dict of all plugin data regardless of OCI
          image existence, used for diagnostic reporting.
    """
    catalog_index_json = output_dir / "index.json"

    if not plugin_builds_dir.exists():
        log_error(f"Plugin builds directory {plugin_builds_dir} does not exist")
        sys.exit(1)

    json_files = list(plugin_builds_dir.glob("*/*.json"))

    if not json_files:
        log_warn("No JSON files found in plugin_builds/")
        return {}, [], [], {}, {}

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
            with open(json_file, 'r', encoding='utf-8') as f:
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
                    if report:
                        report.set_stage(
                            plugin_name, "catalog-index", "fail",
                            reason="No registryReference field",
                        )
                    continue

                query_ref = get_query_registry_reference(registry_reference)
                if check_image_exists(query_ref):
                    found_count += 1
                    print(f"[{i}/{len(json_files)}] {registry_reference} ({found_count})")
                    combined_index[plugin_name] = plugin_data
                    found_plugins.append(plugin_name)
                    if report:
                        report.set_stage(plugin_name, "catalog-index", "pass")
                else:
                    missing_count += 1
                    print(f"{Colors.RED}[{i}/{len(json_files)}]{Colors.NORM} {registry_reference} {Colors.RED}could not be resolved{Colors.NORM} ({missing_count})")
                    missing_references.append((str(relative_path), plugin_name, registry_reference))
                    if report:
                        report.set_stage(
                            plugin_name, "catalog-index", "fail",
                            reason=f"Image not found in registry: {registry_reference}",
                        )

        except json.JSONDecodeError as e:
            log_error(f"Error parsing JSON file {json_file}: {e}")
            missing_count += 1
            missing_references.append((str(relative_path), "N/A", f"JSON parse error: {e}"))
        except Exception as e:
            log_error(f"Error processing {json_file}: {e}")
            missing_count += 1
            missing_references.append((str(relative_path), "N/A", f"Error: {e}"))

    if not combined_index:
        log_warn("No plugins with resolvable OCI images found — writing empty catalog-index/index.json")
        catalog_index_json.parent.mkdir(parents=True, exist_ok=True)
        with open(catalog_index_json, 'w', encoding='utf-8') as f:
            json.dump({}, f, indent=2)
            f.write('\n')
        return {}, [], missing_references, plugin_workspace_paths, all_plugin_data

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

    with open(catalog_index_json, 'w', encoding='utf-8') as f:
        json.dump(ordered_index, f, indent=2)
        f.write('\n')

    log_info(f"Regenerated index.json with {Colors.GREEN}{found_count}{Colors.NORM} of {Colors.BLUE}{len(json_files)}{Colors.NORM} plugins")

    if missing_count > 0:
        print("\n========")
        log_warn(f"Could not find {Colors.RED}{missing_count}{Colors.NORM} plugins - remember to export and publish them, then re-run this script")

    return combined_index, found_plugins, missing_references, plugin_workspace_paths, all_plugin_data


def update_package_files(output_dir: Path, index_data: dict[str, dict], found_plugins: list[str], plugin_builds_dir: Path) -> None:
    """Add or update OCI reference entries in package YAML files and dynamic-plugins.default.yaml.

    Performs line-by-line editing on package YAML files and
    ``dynamic-plugins.default.yaml`` to inject OCI image references. Handles
    two distinct patterns:

    1. **Replacing existing OCI lines**: When a ``- package: oci://...`` line
       already exists for the plugin, it is replaced with the current digest
       reference and its tag comment is updated.
    2. **Adding commented OCI blocks**: When only a file-path entry exists
       (``- package: ./dynamic-plugins/dist/...``), a commented-out OCI
       block is added above it with migration hints, preserving the original
       file-path entry.

    Plugin name matching accounts for alternatives: the
    ``red-hat-developer-hub-`` vs ``rhdh-`` prefix, and with/without the
    ``-dynamic`` suffix.

    Also delegates to ``inject_dpdy_tag_comments`` to handle tag comments
    on lines that were not matched by the main loop (e.g., wrapper package
    lines in dynamic-plugins.default.yaml).

    Args:
        output_dir: Output directory containing the catalog index being
            assembled.
        index_data: Combined index dict mapping plugin names to plugin data
            (from ``generate_index_json``).
        found_plugins: List of plugin names with valid OCI images.
        plugin_builds_dir: Path to ``plugin_builds/`` directory, passed
            through to ``inject_dpdy_tag_comments``.
    """
    packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"
    dynamic_plugins_yaml = output_dir / "dynamic-plugins.default.yaml"

    if not packages_dir.exists():
        log_warn(f"Packages directory {packages_dir} does not exist. Skipping.")
        return

    files_updated = 0
    plugins_matched_in_dynamic_yaml = 0
    digest_comment_map = build_digest_comment_map(index_data)

    for plugin_name in found_plugins:
        plugin_data = index_data[plugin_name]
        registry_reference = plugin_data.get('registryReference', '')

        name_no_tag, _, parsed_digest = parse_image_reference(registry_reference)
        registry_reference_for_oci = f"{name_no_tag}@{parsed_digest}" if parsed_digest else registry_reference
        expected_comment = tag_comment_for_plugin(plugin_data)
        expected_oci_line = f"  - package: oci://{registry_reference_for_oci}\n"

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
                with open(yaml_file, 'r', encoding='utf-8') as f:
                    lines = f.readlines()

                new_lines = []
                i = 0
                modified = False

                while i < len(lines):
                    line = lines[i]

                    if COMMENTED_OCI_PACKAGE_RE.match(line) or MIGRATION_HINT_RE.match(line):
                        new_lines.append(line)
                        i += 1
                        continue

                    if is_tag_comment_line(line):
                        j = i + 1
                        while j < len(lines) and not lines[j].strip():
                            j += 1
                        if j < len(lines) and COMMENTED_OCI_PACKAGE_RE.match(lines[j]):
                            new_lines.append(line)
                            i += 1
                            continue
                        digest = peek_digest_after(lines, i)
                        if digest:
                            expected = digest_comment_map.get(digest)
                            if expected and line.strip() == expected:
                                new_lines.append(line)
                        else:
                            new_lines.append(line)
                        i += 1
                        continue

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
                        pop_trailing_tag_comments(new_lines)
                        oci_unchanged = line.rstrip() == expected_oci_line.rstrip()
                        if oci_unchanged and trailing_tag_comment_matches(new_lines, expected_comment):
                            new_lines.append(line)
                            i += 1
                            while i < len(lines):
                                next_line = lines[i]
                                if not next_line.strip():
                                    new_lines.append(next_line)
                                    i += 1
                                    continue
                                if next_line.startswith((' ', '\t')):
                                    if not is_tag_comment_line(next_line):
                                        new_lines.append(next_line)
                                    i += 1
                                    continue
                                if is_tag_comment_line(next_line):
                                    i += 1
                                    continue
                                break
                            continue

                        modified = True
                        preserved_lines = []
                        i += 1
                        while i < len(lines):
                            next_line = lines[i]
                            if not next_line.strip():
                                i += 1
                                continue
                            if next_line.startswith((' ', '\t')):
                                if not is_tag_comment_line(next_line):
                                    preserved_lines.append(next_line)
                                i += 1
                                continue
                            if is_tag_comment_line(next_line):
                                i += 1
                                continue
                            break

                        if expected_comment:
                            new_lines.append(tag_comment_line_text(expected_comment))
                        new_lines.append(expected_oci_line)
                        for pl in preserved_lines:
                            new_lines.append(pl)
                        continue

                    matched = False
                    for pname in [plugin_name, plugin_name_alternative,
                                  plugin_name_with_dynamic, plugin_name_alternative_with_dynamic]:
                        pattern = rf'^  - package: \.\/dynamic-plugins\/dist\/{re.escape(pname)}\s*$'
                        if re.match(pattern, line):
                            commented_oci = f"  # - package: oci://{registry_reference_for_oci}\n"
                            block_exists = commented_oci.rstrip() in {
                                l.rstrip() for l in new_lines[-15:]
                            }
                            if block_exists:
                                if expected_comment and not trailing_tag_comment_matches(
                                    new_lines, expected_comment
                                ):
                                    pop_trailing_tag_comments(new_lines)
                                    modified = True
                                    new_lines.append(tag_comment_line_text(expected_comment))
                            else:
                                pop_trailing_tag_comments(new_lines)
                                modified = True
                                new_lines.append(commented_oci)
                                if expected_comment:
                                    new_lines.append(tag_comment_line_text(expected_comment))
                                new_lines.append(
                                    "  # new approach using oci images: to switch to the new approach, uncomment\n"
                                )
                                new_lines.append(
                                    "  # the 'package' line above and remove the next two lines, keeping the pluginConfig.\n"
                                )
                                new_lines.append("  # enabled: false\n")

                            new_lines.append(line)

                            i += 1
                            while i < len(lines):
                                next_line = lines[i]
                                if next_line.strip() and not next_line.startswith(' ') and not next_line.startswith('\t'):
                                    break
                                if not is_tag_comment_line(next_line):
                                    new_lines.append(next_line)
                                i += 1

                            log_debug(f"Added OCI reference for {pname} in {yaml_file.name}")
                            i -= 1
                            matched = True
                            break

                    if not matched:
                        empty_artifact_pattern = r"^(\s*)dynamicArtifact:(\s+(?:''|\"\"|\~|null))?\s*$"
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
                    with open(yaml_file, 'w', encoding='utf-8') as f:
                        f.writelines(new_lines)
                    files_updated += 1
                    if yaml_file == dynamic_plugins_yaml:
                        plugins_matched_in_dynamic_yaml += 1

            except Exception as e:
                log_error(f"Error updating {yaml_file}: {e}")

    inject_dpdy_tag_comments(output_dir, plugin_builds_dir)

    if files_updated > 0:
        log_info(f"Updated {files_updated} file(s) with OCI references")
        if dynamic_plugins_yaml.exists():
            log_info(f"Added OCI references for {plugins_matched_in_dynamic_yaml} plugin(s) in dynamic-plugins.default.yaml")
    else:
        if dynamic_plugins_yaml.exists():
            log_warn("No files were updated with OCI references")
        else:
            log_debug("dynamic-plugins.default.yaml not present, skipping DPDY updates")



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
        with open(all_yaml_path, 'w', encoding='utf-8') as f:
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
        'dev-preview': Colors.ORANGE,
    }
    return colors.get(label, Colors.RED)



def main():
    global REGISTRY_BASE

    usage = """
Usage: python3 generateCatalogIndex.py [--debug] \\
    -r|--registry image-registry \\
    [-d|--overlays-dir PATH] \\
    [-o|--output-dir PATH] \\
    [-b|--plugin-builds-dir PATH] \\
    [-c|--catalog-entities-dir PATH]

Examples:
    # Generate supported catalog index
    python3 generateCatalogIndex.py \\
        -o catalog-index/supported \\
        -b plugin_builds/supported \\
        -r quay.io/rhdh

    # Generate community catalog index
    python3 generateCatalogIndex.py \\
        -o catalog-index/community \\
        -b plugin_builds/community \\
        -r ghcr.io/redhat-developer/rhdh-plugin-export-overlays
"""

    parser = argparse.ArgumentParser(
        description='Generate catalog index from plugin_builds and workspace metadata. '
                    'Catalog entities are copied unfiltered; plugin_builds/ is pre-filtered by bootstrapPluginBuilds.py.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=usage
    )
    parser.error = lambda msg: (print(f"\n{Colors.RED}[ERROR] {msg}{Colors.NORM}\n{usage}", file=sys.stderr), sys.exit(2))

    parser.add_argument(
        '-d', '--overlays-dir',
        type=str,
        default='.',
        metavar='PATH',
        help='Path to overlays directory containing workspaces/ and catalog-entities/ (default: .)',
    )
    parser.add_argument(
        '-o', '--output-dir',
        type=str,
        default='catalog-index',
        metavar='PATH',
        help='Output directory for catalog-index (index.json, catalog-entities/, etc.) (default: catalog-index)',
    )
    parser.add_argument(
        '-b', '--plugin-builds-dir',
        type=str,
        default='plugin_builds',
        metavar='PATH',
        help='Path to plugin_builds/ directory (default: plugin_builds)',
    )
    parser.add_argument(
        '-r', '--registry',
        type=str,
        required=True,
        metavar='BASE',
        help='Registry base (e.g., ghcr.io/redhat-developer/rhdh-plugin-export-overlays, quay.io/rhdh)',
    )
    parser.add_argument(
        '-c', '--catalog-entities-dir',
        type=str,
        metavar='PATH',
        help='Path to catalog-entities/extensions/ source directory. '
             'Defaults to <overlays-dir>/catalog-entities/extensions/',
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

    report = BuildReport(args.report_file)

    print(f"\n{Colors.GREEN}=== Generate index.json from plugin_builds ==={Colors.NORM}")
    index_data, found_plugins, missing_references, plugin_workspace_paths, all_plugin_data = generate_index_json(plugin_builds_dir, output_dir, report)

    print(f"\n{Colors.GREEN}=== Update package files with OCI references ==={Colors.NORM}")
    log_debug(f"Found {len(found_plugins)} plugins with valid OCI images")
    update_package_files(output_dir, index_data, found_plugins, plugin_builds_dir)

    print(f"\n{Colors.GREEN}=== Regenerate all.yaml files ==={Colors.NORM}")
    regenerate_all_yaml_files(output_dir)

    # Re-derive yaml_file_names using image names (from spec.packageName) so they
    # match found_plugins keys (which use the same packageName→image-name derivation).
    packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"
    if packages_dir.exists():
        yaml_file_names = {
            get_image_name_from_package_yaml(f)
            for f in packages_dir.glob("*.yaml")
            if f.name != "all.yaml"
        }

    # Compare YAML files vs plugins found
    if yaml_file_names:
        found_plugins_set = set(found_plugins)
        yaml_without_plugin = yaml_file_names - found_plugins_set
        plugin_without_yaml = found_plugins_set - yaml_file_names

        if yaml_without_plugin or plugin_without_yaml:
            print("\n========")
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

    report.save()

    if missing_references:
        print("\n========")
        log_warn(f"Could not find {Colors.YELLOW}{len(missing_references)}{Colors.NORM} plugins listed in plugin_builds/ folder! Remember to export and publish them, then re-run this script.")
        for json_file, _plugin_name, reference in missing_references:
            print(f"  - {json_file} > {Colors.YELLOW}https://{reference}{Colors.NORM}")
        log_warn(f"{len(missing_references)} plugin(s) missing from registry — catalog published without them")


if __name__ == "__main__":
    main()
