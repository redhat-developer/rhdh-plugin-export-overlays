#!/usr/bin/env python3
#
# Shared utilities for catalog index generation scripts.
#
# Provides logging, package file loading, workspace metadata resolution,
# and multi-format package list handling (YAML npm names + txt workspace paths).

import atexit
import json
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
    with open(plugins_list_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            path = line.split(':')[0].strip()
            if path:
                paths.append(path)
    return paths

def detect_file_format(file_path: str) -> str:
    """Returns 'yaml' or 'txt' based on file extension."""
    p = Path(file_path)
    if p.suffix in ('.yaml', '.yml'):
        return 'yaml'
    return 'txt'


def load_filtered_packages_from_yaml(packages_file: str) -> set[str]:
    """Load npm package names from a packages YAML file.

    Reads a YAML file in the ``default.packages.yaml`` format and returns
    the union of npm package names from both the ``enabled`` and ``disabled``
    sections under the top-level ``packages`` key.

    Args:
        packages_file: Path to the packages YAML file.

    Returns:
        Set of npm package name strings.

    Example:
        Given a YAML file with::

            packages:
              enabled:
                - package: "@backstage-community/plugin-techdocs"
              disabled:
                - package: "@backstage-community/plugin-foo"

        >>> load_filtered_packages_from_yaml("default.packages.yaml")
        {"@backstage-community/plugin-techdocs", "@backstage-community/plugin-foo"}
    """
    path = Path(packages_file)
    if not path.exists():
        log_error(f"Packages file not found: {packages_file}")
        sys.exit(1)

    with open(path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)

    packages = set()
    for section in ['enabled', 'disabled']:
        for entry in data.get('packages', {}).get(section, []) or []:
            pkg = entry.get('package', '').strip()
            if pkg:
                packages.add(pkg)

    return packages


def load_packages_from_txt(txt_file: str) -> list[str]:
    """Load workspace paths from a plain-text package list file.

    Reads a text file with one workspace path per line. Blank lines and
    lines starting with ``#`` are ignored.

    Args:
        txt_file: Path to the text file (e.g.,
            ``rhdh-supported-packages.txt``).

    Returns:
        List of workspace path strings, in file order.

    Example:
        >>> load_packages_from_txt("rhdh-supported-packages.txt")
        ["backstage/plugins/techdocs", "backstage/plugins/catalog"]
    """
    path = Path(txt_file)
    if not path.exists():
        log_error(f"Packages txt file not found: {txt_file}")
        sys.exit(1)

    paths = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                paths.append(line)
    return paths


@dataclass
class WorkspaceMappings:
    """Bidirectional lookup maps connecting workspace paths, npm names, and stems.

    These four dictionaries allow resolution between the three identifier formats
    used across the repo:

    - **Workspace paths** (``ws_path``): slash-separated paths like
      ``"backstage/plugins/techdocs"`` drawn from ``plugins-list.yaml``.
    - **npm names**: scoped package names like
      ``"@backstage-community/plugin-techdocs"`` from ``spec.packageName``
      in Package entity YAMLs.
    - **Stems**: the ``metadata.name`` field from Package entity YAMLs, e.g.
      ``"backstage-community-plugin-techdocs"``. These are the canonical
      identifiers used for filtering throughout catalog index generation.

    Attributes:
        ws_path_to_npm: Maps workspace path to npm package name.
            Example: ``{"backstage/plugins/techdocs": "@backstage-community/plugin-techdocs"}``
        ws_path_to_stem: Maps workspace path to metadata entity stem.
            Example: ``{"backstage/plugins/techdocs": "backstage-community-plugin-techdocs"}``
        npm_to_stem: Maps npm package name to metadata entity stem.
            Example: ``{"@backstage-community/plugin-techdocs": "backstage-community-plugin-techdocs"}``
        stem_to_npm: Maps metadata entity stem to npm package name.
            Example: ``{"backstage-community-plugin-techdocs": "@backstage-community/plugin-techdocs"}``
    """

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

    Resolves which ``plugins-list.yaml`` path corresponds to each Package
    entity stem, using a two-pass heuristic:

    **Pass 1 -- Scored matching:**
    Every (stem, path) pair is scored based on how the path's last segment
    relates to the stem:

    - Exact match (``stem == last_segment``): highest score
    - Suffix with dash (``stem.endswith("-" + last_segment)``): medium
    - Plain suffix (``stem.endswith(last_segment)``): lowest

    Scores are weighted by segment length to prefer longer (more specific)
    matches. Pairs are then assigned greedily in descending score order,
    ensuring no stem or path is used twice.

    **Pass 2 -- Process of elimination:**
    Remaining unmatched stems are resolved against remaining paths via:

    1. Substring matching (``last_segment in stem``)
    2. 1:1 pairing if the count of unmatched stems equals remaining paths

    Any stems still unmatched fall back to ``"{ws_name}/{stem}"``.

    Args:
        ws_name: Workspace directory name (e.g., ``"backstage"``).
        metadata_entries: List of ``(stem, npm_name)`` pairs from Package
            entity YAMLs in ``workspaces/{ws_name}/metadata/``.
        plugin_paths: Plugin paths from ``plugins-list.yaml`` (e.g.,
            ``["plugins/techdocs", "plugins/catalog"]``).

    Returns:
        Dict mapping each stem to its full workspace path
        (``"{ws_name}/{plugin_path}"``).

    Example:
        >>> _match_workspace_metadata(
        ...     "backstage",
        ...     [("backstage-community-plugin-techdocs", "@backstage-community/plugin-techdocs")],
        ...     ["plugins/techdocs"],
        ... )
        {"backstage-community-plugin-techdocs": "backstage/plugins/techdocs"}
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
    """Scan all workspaces to build bidirectional maps between workspace paths,
    npm names, and metadata entity stems.

    Iterates over every workspace in ``{overlays_dir}/workspaces/`` and reads:

    - ``workspaces/{ws}/metadata/*.yaml`` -- Package entity YAMLs providing
      ``metadata.name`` (stem) and ``spec.packageName`` (npm name)
    - ``workspaces/{ws}/plugins-list.yaml`` -- plugin paths within the
      upstream source repo

    These are matched via ``_match_workspace_metadata`` to produce the four
    maps in ``WorkspaceMappings``.

    The directory structure consumed::

        workspaces/
          backstage/
            metadata/
              backstage-community-plugin-techdocs.yaml
            plugins-list.yaml
          rhdh/
            metadata/
              ...
            plugins-list.yaml

    Note:
        This scans ALL workspaces in the repo, not just the ones being
        filtered for a particular catalog index tier. The full mapping is
        needed so that any package file (YAML or txt) can be resolved.

    Args:
        overlays_dir: Root of the overlays repository (the directory
            containing the ``workspaces/`` subdirectory).

    Returns:
        A ``WorkspaceMappings`` instance with all four maps populated.

    Example:
        >>> mappings = build_workspace_mappings(Path("/path/to/rhdh-plugin-export-overlays"))
        >>> mappings.npm_to_stem["@backstage-community/plugin-techdocs"]
        'backstage-community-plugin-techdocs'
        >>> mappings.ws_path_to_npm["backstage/plugins/techdocs"]
        '@backstage-community/plugin-techdocs'
    """
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
                with open(yaml_file, 'r', encoding='utf-8') as f:
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
    """Load package lists from multiple files and resolve all entries to
    metadata entity stems.

    Each file is auto-detected as YAML or txt based on extension. YAML files
    contain npm package names (resolved via ``npm_to_stem``); txt files
    contain workspace paths (resolved via ``ws_path_to_stem``). The union
    of all resolved stems across all files is returned.

    Logs warnings for entries that cannot be resolved and debug-level
    messages for cross-file overlaps.

    Args:
        packages_files: Paths to package list files. Supports mixed formats
            (some YAML, some txt) in the same call.
        overlays_dir: Root of the overlays repository (passed through to
            ``build_workspace_mappings``).

    Returns:
        Union of resolved stems from all input files.

    Example:
        >>> # YAML file containing "@backstage-community/plugin-techdocs"
        >>> # resolves to stem "backstage-community-plugin-techdocs"
        >>> stems = load_and_resolve_to_stems(
        ...     ["default.packages.yaml"],
        ...     Path("/path/to/overlays"),
        ... )
        >>> "backstage-community-plugin-techdocs" in stems
        True

        >>> # txt file containing "backstage/plugins/techdocs"
        >>> # resolves to the same stem via workspace mapping
        >>> stems = load_and_resolve_to_stems(
        ...     ["rhdh-supported-packages.txt"],
        ...     Path("/path/to/overlays"),
        ... )
        >>> "backstage-community-plugin-techdocs" in stems
        True
    """
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
    """Load package lists from multiple files and resolve all entries to npm
    package names.

    Each file is auto-detected as YAML or txt based on extension. YAML files
    already contain npm names (validated against workspace metadata); txt files
    contain workspace paths (resolved via ``ws_path_to_npm``). The union of
    all resolved npm names across all files is returned.

    Logs warnings for entries that cannot be resolved and debug-level
    messages for cross-file overlaps.

    Args:
        packages_files: Paths to package list files. Supports mixed formats
            (some YAML, some txt) in the same call.
        overlays_dir: Root of the overlays repository (passed through to
            ``build_workspace_mappings``).

    Returns:
        Union of resolved npm package names from all input files.

    Example:
        >>> # txt file containing "backstage/plugins/techdocs"
        >>> # resolves to npm name "@backstage-community/plugin-techdocs"
        >>> npms = load_and_resolve_to_npm_names(
        ...     ["rhdh-supported-packages.txt"],
        ...     Path("/path/to/overlays"),
        ... )
        >>> "@backstage-community/plugin-techdocs" in npms
        True

        >>> # YAML file entries are validated and passed through directly
        >>> npms = load_and_resolve_to_npm_names(
        ...     ["default.packages.yaml"],
        ...     Path("/path/to/overlays"),
        ... )
        >>> "@backstage-community/plugin-techdocs" in npms
        True
    """
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


class BuildReport:
    """Manages a build-report.json file for tracking plugin generation stages.

    Tracks per-plugin build progress through named stages (e.g., bootstrap,
    export, publish), each with a pass/fail/skip status. On ``save()``,
    computes per-plugin overall status and an aggregate summary.

    Passing ``None`` as the report file disables all operations (methods
    become no-ops). An ``atexit`` handler is registered to auto-save on
    process exit when reporting is enabled.

    Args:
        report_file: Path to the JSON report file, or ``None`` to disable.

    Example:
        >>> report = BuildReport("build-report.json")
        >>> report.set_metadata(backstage_version="1.45.1")
        >>> report.add_plugin("plugin-techdocs", package="@backstage-community/plugin-techdocs")
        >>> report.set_stage("plugin-techdocs", "bootstrap", "pass", oci_ref="quay.io/...")
        >>> report.set_stage("plugin-techdocs", "export", "pass")
        >>> report.save()  # writes JSON with overall="pass", summary counts
    """

    def __init__(self, report_file: str | None):
        self._path = Path(report_file) if report_file else None
        self._data: dict = {}
        if self._path and self._path.exists():
            try:
                with open(self._path, 'r', encoding='utf-8') as f:
                    self._data = json.load(f)
            except (json.JSONDecodeError, OSError):
                self._data = {"metadata": {}, "plugins": {}}
        elif self._path:
            self._data = {"metadata": {}, "plugins": {}}
        if self._path:
            atexit.register(self.save)

    @property
    def enabled(self) -> bool:
        return self._path is not None

    def set_metadata(self, **fields) -> None:
        """Update top-level metadata fields (e.g., backstage_version, node_version)."""
        if not self.enabled:
            return
        self._data.setdefault("metadata", {}).update(fields)

    def add_plugin(self, plugin_name: str, **info) -> None:
        """Register a plugin in the report with optional info fields (e.g., package, version)."""
        if not self.enabled:
            return
        plugin = self._data.setdefault("plugins", {}).setdefault(
            plugin_name, {"stages": {}}
        )
        for k, v in info.items():
            if k != "stages":
                plugin[k] = v

    def set_stage(self, plugin_name: str, stage: str, status: str, **details) -> None:
        """Record the outcome of a build stage for a specific plugin."""
        if not self.enabled:
            return
        plugin = self._data.setdefault("plugins", {}).setdefault(
            plugin_name, {"stages": {}}
        )
        stage_data = {"status": status}
        stage_data.update(details)
        plugin.setdefault("stages", {})[stage] = stage_data

    def get_stage(self, plugin_name: str, stage: str) -> dict | None:
        """Return the mutable stage dict for a plugin, or None if not found."""
        if not self.enabled:
            return None
        return (
            self._data
            .get("plugins", {})
            .get(plugin_name, {})
            .get("stages", {})
            .get(stage)
        )

    def set_stage_all(self, stage: str, status: str, **details) -> None:
        """Apply the same stage outcome to every plugin currently in the report."""
        if not self.enabled:
            return
        for plugin_name in self._data.get("plugins", {}):
            self.set_stage(plugin_name, stage, status, **details)

    def save(self) -> None:
        """Compute per-plugin overall status and summary counts, then write to disk."""
        if not self.enabled:
            return

        for plugin in self._data.get("plugins", {}).values():
            stages = plugin.get("stages", {})
            if any(s.get("status") == "outdated" for s in stages.values()):
                plugin["overall"] = "outdated"
            elif any(s.get("status") == "fail" for s in stages.values()):
                plugin["overall"] = "fail"
            elif stages and all(
                s.get("status") in ("pass", "skip") for s in stages.values()
            ):
                plugin["overall"] = "pass"
            else:
                plugin["overall"] = "pending"

        plugins = self._data.get("plugins", {})
        total = len(plugins)
        succeeded = sum(1 for p in plugins.values() if p.get("overall") == "pass")
        failed = sum(1 for p in plugins.values() if p.get("overall") == "fail")
        outdated = sum(1 for p in plugins.values() if p.get("overall") == "outdated")

        self._data["summary"] = {
            "total": total,
            "succeeded": succeeded,
            "failed": failed,
            "outdated": outdated,
        }

        if total == 0:
            self._data["status"] = "initial"
        elif failed == 0 and outdated == 0:
            self._data["status"] = "success"
        else:
            self._data["status"] = "partial"

        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, 'w', encoding='utf-8') as f:
            json.dump(self._data, f, indent=2)
            f.write('\n')
