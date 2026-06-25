"""Shared helpers for CVE yarn.lock backport scripts."""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

CVE_YARN_LOCK_PATCH = "0-cve-yarn-lock.patch"
MANIFEST_NAME = "cve-backports.yaml"
YARN_LOCK_FILENAME = "yarn.lock"
PYYAML_INSTALL_HINT = "PyYAML is required: pip install pyyaml"


def require_yaml() -> None:
    if yaml is None:
        print(PYYAML_INSTALL_HINT, file=sys.stderr)
        raise SystemExit(2)


def read_source_json(overlay_workspace: Path) -> dict:
    source_path = overlay_workspace / "source.json"
    if not source_path.is_file():
        raise FileNotFoundError(f"missing source.json: {source_path}")
    with open(source_path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{source_path}: expected JSON object")
    repo_ref = (data.get("repo-ref") or "").strip()
    if not repo_ref:
        raise ValueError(f"{source_path}: repo-ref is required")
    return data


def _load_manifest_raw(manifest_path: Path) -> dict:
    require_yaml()
    if not manifest_path.is_file():
        return {}
    with open(manifest_path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{manifest_path}: root must be a mapping")
    return data


def manifest_package_bumps(manifest_path: Path) -> list[tuple[str, str]]:
    """Unique (package, patch_version) pairs from cve-backports.yaml."""
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []
    for row in _load_manifest_raw(manifest_path).get("backports") or []:
        if not isinstance(row, dict):
            continue
        package = (row.get("package") or "").strip()
        version = (row.get("patch_version") or "").strip()
        if not package or not version:
            continue
        key = (package, version)
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def manifest_cve_ids(manifest_path: Path) -> list[str]:
    """All CVE ids listed in cve-backports.yaml."""
    ids: list[str] = []
    for row in _load_manifest_raw(manifest_path).get("backports") or []:
        if not isinstance(row, dict):
            continue
        cve_ids = row.get("cve_ids")
        if not isinstance(cve_ids, list):
            continue
        for cve_id in cve_ids:
            text = str(cve_id).strip().upper()
            if text:
                ids.append(text)
    return sorted(set(ids))
