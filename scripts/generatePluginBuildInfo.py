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
import hashlib
import json
import os
import re
import sys
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

# Registry path constants
QUAY_RHDH_PREFIX = "quay.io/rhdh/"
RARC_DOMAIN = "registry.access.redhat.com"
RARC_RHDH_PREFIX = RARC_DOMAIN + "/rhdh/"

DYNAMIC_PACKAGES_ANNOTATION = "io.backstage.dynamic-packages"

# Matches a clean version suffix: "2.18.0", "1.5", but NOT ".att", ".sbom", bare SHAs, etc.
VERSION_SUFFIX_RE = re.compile(r'^\d+\.\d+(\.\d+)?$')


def is_downstream_quay_rhdh() -> bool:
    """Check if REGISTRY_BASE is quay.io/rhdh (downstream supported, NOT quay.io/rhdh-community)."""
    return REGISTRY_BASE + "/" == QUAY_RHDH_PREFIX


def is_downstream_rarc() -> bool:
    """Check if the user explicitly requested registry.access.redhat.com output via the ``-r`` flag."""
    return REGISTRY_BASE.startswith(RARC_DOMAIN)


def _is_quay_rhdh_ref(registry_reference: str) -> bool:
    """Per-reference check if a specific ref targets quay.io/rhdh/ (not quay.io/rhdh-community/)."""
    return registry_reference.startswith(QUAY_RHDH_PREFIX)


def get_ghcr_token(repository: str) -> str | None:
    """Get an anonymous bearer token for ghcr.io"""
    try:
        url = f"https://ghcr.io/token?scope=repository:{repository}:pull&service=ghcr.io"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        return response.json().get("token")
    except Exception as e:
        log_debug(f"Failed to get ghcr.io token for {repository}: {e}")
        return None


def get_registry_auth(registry: str, repository: str):
    """Return auth tuple and headers for a given registry.

    ghcr.io uses an anonymous bearer token; all other registries fall back to
    basic auth via ``REGISTRY_USERNAME`` / ``REGISTRY_PASSWORD`` env vars.
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
    """Swap r.a.r.c refs to quay.io/rhdh for unauthenticated querying; leave other refs unchanged.

    Per-reference check, so it works correctly with mixed-registry plugin_builds.
    """
    if registry_reference.startswith(RARC_RHDH_PREFIX):
        return registry_reference.replace(RARC_RHDH_PREFIX, QUAY_RHDH_PREFIX)
    return registry_reference


def get_output_registry_reference(registry_reference: str) -> str:
    """Reverse swap: quay.io/rhdh → r.a.r.c, but ONLY when the user requested r.a.r.c output via ``-r``.

    Leaves non-quay.io/rhdh refs (e.g., ghcr.io, quay.io/rhdh-community) unchanged.
    """
    if is_downstream_rarc() and _is_quay_rhdh_ref(registry_reference):
        return registry_reference.replace(QUAY_RHDH_PREFIX, RARC_RHDH_PREFIX)
    return registry_reference


def parse_registry_reference(registry_reference: str) -> tuple[str, str, str] | None:
    """Parse a container image reference into its (registry, repository, tag_or_digest) parts.

    Accepts ``registry/repository:tag`` or ``registry/repository@sha256:...``
    formats. References targeting registry.access.redhat.com are transparently
    swapped to quay.io/rhdh before parsing via ``get_query_registry_reference``.

    Args:
        registry_reference: Full image reference string, e.g.
            ``"ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0"`` or
            ``"quay.io/rhdh/plugin:1.11--1.5.4"`` or
            ``"registry.access.redhat.com/rhdh/plugin@sha256:abc123"``.

    Returns:
        A tuple ``(registry, repository, tag_or_digest)`` on success, or
        ``None`` if the reference cannot be parsed (e.g. missing ``/``,
        missing both ``:`` and ``@``).

    Example:
        >>> parse_registry_reference("ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0")
        ('ghcr.io', 'org/repo/plugin', 'bs_1.45.3__1.2.0')

        >>> parse_registry_reference("quay.io/rhdh/plugin:1.11--1.5.4")
        ('quay.io', 'rhdh/plugin', '1.11--1.5.4')

        >>> parse_registry_reference("registry.access.redhat.com/rhdh/plugin@sha256:abc123")
        ('quay.io', 'rhdh/plugin', 'sha256:abc123')

        >>> parse_registry_reference("invalid-no-slash")
        None
    """
    query_ref = get_query_registry_reference(registry_reference)
    parts = query_ref.split('/', 1)
    if len(parts) < 2:
        return None
    registry = parts[0]
    image_and_tag = parts[1]
    if '@' in image_and_tag:
        name_part = image_and_tag.split('@', 1)[0]
        repository = name_part.rsplit(':', 1)[0] if ':' in name_part else name_part
        tag = image_and_tag.split('@', 1)[1]
    elif ':' in image_and_tag:
        repository, tag = image_and_tag.rsplit(':', 1)
    else:
        return None
    return registry, repository, tag


def list_tags_with_prefix(registry: str, repository: str, prefix: str, auth, headers: dict) -> list[str]:
    """List all tags matching a prefix from the registry, filtered to clean versions, sorted ascending.

    Queries the Docker Registry HTTP API v2 with pagination to collect all tags,
    then filters to only those starting with ``prefix`` whose suffix is a clean
    version number (e.g. ``2.18.0``, ``1.5``).  This rejects Konflux/Tekton
    build artifacts such as ``.att``, ``.sbom``, ``.sig``, ``.prefetch``, ``.git``,
    ``.src``, ``.dockerfile``, bare SHA tags, ``on-pr-*``, ``rhdh-bsp-*``, etc.

    Args:
        registry: Registry hostname, e.g. ``"ghcr.io"`` or ``"quay.io"``.
        repository: Image repository path, e.g. ``"rhdh/plugin-foo"``.
        prefix: Tag prefix to match, e.g. ``"bs_1.49.4__"`` or ``"1.11--"``.
        auth: Basic-auth tuple ``(username, password)`` or ``None``.
        headers: Request headers dict (must include Accept and any Bearer token).

    Returns:
        Tags sorted in ascending version order.  The last element is the
        latest version.  Empty list if no matching tags are found.

    Example:
        Given these tags in the registry for ``quay.io/rhdh/plugin-foo``::

            "1.11--1.5.4"           # valid
            "1.11--1.3.0"           # valid
            "sha256-abc123.att"     # rejected (doesn't match prefix)
            "on-pr-abc123.prefetch" # rejected (doesn't match prefix)

        With ``prefix="1.11--"``, returns::

            ["1.11--1.3.0", "1.11--1.5.4"]

        Given these tags for ``ghcr.io/org/repo/plugin``::

            "bs_1.49.4__2.14.0"    # valid
            "bs_1.49.4__2.18.0"    # valid
            "sha256:d054dbee..."    # rejected (doesn't match prefix)

        With ``prefix="bs_1.49.4__"``, returns::

            ["bs_1.49.4__2.14.0", "bs_1.49.4__2.18.0"]
    """
    matched = []
    n = 500
    last = ""
    while True:
        url = f"https://{registry}/v2/{repository}/tags/list?n={n}"
        if last:
            url += f"&last={requests.utils.quote(last)}"
        try:
            resp = requests.get(url, headers=headers, auth=auth, timeout=60)
            if resp.status_code != 200:
                break
            data = resp.json()
            tags = data.get("tags") or []
            for t in tags:
                if t.startswith(prefix) and VERSION_SUFFIX_RE.match(t[len(prefix):]):
                    matched.append(t)
            if len(tags) < n:
                break
            last = tags[-1] if tags else ""
            if not last:
                break
        except Exception as e:
            log_debug(f"Error listing tags for {registry}/{repository}: {e}")
            break

    def version_key(tag: str):
        suffix = tag[len(prefix):]
        parts = []
        for p in suffix.split('.'):
            try:
                parts.append((0, int(p)))
            except ValueError:
                parts.append((1, p))
        return parts

    return sorted(matched, key=version_key)


def resolve_fallback_tag(registry_reference: str) -> str | None:
    """Find the latest published tag sharing the same version prefix when the exact tag doesn't exist.

    Constructs a prefix by splitting the tag on the registry-appropriate
    separator (``"__"`` for ghcr.io, ``"--"`` for quay.io/rhdh) and keeping
    everything up to and including the separator. Then queries the registry
    for all tags with that prefix and returns the highest version.

    Args:
        registry_reference: Full image reference with the requested tag, e.g.
            ``"quay.io/rhdh/plugin:1.11--1.6.0"`` or
            ``"ghcr.io/org/repo/plugin:bs_1.45.3__2.18.0"``.

    Returns:
        The full registry reference with the fallback tag substituted, e.g.
        ``"quay.io/rhdh/plugin:1.11--1.5.4"``. Returns ``None`` if no tags
        match the prefix, if the reference cannot be parsed, or if the best
        matching tag equals the originally requested tag (no fallback needed).

    Example:
        If ``quay.io/rhdh/plugin:1.11--1.6.0`` does not exist but
        ``1.11--1.5.4`` and ``1.11--1.3.0`` do::

            >>> resolve_fallback_tag("quay.io/rhdh/plugin:1.11--1.6.0")
            'quay.io/rhdh/plugin:1.11--1.5.4'

        For ghcr.io with prefix ``bs_1.45.3__``::

            >>> resolve_fallback_tag("ghcr.io/org/repo/plugin:bs_1.45.3__2.18.0")
            'ghcr.io/org/repo/plugin:bs_1.45.3__2.14.0'

        When the requested prefix has no tags at all — even if older prefixes
        exist in the registry — the fallback returns ``None``.  For example,
        if the registry has ``1.11--1.5.4`` and ``1.10--1.5.4`` but nothing
        with prefix ``1.12--``::

            >>> resolve_fallback_tag("quay.io/rhdh/plugin:1.12--1.5.4")
            None  # no tags match prefix "1.12--", older prefixes are ignored
    """
    parsed = parse_registry_reference(registry_reference)
    if not parsed:
        return None

    registry, repository, tag = parsed

    # Detect prefix: ghcr.io uses "__", others use "--"
    separator = "__" if registry == "ghcr.io" else "--"
    if separator not in tag:
        return None
    prefix = tag.rsplit(separator, 1)[0] + separator

    auth, extra_headers = get_registry_auth(registry, repository)
    headers = {'Accept': 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'}
    headers.update(extra_headers)

    tags = list_tags_with_prefix(registry, repository, prefix, auth, headers)
    if not tags:
        return None

    best_tag = tags[-1]
    if best_tag == tag:
        return None

    # Reconstruct the reference with the fallback tag (using original registry, not query registry)
    original_ref_base = registry_reference.rsplit(':', 1)[0]
    return f"{original_ref_base}:{best_tag}"


def _fetch_image_metadata(registry_reference: str) -> dict[str, str] | None:
    """Fetch container image metadata via Docker Registry HTTP API v2.

    Retrieves the image manifest to obtain the digest, then fetches the config
    blob to extract build labels and environment variables. References targeting
    registry.access.redhat.com are transparently swapped to quay.io/rhdh for
    querying, since r.a.r.c requires authentication that may not be available.

    Args:
        registry_reference: Full image reference, e.g.
            ``"ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0"`` or
            ``"quay.io/rhdh/plugin:1.11--1.5.4"``.

    Returns:
        A dict of metadata fields on success, or ``None`` on any failure
        (timeout, HTTP error, invalid reference). The returned dict looks like::

            {
                'digest': 'sha256:a1b2c3d4...',
                'build-date': '2025-05-01',
                'vcs-ref': 'abc123def456',
                'upstream': 'https://github.com/org/upstream-repo',
                'midstream': 'https://github.com/org/midstream-repo',
            }

        Not all fields are guaranteed to be present; only ``'digest'`` is
        always included on success. Labels (``build-date``, ``vcs-ref``) and
        env vars (``upstream``, ``midstream``) depend on how the image was
        built.

    Example:
        >>> _fetch_image_metadata("ghcr.io/org/repo/plugin:bs_1.45.3__1.2.0")
        {'digest': 'sha256:a1b2c3...', 'build-date': '2025-05-01', 'vcs-ref': 'abc123'}

        >>> _fetch_image_metadata("quay.io/rhdh/plugin:nonexistent-tag")
        None
    """
    try:
        # Swap r.a.r.c → quay.io for queries as r.a.r.c is not always accessible without authentication
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


def get_image_metadata(registry_reference: str) -> dict | None:
    """Fetch container image metadata, with automatic fallback to the latest published tag.

    Wraps ``_fetch_image_metadata`` with a two-step strategy: first tries the
    exact tag, and if that fails, calls ``resolve_fallback_tag`` to find the
    latest published tag with the same version prefix.

    Args:
        registry_reference: Full image reference, e.g.
            ``"quay.io/rhdh/plugin:1.11--1.6.0"``.

    Returns:
        A metadata dict on success, or ``None`` if metadata could not be
        fetched even after fallback.

        On a **direct hit** (exact tag exists), the dict contains only the
        fields from ``_fetch_image_metadata``::

            {'digest': 'sha256:...', 'build-date': '2025-05-01', ...}

        On a **fallback hit** (exact tag missing, older tag used), the dict
        includes three extra fields::

            {
                'digest': 'sha256:...',
                'build-date': '2025-05-01',
                'registryReference': 'quay.io/rhdh/plugin:1.11--1.5.4',
                'fallback': True,
                'requestedTag': '1.11--1.6.0',
            }

    Example:
        Direct hit (tag ``1.11--1.5.4`` exists)::

            >>> get_image_metadata("quay.io/rhdh/plugin:1.11--1.5.4")
            {'digest': 'sha256:a1b2c3...', 'build-date': '2025-05-01'}

        Fallback hit (tag ``1.11--1.6.0`` missing, ``1.11--1.5.4`` used)::

            >>> get_image_metadata("quay.io/rhdh/plugin:1.11--1.6.0")
            {'digest': 'sha256:a1b2c3...', 'registryReference': 'quay.io/rhdh/plugin:1.11--1.5.4',
             'fallback': True, 'requestedTag': '1.11--1.6.0'}
    """
    metadata = _fetch_image_metadata(registry_reference)
    if metadata is not None:
        return metadata
    
    original_tag = registry_reference.rsplit(':', 1)[-1] if ':' in registry_reference else ""

    fallback_ref = resolve_fallback_tag(registry_reference)
    if fallback_ref is None:
        log_warn(f"Requested tag {Colors.YELLOW}{original_tag}{Colors.NORM} not found, no fallback available")
        return None

    fallback_tag = fallback_ref.rsplit(':', 1)[-1] if ':' in fallback_ref else ""
    
    log_warn(
        f"[FALLBACK] requested tag {Colors.YELLOW}{original_tag}{Colors.NORM} but tag not found,"
        f" using latest published tag {Colors.GREEN}{fallback_tag}{Colors.NORM} instead"
    )

    metadata = _fetch_image_metadata(fallback_ref)
    if metadata is None:
        return None

    metadata['registryReference'] = fallback_ref
    metadata['fallback'] = True
    metadata['requestedTag'] = original_tag
    return metadata


def update_plugin_build_files(plugin_builds_dir: Path, overlays_dir: Path, report: BuildReport | None = None) -> tuple[int, int, list[str], int, int]:
    """Enrich plugin_builds JSON files with container image metadata from the registry.

    The main enrichment pipeline. For each ``plugin_builds/*/*.json`` file,
    fetches image metadata (digest, build-date, vcs-ref, upstream, midstream)
    from the Docker Registry HTTP API v2 and writes the results back into the
    JSON. Also updates the corresponding ``workspaces/*/metadata/*.yaml``
    overlay files with the resolved ``dynamicArtifact`` OCI reference
    (including digest).

    Args:
        plugin_builds_dir: Path to the ``plugin_builds/`` directory containing
            per-workspace subdirectories with JSON files.
        overlays_dir: Path to the overlays repository root (containing
            ``workspaces/``). Used to locate and update metadata YAML files.
        report: Optional ``BuildReport`` instance for tracking per-plugin
            stage results (pass/fail with digest and fallback info).

    Returns:
        A 5-tuple of ``(updated_count, error_count, missing_refs,
        overlays_metadata_changes, fallback_count)`` where:

        - ``updated_count``: Number of JSON files successfully enriched.
        - ``error_count``: Number of JSON files that failed to parse or process.
        - ``missing_refs``: List of registry references where no image was found.
        - ``overlays_metadata_changes``: Number of metadata YAML files updated.
        - ``fallback_count``: Number of plugins that used a fallback tag.
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
    fallback_count = 0

    for i, json_file in enumerate(json_files, 1):
        relative_path = json_file.relative_to(plugin_builds_dir)
        print(f"[{i}/{len(json_files)}] {relative_path}", end="")

        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            modified = False

            for plugin_name, plugin_data in data.items():
                registry_reference = plugin_data.get('registryReference')

                if registry_reference:
                    log_debug(f"\nFetching metadata for {registry_reference}")

                    metadata = get_image_metadata(registry_reference)

                    if metadata:
                        if 'registryReference' in metadata:
                            registry_reference = metadata['registryReference']

                        if metadata.get('fallback'):
                            fallback_count += 1

                        for key, value in metadata.items():
                            if plugin_data.get(key) != value:
                                plugin_data[key] = value
                                modified = True

                        # Clean up stale fallback fields from a previous run
                        if 'fallback' not in metadata:
                            for stale_key in ('fallback', 'requestedTag'):
                                if stale_key in plugin_data:
                                    del plugin_data[stale_key]
                                    modified = True

                        # Output ref swap back from quay.io to registry.access.redhat.com if registry is set as r.a.r.c
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
                        if report:
                            report.set_stage(
                                plugin_name, "image-metadata-fetch", "fail",
                                reason=f"Image not found in registry: {registry_reference}",
                            )
                else:
                    fields_removed = []
                    for field in ['digest', 'build-date', 'vcs-ref', 'upstream', 'midstream', DYNAMIC_PACKAGES_ANNOTATION, 'fallback', 'requestedTag']:
                        if field in plugin_data:
                            del plugin_data[field]
                            fields_removed.append(field)
                            modified = True

            if modified:
                ordered_data = {}
                key_order = ['workspacePath', 'registryReference', 'fallback', 'requestedTag', 'digest', 'build-date', 'upstream', 'midstream', 'vcs-ref']

                for plugin_name, plugin_data in data.items():
                    ordered_plugin = {}
                    for key in key_order:
                        if key in plugin_data:
                            ordered_plugin[key] = plugin_data[key]
                    for key, value in plugin_data.items():
                        if key not in ordered_plugin:
                            ordered_plugin[key] = value
                    ordered_data[plugin_name] = ordered_plugin

                with open(json_file, 'w', encoding='utf-8') as f:
                    json.dump(ordered_data, f, indent=2)
                    f.write('\n')
                updated_count += 1
                print(
                    f" >> https://{Colors.GREEN}"
                    f"{get_query_registry_reference(registry_reference)}"
                    f"{Colors.NORM}"
                )

                if report:
                    for pname, pdata in data.items():
                        digest = pdata.get('digest', '')
                        if digest:
                            stage_kwargs = {"digest": digest}
                            if pdata.get('fallback'):
                                ref_tag = pdata.get('registryReference', '').rsplit(':', 1)[-1]
                                stage_kwargs["fallback"] = True
                                stage_kwargs["requestedTag"] = pdata.get('requestedTag', '')
                                stage_kwargs["resolvedTag"] = ref_tag
                            report.set_stage(
                                pname, "image-metadata-fetch", "pass",
                                **stage_kwargs,
                            )

                # Update the equivalent metadata.yaml file in the overlays directory
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
                                with open(f, "r", encoding='utf-8') as fp:
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
                            with open(metadata_file, "r", encoding='utf-8') as f:
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
                                    if stripped.startswith("dynamicArtifact:") and ("oci://" in line or "quay.io" in line or "registry.access" in line or "ghcr.io" in line):
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
                                with open(metadata_file, "w", encoding='utf-8') as f:
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

    return updated_count, error_count, missing_refs, overlays_metadata_changes, fallback_count


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
    plugin_builds_dir = Path(args.plugin_builds_dir)
    report = BuildReport(args.report_file)

    if not overlays_dir.exists():
        print(f"Error: Overlays directory not found: {overlays_dir}")
        sys.exit(1)

    log_info("\n=== Update plugin_builds/*.json files with container metadata ===")
    updated_count, error_count, missing_refs, overlays_metadata_changes, fallback_count = update_plugin_build_files(plugin_builds_dir, overlays_dir, report)
    total = updated_count + error_count + len(missing_refs)

    log_info("\n=== Results ===")
    log_info(f"Updated: {Colors.GREEN}{updated_count}{Colors.NORM} of {total}")
    if fallback_count > 0:
        log_warn(f"Fallback Tags: {Colors.YELLOW}{fallback_count}{Colors.NORM} plugin(s) using older published tags")
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

    report.save()

if __name__ == "__main__":
    main()
