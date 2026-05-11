#!/usr/bin/env python3
#
# Copyright (c) Red Hat, Inc.
# This program and the accompanying materials are made
# available under the terms of the Eclipse Public License 2.0
# which is available at https://www.eclipse.org/legal/epl-2.0/
#
# SPDX-License-Identifier: EPL-2.0
#
# Update plugin_builds/*.json files with container image metadata:
# - digest: sha256 digest of the image
# - build-date: from container label
# - vcs-ref: from container label
# - upstream: from container env UPSTREAM_REPO
# - midstream: from container env MIDSTREAM_REPO

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import requests
import yaml

from plugin_utils import (
    Colors,
    log_debug,
    log_info,
    log_warn,
    log_error,
    set_debug,
)

# Global registry config
REGISTRY_BASE = ""

# Registry path constants
QUAY_RHDH_PREFIX = "quay.io/rhdh/"
RARC_DOMAIN = "registry.access.redhat.com"
RARC_RHDH_PREFIX = RARC_DOMAIN + "/rhdh/"

DYNAMIC_PACKAGES_ANNOTATION = "io.backstage.dynamic-packages"


def is_downstream_quay_rhdh() -> bool:
    """Check if we're in downstream mode (quay.io/rhdh — NOT quay.io/rhdh-community)"""
    return REGISTRY_BASE + "/" == QUAY_RHDH_PREFIX


def is_downstream_rarc() -> bool:
    """Check if the user requested registry.access.redhat.com output via -r"""
    return REGISTRY_BASE.startswith(RARC_DOMAIN)


def _is_quay_rhdh_ref(registry_reference: str) -> bool:
    """Check if a registry reference targets quay.io/rhdh/ (not quay.io/rhdh-community/)."""
    return registry_reference.startswith(QUAY_RHDH_PREFIX)


def get_ghcr_token(repository: str) -> Optional[str]:
    """Get anonymous bearer token for ghcr.io"""
    try:
        url = f"https://ghcr.io/token?scope=repository:{repository}:pull&service=ghcr.io"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return response.json().get("token")
    except Exception as e:
        log_debug(f"Failed to get ghcr.io token for {repository}: {e}")
        return None


def get_registry_auth(registry: str, repository: str):
    """
    Get authentication for a registry.
    Returns (auth_tuple, headers_dict) where auth_tuple is for basic auth
    and headers_dict contains bearer token if applicable.
    """
    auth = None
    extra_headers = {}

    if registry == "ghcr.io":
        token = get_ghcr_token(repository)
        if token:
            extra_headers['Authorization'] = f"Bearer {token}"
    else:
        username = os.environ.get('REGISTRY_USERNAME')
        password = os.environ.get('REGISTRY_PASSWORD')
        if username and password:
            auth = (username, password)

    return auth, extra_headers


def get_query_registry_reference(registry_reference: str) -> str:
    """
    Get the registry reference to use for querying.
    For registry.access.redhat.com refs, swap to quay.io for unauthenticated verification.
    Per-reference check — works with mixed-registry plugin_builds.
    """
    if registry_reference.startswith(RARC_RHDH_PREFIX):
        return registry_reference.replace(RARC_RHDH_PREFIX, QUAY_RHDH_PREFIX)
    return registry_reference


def get_output_registry_reference(registry_reference: str) -> str:
    """
    Get the registry reference to use for output/storage.
    Only swap quay.io/rhdh/ → registry.access.redhat.com/rhdh/ when the user
    explicitly requested r.a.r.c output via -r registry.access.redhat.com/rhdh.
    """
    if is_downstream_rarc() and _is_quay_rhdh_ref(registry_reference):
        return registry_reference.replace(QUAY_RHDH_PREFIX, RARC_RHDH_PREFIX)
    return registry_reference


def get_image_metadata(registry_reference: str) -> Optional[Dict[str, str]]:
    """
    Get container image metadata from Docker Registry HTTP API v2
    Returns: dict with 'digest', 'build-date', 'vcs-ref', 'upstream', 'midstream' or None if failed
    """
    try:
        query_ref = get_query_registry_reference(registry_reference)

        # Parse the registry reference: registry.io/repo/image:tag
        parts = query_ref.split('/', 1)
        if len(parts) < 2:
            log_error(f"Invalid registry reference format: {query_ref}")
            return None

        registry = parts[0]
        image_and_tag = parts[1]

        # Split image from tag/digest
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

        auth, extra_headers = get_registry_auth(registry, repository)

        headers = {
            'Accept': 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'
        }
        headers.update(extra_headers)

        # Get manifest to obtain digest
        manifest_url = f"https://{registry}/v2/{repository}/manifests/{tag}"
        manifest_response = requests.get(manifest_url, headers=headers, auth=auth, timeout=30)

        if manifest_response.status_code != 200:
            return None

        # Get digest from Docker-Content-Digest header
        digest = manifest_response.headers.get('Docker-Content-Digest')
        if not digest:
            import hashlib
            digest = 'sha256:' + hashlib.sha256(manifest_response.content).hexdigest()

        manifest = manifest_response.json()

        # Get config blob to extract labels
        config_digest = None
        if 'config' in manifest and 'digest' in manifest['config']:
            config_digest = manifest['config']['digest']

        metadata = {'digest': digest}

        # Extract OCI manifest-level annotations (e.g., io.backstage.dynamic-packages)
        manifest_annotations = manifest.get('annotations', {})
        dynamic_packages = manifest_annotations.get(DYNAMIC_PACKAGES_ANNOTATION)
        if dynamic_packages:
            metadata[DYNAMIC_PACKAGES_ANNOTATION] = dynamic_packages

        if config_digest:
            blob_url = f"https://{registry}/v2/{repository}/blobs/{config_digest}"
            blob_response = requests.get(blob_url, headers=headers, auth=auth, timeout=30)

            if blob_response.status_code == 200:
                config = blob_response.json()
                config_data = config.get('config', {})

                labels = config_data.get('Labels', {})
                if 'build-date' in labels:
                    metadata['build-date'] = labels['build-date']
                if 'vcs-ref' in labels:
                    metadata['vcs-ref'] = labels['vcs-ref']

                env_vars = config_data.get('Env', [])
                for env_var in env_vars:
                    if env_var.startswith('UPSTREAM_REPO='):
                        metadata['upstream'] = env_var.split('=', 1)[1]
                    elif env_var.startswith('MIDSTREAM_REPO='):
                        metadata['midstream'] = env_var.split('=', 1)[1]

        return metadata

    except requests.exceptions.Timeout:
        log_warn(f"Timeout getting metadata for {registry_reference}")
        return None
    except requests.exceptions.RequestException as e:
        log_warn(f"Error getting metadata for {registry_reference}: {e}")
        return None
    except Exception as e:
        log_warn(f"Unexpected error getting metadata for {registry_reference}: {e}")
        return None


def update_plugin_build_files(plugin_builds_dir: Path, overlays_dir: Path) -> Tuple[int, int, List[str], int]:
    """
    Update all plugin_builds/*.json files with image metadata
    Returns: (updated_count, error_count, missing_refs, overlays_metadata_changes)
    """
    if not plugin_builds_dir.exists():
        log_error(f"Plugin builds directory {plugin_builds_dir} does not exist")
        sys.exit(1)

    json_files = list(plugin_builds_dir.glob("*/*.json"))

    if not json_files:
        log_error("No JSON files found in plugin_builds/")
        sys.exit(1)

    updated_count = 0
    error_count = 0
    missing_refs = []
    overlays_metadata_changes = 0

    for i, json_file in enumerate(json_files, 1):
        relative_path = json_file.relative_to(plugin_builds_dir)
        print(f"[{i}/{len(json_files)}] {relative_path}", end="")

        try:
            with open(json_file, 'r') as f:
                data = json.load(f)

            modified = False

            for plugin_name, plugin_data in data.items():
                registry_reference = plugin_data.get('registryReference')

                if registry_reference:
                    log_debug(f"\nFetching metadata for {registry_reference}")

                    metadata = get_image_metadata(registry_reference)

                    if metadata:
                        if 'digest' in metadata:
                            plugin_data['digest'] = metadata['digest']
                            modified = True

                        if 'build-date' in metadata:
                            plugin_data['build-date'] = metadata['build-date']
                            modified = True

                        if 'vcs-ref' in metadata:
                            plugin_data['vcs-ref'] = metadata['vcs-ref']
                            modified = True

                        if 'upstream' in metadata:
                            plugin_data['upstream'] = metadata['upstream']
                            modified = True

                        if 'midstream' in metadata:
                            plugin_data['midstream'] = metadata['midstream']
                            modified = True

                        if DYNAMIC_PACKAGES_ANNOTATION in metadata:
                            plugin_data[DYNAMIC_PACKAGES_ANNOTATION] = metadata[DYNAMIC_PACKAGES_ANNOTATION]
                            modified = True

                        output_ref = get_output_registry_reference(registry_reference)
                        if output_ref != registry_reference:
                            log_debug(f"registry_reference switched to: {output_ref}")
                            plugin_data['registryReference'] = output_ref
                            registry_reference = output_ref
                    else:
                        print(" ")
                        missing_refs.append(registry_reference)
                        log_warn(f"[{Colors.YELLOW}{len(missing_refs)}{Colors.NORM}] Could not find metadata for https://{Colors.YELLOW}{registry_reference}{Colors.NORM} !")
                        print(" ")
                else:
                    fields_removed = []
                    for field in ['digest', 'build-date', 'vcs-ref', 'upstream', 'midstream', DYNAMIC_PACKAGES_ANNOTATION]:
                        if field in plugin_data:
                            del plugin_data[field]
                            fields_removed.append(field)
                            modified = True

            if modified:
                ordered_data = {}
                key_order = ['workspacePath', 'registryReference', 'digest', 'build-date', 'upstream', 'midstream', 'vcs-ref']

                for plugin_name, plugin_data in data.items():
                    ordered_plugin = {}
                    for key in key_order:
                        if key in plugin_data:
                            ordered_plugin[key] = plugin_data[key]
                    for key, value in plugin_data.items():
                        if key not in ordered_plugin:
                            ordered_plugin[key] = value
                    ordered_data[plugin_name] = ordered_plugin

                with open(json_file, 'w') as f:
                    json.dump(ordered_data, f, indent=2)
                    f.write('\n')
                updated_count += 1
                print(
                    f" >> https://{Colors.GREEN}"
                    f"{get_query_registry_reference(registry_reference)}"
                    f"{Colors.NORM}"
                )

                # Update the equivalent metadata.yaml file in the overlays directory
                # Skip metadata write-back for ghcr.io — those images use tagged dynamicArtifacts
                # and don't include build-date labels (per-reference check)
                if registry_reference.startswith("ghcr.io/"):
                    log_debug(f"Skipping metadata write-back for ghcr.io plugin: {relative_path}")
                else:
                    metadata_dir = overlays_dir / "workspaces" / relative_path.parent / "metadata"
                    if metadata_dir.exists():
                        for plugin_name, plugin_data in data.items():
                            registry_reference_tag = plugin_data.get('registryReference', '')
                            if not registry_reference_tag:
                                continue
                            digest = plugin_data.get("digest")
                            registry_reference_digest = registry_reference_tag
                            if digest:
                                ref_base = (registry_reference_tag.split("@")[0] if "@" in registry_reference_tag
                                            else registry_reference_tag.rsplit(":", 1)[0])
                                registry_reference_digest = f"{ref_base}@{digest}"
                            registry_reference_digest = get_output_registry_reference(registry_reference_digest)
                            metadata_file = None
                            for f in metadata_dir.glob("*.yaml"):
                                try:
                                    with open(f, "r") as fp:
                                        meta = yaml.safe_load(fp)
                                    spec = (meta or {}).get("spec") or {}
                                    pkg = spec.get("packageName") or ""
                                    da = spec.get("dynamicArtifact") or ""
                                    log_debug(f"pkg: {pkg}; f.stem: {f.stem}; plugin_name: {plugin_name}")
                                    image_in_artifact = ("/" + plugin_name + ":" in da or "/" + plugin_name + "@" in da)
                                    stem_matches = f.stem.replace("redhat-backstage-plugin-", "red-hat-developer-hub-backstage-plugin-") == plugin_name
                                    if image_in_artifact or stem_matches or f.stem == plugin_name:
                                        metadata_file = f
                                        break
                                except Exception:
                                    continue
                            if metadata_file is not None:
                                with open(metadata_file, "r") as f:
                                    content = f.read()
                                try:
                                    meta = yaml.safe_load(content)
                                    da = ((meta or {}).get("spec") or {}).get("dynamicArtifact") or ""
                                except Exception:
                                    da = ""
                                if da.startswith("oci://"):
                                    new_oci = f"oci://{registry_reference_digest}"
                                    lines = content.splitlines()
                                    out = []
                                    for line in lines:
                                        stripped = line.lstrip()
                                        if stripped.startswith("dynamicArtifact:") and ("oci://" in line or "quay.io" in line or "registry.access" in line):
                                            indent = line[: len(line) - len(stripped)]
                                            tag_parts = registry_reference_tag.split(":")
                                            tag = tag_parts[1] if len(tag_parts) > 1 else ""
                                            build_date = plugin_data.get("build-date")
                                            while out and out[-1].lstrip().startswith("# Tag:"):
                                                out.pop()
                                            if build_date:
                                                out.append(f'{indent}# Tag: {tag}, Build date: {build_date}')
                                            else:
                                                out.append(f'{indent}# Tag: {tag}')
                                            out.append(f'{indent}dynamicArtifact: "{new_oci}"')
                                        else:
                                            out.append(line)
                                    with open(metadata_file, "w") as f:
                                        f.write("\n".join(out))
                                        f.write("\n")
                                    overlays_metadata_changes += 1
                                    log_debug(f"Set 'dynamicArtifact: oci://{registry_reference_digest}'")
                                    log_debug(f" in {metadata_file}")
                                    print(
                                        f"[{i}/{len(json_files)}]   >> https://{Colors.GREEN}"
                                        f"{registry_reference_digest.replace('@', ' @')}"
                                        f"{Colors.NORM}\n"
                                    )

        except json.JSONDecodeError as e:
            log_error(f"Error parsing JSON file {json_file}: {e}")
            error_count += 1
        except Exception as e:
            log_error(f"Error processing {json_file}: {e}")
            error_count += 1

    return updated_count, error_count, missing_refs, overlays_metadata_changes


def main():
    usage="""
Usage: python3 generatePluginBuildInfo.py [--debug] \\
    -r|--registry image-registry \\
    [-d|--overlays-dir PATH] \\
    [-b|--plugin-builds-dir PATH]

Examples:
    # From repo root with defaults (overlays-dir=., plugin-builds-dir=plugin_builds)
    python3 generatePluginBuildInfo.py \\
        -r ghcr.io/redhat-developer/rhdh-plugin-export-overlays

    # Enrich specific plugin_builds/ with quay.io/rhdh image metadata
    python3 generatePluginBuildInfo.py \\
        -b plugin_builds/supported \\
        -r quay.io/rhdh
"""

    global REGISTRY_BASE

    parser = argparse.ArgumentParser(
        description='Update plugin_builds/*.json with container image metadata from the registry.',
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
        '--debug',
        action='store_true',
        help='Enable debug output',
    )

    args = parser.parse_args()
    set_debug(args.debug)
    REGISTRY_BASE = args.registry.rstrip('/')

    overlays_dir = Path(args.overlays_dir)
    plugin_builds_dir = Path(args.plugin_builds_dir)

    if not overlays_dir.exists():
        print(f"Error: Overlays directory not found: {overlays_dir}")
        sys.exit(1)

    log_info("\n=== Update plugin_builds/*.json files with container metadata ===")
    updated_count, error_count, missing_refs, overlays_metadata_changes = update_plugin_build_files(plugin_builds_dir, overlays_dir)
    total = updated_count + error_count + len(missing_refs)

    log_info("\n=== Results ===")
    log_info(f"Updated: {Colors.GREEN}{updated_count}{Colors.NORM} of {total}")
    if len(missing_refs) > 0:
        log_warn(f"Missing Tags: {Colors.YELLOW}{len(missing_refs)}{Colors.NORM}")
        for ref in missing_refs:
            log_warn(f"  - https://{Colors.YELLOW}{ref}{Colors.NORM}")
        print(" ")
    if error_count > 0:
        log_error(f"Errors: {Colors.RED}{error_count}{Colors.NORM}")
    if overlays_metadata_changes > 0:
        log_info(f"Changes to overlay repo metadata: {Colors.GREEN}{overlays_metadata_changes}{Colors.NORM}")
        log_info(f"To review changes and create a pull request:\n\tcd {overlays_dir}; git diff")
        print(" ")

if __name__ == "__main__":
    main()
