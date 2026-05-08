#!/usr/bin/env python3
#
# Shared utilities for catalog index generation scripts.
#
# Provides logging, package file loading, workspace metadata resolution,
# and multi-format package list handling (YAML npm names + txt workspace paths).

import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEBUG = False


class Colors:
    NORM = "\033[0;39m"
    GREEN = "\033[1;32m"
    BLUE = "\033[1;34m"
    RED = "\033[1;31m"
    ORANGE = "\033[38;5;208m"
    YELLOW = "\033[1;33m"
    RESET = "\033[0m"


def set_debug(enabled: bool) -> None:
    global DEBUG
    DEBUG = enabled


def log_debug(message: str) -> None:
    if DEBUG:
        print(f"{Colors.ORANGE}[DEBUG]{Colors.NORM} {message}")


def log_info(message: str) -> None:
    print(f"{Colors.GREEN}[INFO]{Colors.NORM} {message}")


def log_warn(message: str) -> None:
    print(f"{Colors.YELLOW}[WARN]{Colors.NORM} {message}")


def log_error(message: str) -> None:
    print(f"{Colors.RED}[ERROR]{Colors.NORM} {message}")


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


def detect_file_format(file_path: str) -> str:
    """Returns 'yaml' or 'txt' based on file extension."""
    p = Path(file_path)
    if p.suffix in ('.yaml', '.yml'):
        return 'yaml'
    return 'txt'


def load_filtered_packages_from_yaml(packages_file: str) -> set[str]:
    """Load filtered package names from default.packages.yaml.
    Returns set of npm package names from both enabled and disabled sections."""
    path = Path(packages_file)
    if not path.exists():
        log_error(f"Packages file not found: {packages_file}")
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


def load_packages_from_txt(txt_file: str) -> list[str]:
    """Load workspace paths from a txt file (e.g., rhdh-supported-packages.txt).
    Returns list of workspace paths like 'backstage/plugins/techdocs'."""
    path = Path(txt_file)
    if not path.exists():
        log_error(f"Packages txt file not found: {txt_file}")
        sys.exit(1)

    paths = []
    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                paths.append(line)
    return paths


@dataclass
class WorkspaceMappings:
    ws_path_to_npm: dict[str, str] = field(default_factory=dict)
    ws_path_to_stem: dict[str, str] = field(default_factory=dict)
    npm_to_stem: dict[str, str] = field(default_factory=dict)
    stem_to_npm: dict[str, str] = field(default_factory=dict)


def _match_workspace_metadata(
    ws_name: str,
    metadata_entries: list[tuple[str, str]],
    plugin_paths: list[str],
) -> dict[str, str]:
    """Match metadata entries to plugin paths within a single workspace.

    Uses scored matching to avoid greedy collisions (e.g., two stems matching
    the same path), then process-of-elimination for remaining unmatched pairs.

    metadata_entries: list of (stem, npm_name) pairs
    plugin_paths: list of plugin paths from plugins-list.yaml
    Returns: dict mapping stem -> workspace_path
    """
    result: dict[str, str] = {}

    if not plugin_paths:
        for stem, npm_name in metadata_entries:
            result[stem] = f"{ws_name}/{stem}"
            log_debug(f"No plugins-list for workspace {ws_name}, using fallback: {ws_name}/{stem}")
        return result

    # Pass 1: build scored candidates — (stem, path, score)
    # Higher score = more specific match. Prefer longest last_segment matches.
    candidates: list[tuple[str, str, int]] = []
    for stem, npm_name in metadata_entries:
        for path in plugin_paths:
            last_seg = path.split('/')[-1]
            if stem == last_seg:
                candidates.append((stem, path, len(last_seg) * 10 + 3))
            elif stem.endswith('-' + last_seg):
                candidates.append((stem, path, len(last_seg) * 10 + 2))
            elif stem.endswith(last_seg):
                candidates.append((stem, path, len(last_seg) * 10 + 1))

    # Assign greedily by score descending, no duplicates on either side
    candidates.sort(key=lambda c: -c[2])
    matched_stems: set[str] = set()
    matched_paths: set[str] = set()
    for stem, path, _score in candidates:
        if stem in matched_stems or path in matched_paths:
            continue
        result[stem] = f"{ws_name}/{path}"
        matched_stems.add(stem)
        matched_paths.add(path)

    # Pass 2: process of elimination for unmatched
    unmatched = [(s, n) for s, n in metadata_entries if s not in matched_stems]
    remaining_paths = [p for p in plugin_paths if p not in matched_paths]

    if unmatched and remaining_paths:
        # Try substring matching on remaining pairs
        still_unmatched = []
        still_available = list(remaining_paths)
        for stem, npm_name in unmatched:
            found = False
            for path in still_available:
                last_seg = path.split('/')[-1]
                if last_seg in stem:
                    result[stem] = f"{ws_name}/{path}"
                    still_available.remove(path)
                    log_debug(f"Matched by substring: {stem} -> {path}")
                    found = True
                    break
            if not found:
                still_unmatched.append((stem, npm_name))

        # Final elimination: pair remaining 1:1 if counts match
        if len(still_unmatched) == len(still_available):
            for (stem, npm_name), path in zip(still_unmatched, still_available):
                result[stem] = f"{ws_name}/{path}"
                log_debug(f"Matched by elimination: {stem} -> {path}")
            still_unmatched = []

        unmatched = still_unmatched

    # Fallback for anything truly unmatched
    for stem, npm_name in unmatched:
        result[stem] = f"{ws_name}/{stem}"
        log_debug(f"No plugins-list match for {stem}, using fallback: {ws_name}/{stem}")

    return result


def build_workspace_mappings(overlays_dir: Path) -> WorkspaceMappings:
    """Scan workspaces/*/metadata/*.yaml and plugins-list.yaml to build
    bidirectional maps between workspace paths, npm names, and stems."""
    mappings = WorkspaceMappings()
    workspaces_dir = overlays_dir / "workspaces"
    if not workspaces_dir.exists():
        return mappings

    log_debug("Scanning all workspaces to build workspace path mappings (this covers the full repo, not just filtered packages)...")

    for ws_dir in sorted(workspaces_dir.iterdir()):
        if not ws_dir.is_dir():
            continue
        metadata_dir = ws_dir / "metadata"
        if not metadata_dir.exists():
            continue

        ws_name = ws_dir.name
        plugin_paths = read_plugins_list(ws_dir)

        # Collect all metadata entries for this workspace
        metadata_entries: list[tuple[str, str]] = []  # (stem, npm_name)
        stem_to_npm_local: dict[str, str] = {}

        for yaml_file in sorted(metadata_dir.glob("*.yaml")):
            try:
                with open(yaml_file, 'r') as f:
                    data = yaml.safe_load(f)
                if not data or data.get('kind') != 'Package':
                    continue

                stem = data.get('metadata', {}).get('name', yaml_file.stem)
                npm_name = data.get('spec', {}).get('packageName', '')
                if not npm_name:
                    continue

                metadata_entries.append((stem, npm_name))
                stem_to_npm_local[stem] = npm_name
            except Exception:
                continue

        # Match all metadata to plugin paths
        stem_to_ws_path = _match_workspace_metadata(ws_name, metadata_entries, plugin_paths)

        for stem, ws_path in stem_to_ws_path.items():
            npm_name = stem_to_npm_local[stem]
            mappings.ws_path_to_npm[ws_path] = npm_name
            mappings.ws_path_to_stem[ws_path] = stem
            mappings.npm_to_stem[npm_name] = stem
            mappings.stem_to_npm[stem] = npm_name

    log_debug(f"Workspace mapping complete: {len(mappings.npm_to_stem)} packages across {len({ p.split('/')[0] for p in mappings.ws_path_to_npm })} workspaces")

    return mappings


def _load_file_entries(file_path: str) -> tuple[str, set[str]]:
    """Load entries from a file, auto-detecting format.
    Returns (format, set_of_entries) where entries are npm names or workspace paths."""
    fmt = detect_file_format(file_path)
    if fmt == 'yaml':
        entries = load_filtered_packages_from_yaml(file_path)
    else:
        entries = set(load_packages_from_txt(file_path))
    log_debug(f"Loaded {len(entries)} packages from {file_path} ({fmt} format)")
    for entry in sorted(entries):
        log_debug(f"  - {entry}")
    return fmt, entries


def load_and_resolve_to_stems(
    packages_files: list[str],
    overlays_dir: Path,
) -> set[str]:
    """Takes a list of file paths (YAML or txt), auto-detects format,
    resolves all to metadata entity stems.
    Returns union of all resolved stems."""
    if not packages_files:
        return set()

    mappings = build_workspace_mappings(overlays_dir)

    per_file_stems: dict[str, set[str]] = {}

    for file_path in packages_files:
        fmt, entries = _load_file_entries(file_path)
        stems = set()

        if fmt == 'yaml':
            for npm_name in entries:
                stem = mappings.npm_to_stem.get(npm_name)
                if stem:
                    stems.add(stem)
                    log_debug(f"Resolved: {npm_name} -> {stem} (from {file_path})")
                else:
                    log_warn(f"Package '{npm_name}' from {file_path} not found in workspace metadata")
        else:
            for ws_path in entries:
                stem = mappings.ws_path_to_stem.get(ws_path)
                if stem:
                    stems.add(stem)
                    log_debug(f"Resolved: {ws_path} -> {stem} (from {file_path})")
                else:
                    log_warn(f"Entry '{ws_path}' from {file_path} could not be resolved to a metadata stem")

        per_file_stems[file_path] = stems

    # Log overlaps between files
    file_list = list(per_file_stems.keys())
    for i in range(len(file_list)):
        for j in range(i + 1, len(file_list)):
            f1, f2 = file_list[i], file_list[j]
            overlap = per_file_stems[f1] & per_file_stems[f2]
            if overlap:
                for stem in sorted(overlap):
                    log_debug(f"Overlap: stem '{stem}' found in both {f1} and {f2}")

    # Build union and log summary
    all_stems = set()
    for stems in per_file_stems.values():
        all_stems |= stems

    if len(packages_files) > 1:
        parts = []
        for fp, stems in per_file_stems.items():
            parts.append(f"{len(stems)} from {fp}")
        total_overlap = sum(
            len(per_file_stems[file_list[i]] & per_file_stems[file_list[j]])
            for i in range(len(file_list))
            for j in range(i + 1, len(file_list))
        )
        log_debug(f"Union: {len(all_stems)} total stems ({', '.join(parts)}, {total_overlap} overlap)")
    else:
        log_debug(f"Resolved {len(all_stems)} stems from {packages_files[0]}")

    return all_stems


def load_and_resolve_to_npm_names(
    packages_files: list[str],
    overlays_dir: Path,
) -> set[str]:
    """Takes a list of file paths (YAML or txt), auto-detects format,
    resolves all to npm package names.
    Returns union of all resolved npm names."""
    if not packages_files:
        return set()

    mappings = build_workspace_mappings(overlays_dir)

    per_file_npms: dict[str, set[str]] = {}

    for file_path in packages_files:
        fmt, entries = _load_file_entries(file_path)
        npms = set()

        if fmt == 'yaml':
            for npm_name in entries:
                if npm_name in mappings.npm_to_stem:
                    npms.add(npm_name)
                    log_debug(f"Resolved: {npm_name} (from {file_path})")
                else:
                    log_warn(f"Package '{npm_name}' from {file_path} not found in workspace metadata")
        else:
            for ws_path in entries:
                npm_name = mappings.ws_path_to_npm.get(ws_path)
                if npm_name:
                    npms.add(npm_name)
                    log_debug(f"Resolved: {ws_path} -> {npm_name} (from {file_path})")
                else:
                    log_warn(f"Entry '{ws_path}' from {file_path} could not be resolved to an npm name")

        per_file_npms[file_path] = npms

    # Log overlaps between files
    file_list = list(per_file_npms.keys())
    for i in range(len(file_list)):
        for j in range(i + 1, len(file_list)):
            f1, f2 = file_list[i], file_list[j]
            overlap = per_file_npms[f1] & per_file_npms[f2]
            if overlap:
                for npm in sorted(overlap):
                    log_debug(f"Overlap: npm '{npm}' found in both {f1} and {f2}")

    # Build union and log summary
    all_npms = set()
    for npms in per_file_npms.values():
        all_npms |= npms

    if len(packages_files) > 1:
        parts = []
        for fp, npms in per_file_npms.items():
            parts.append(f"{len(npms)} from {fp}")
        total_overlap = sum(
            len(per_file_npms[file_list[i]] & per_file_npms[file_list[j]])
            for i in range(len(file_list))
            for j in range(i + 1, len(file_list))
        )
        log_debug(f"Union: {len(all_npms)} total npm names ({', '.join(parts)}, {total_overlap} overlap)")
    else:
        log_debug(f"Resolved {len(all_npms)} npm names from {packages_files[0]}")

    return all_npms
