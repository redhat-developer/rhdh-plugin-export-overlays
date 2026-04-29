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

# Global debug flag
DEBUG = False

# Global registry config
REGISTRY_BASE = ""

class Colors:
    """ANSI color codes for terminal output"""
    NORM = "\033[0;39m"
    GREEN = "\033[1;32m"
    BLUE = "\033[1;34m"
    YELLOW = "\033[1;33m"
    ORANGE = "\033[38;5;208m"
    RED = "\033[1;31m"

def log_debug(message: str) -> None:
    """Print debug message in orange only if DEBUG global is True"""
    if DEBUG:
        print(f"{Colors.ORANGE}[DEBUG]{Colors.NORM} {message}")


def log_notice(message: str) -> None:
    """Print into message in blue"""
    print(f"{message}")


def log_info(message: str) -> None:
    """Print info message in green"""
    print(f"{Colors.GREEN}[INFO]{Colors.NORM} {message}")


def log_warn(message: str) -> None:
    """Print warning message in yellow"""
    print(f"{Colors.YELLOW}[WARN]{Colors.NORM} {message}")


def log_error(message: str) -> None:
    """Print error message in red"""
    print(f"{Colors.RED}[ERROR]{Colors.NORM} {message}")


def is_downstream_quay_rhdh() -> bool:
    """Check if we're in downstream mode (quay.io/rhdh — NOT quay.io/rhdh-community)"""
    return REGISTRY_BASE == "quay.io/rhdh"


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
    In downstream mode (quay.io/rhdh), query quay.io directly.
    Otherwise query the reference as-is.
    """
    if is_downstream_quay_rhdh():
        return registry_reference.replace("registry.access.redhat.com/rhdh/", "quay.io/rhdh/")
    return registry_reference


def get_output_registry_reference(registry_reference: str) -> str:
    """
    Get the registry reference to use for output/storage.
    In downstream mode, swap quay.io/rhdh/ to registry.access.redhat.com/rhdh/.
    """
    if is_downstream_quay_rhdh():
        return registry_reference.replace("quay.io/rhdh/", "registry.access.redhat.com/rhdh/")
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

        # Split image from tag
        if ':' in image_and_tag:
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
                    if DEBUG:
                        print(f"\n")
                        log_debug(f"Fetching metadata for {registry_reference}")

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

                        # In downstream mode, swap quay.io/rhdh refs to registry.access.redhat.com/rhdh
                        if is_downstream_quay_rhdh() and registry_reference.startswith("quay.io/rhdh/"):
                            registry_reference_GA = get_output_registry_reference(registry_reference)
                            log_debug(f"registry_reference switched from quay.io to: {registry_reference_GA}")
                            plugin_data['registryReference'] = registry_reference_GA
                            registry_reference = registry_reference_GA
                    else:
                        print(f" ")
                        missing_refs.append(registry_reference)
                        log_warn(f"[{Colors.YELLOW}{len(missing_refs)}{Colors.NORM}] Could not find metadata for https://{Colors.YELLOW}{registry_reference}{Colors.NORM} !")
                        print(f" ")
                else:
                    fields_removed = []
                    for field in ['digest', 'build-date', 'vcs-ref', 'upstream', 'midstream']:
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
                # and don't include build-date labels
                if "ghcr.io" in REGISTRY_BASE:
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
                            # In downstream mode, ensure output uses registry.access.redhat.com
                            if is_downstream_quay_rhdh():
                                registry_reference_digest = registry_reference_digest.replace("quay.io/rhdh/", "registry.access.redhat.com/rhdh/")
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
                                    if DEBUG:
                                        log_debug(f"Set 'dynamicArtifact: oci://{registry_reference_digest}'")
                                        log_debug(f" in {metadata_file}")
                                    else:
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
    --overlays-dir  /path/to/overlays \\
    --plugin-builds-dir /path/to/plugin_builds \\
    --registry ghcr.io/redhat-developer/rhdh-plugin-export-overlays
"""

    global DEBUG
    global REGISTRY_BASE

    if len(sys.argv) == 1:
        print(usage)
        sys.exit(1)

    parser = argparse.ArgumentParser(
        description='Update plugin_builds/*.json with container image metadata from the registry.',
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
        '--debug',
        action='store_true',
        help='Enable debug output',
    )

    args = parser.parse_args()
    DEBUG = args.debug
    REGISTRY_BASE = args.registry.rstrip('/')

    overlays_dir = Path(args.overlays_dir)
    plugin_builds_dir = Path(args.plugin_builds_dir)

    if not overlays_dir.exists():
        print(f"Error: Overlays directory not found: {overlays_dir}")
        sys.exit(1)

    log_notice("\n=== Update plugin_builds/*.json files with container metadata ===")
    updated_count, error_count, missing_refs, overlays_metadata_changes = update_plugin_build_files(plugin_builds_dir, overlays_dir)
    total = updated_count + error_count + len(missing_refs)

    log_notice(f"\n=== Results ===")
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
