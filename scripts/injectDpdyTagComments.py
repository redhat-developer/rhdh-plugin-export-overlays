#!/usr/bin/env python3
#
# Insert # Tag / Build date comments into dynamic-plugins.default.yaml from plugin_builds/.
# TODO: Once we drop wrappers, this will be obsolete and can be deleted
#
# - After "# - package: oci://..." (migration block)
# - Before "- package: ./dynamic-plugins/dist/..." only when no Tag comment is already nearby

import argparse
import json
import re
import sys
from pathlib import Path

COMMENTED_OCI_RE = re.compile(r"^ {2}# - package: oci://")
PKG_LINE_RE = re.compile(r"^ {2}- package: (?P<val>\S+)")
TAG_LINE_RE = re.compile(r"^\s*# Tag:")


def load_tag_by_key(plugin_builds_dir: Path) -> dict[str, tuple[str, str]]:
    tag_by_key: dict[str, tuple[str, str]] = {}
    if not plugin_builds_dir.is_dir():
        return tag_by_key
    for jf in sorted(plugin_builds_dir.glob("*/*.json")):
        for name, pdata in json.loads(jf.read_text()).items():
            ref = pdata.get("registryReference") or ""
            tag = ref.rsplit(":", 1)[-1] if ":" in ref else ""
            bd = pdata.get("build-date") or ""
            if not (tag and bd):
                continue
            tag_by_key[name] = (tag, bd)
            alt = name.replace("red-hat-developer-hub-", "rhdh-")
            tag_by_key[alt] = (tag, bd)
    return tag_by_key


def keys_for_package(pkg: str) -> list[str]:
    keys = [pkg]
    if pkg.endswith("-dynamic"):
        keys.append(pkg[: -len("-dynamic")])
    if pkg.startswith("rhdh-"):
        keys.append("red-hat-developer-hub-" + pkg[5:])
    return keys


def comment_for_package(pkg: str, tag_by_key: dict[str, tuple[str, str]]) -> str | None:
    for key in keys_for_package(pkg):
        if key in tag_by_key:
            tag, bd = tag_by_key[key]
            return f"  # Tag: {tag}, Build date: {bd}\n"
    return None


def package_name_from_oci_comment(line: str) -> str | None:
    m = re.search(r"oci://[^/]+/([^@\s!]+)", line)
    if not m:
        return None
    return m.group(1).rsplit("/", 1)[-1]


def package_name_from_package_value(val: str) -> str:
    if val.startswith("./"):
        return val.rsplit("/", 1)[-1]
    return val.split("/")[-1].split("@")[0]


def recent_has_tag(result: list[str]) -> bool:
    """Check if a Tag comment exists between the current position and the previous package line."""
    for line in reversed(result):
        if TAG_LINE_RE.match(line):
            return True
        if PKG_LINE_RE.match(line) or COMMENTED_OCI_RE.match(line):
            return False
    return False


def inject(dpdy_path: Path, plugin_builds_dir: Path) -> bool:
    tag_by_key = load_tag_by_key(plugin_builds_dir)
    lines = dpdy_path.read_text().splitlines(keepends=True)
    result: list[str] = []
    changed = False
    i = 0
    while i < len(lines):
        line = lines[i]

        if COMMENTED_OCI_RE.match(line):
            result.append(line)
            i += 1
            if i < len(lines) and TAG_LINE_RE.match(lines[i]):
                result.append(lines[i])
                i += 1
                continue
            pkg = package_name_from_oci_comment(line)
            cmt = comment_for_package(pkg, tag_by_key) if pkg else None
            if cmt:
                result.append(cmt)
                changed = True
            continue

        m = PKG_LINE_RE.match(line)
        if m:
            pkg = package_name_from_package_value(m.group("val"))
            if not recent_has_tag(result):
                cmt = comment_for_package(pkg, tag_by_key)
                if cmt:
                    result.append(cmt)
                    changed = True

        result.append(line)
        i += 1

    if changed:
        dpdy_path.write_text("".join(result))
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description="Inject Tag/Build date comments into DPDY from plugin_builds")
    parser.add_argument("dpdy_file", type=Path, help="Path to dynamic-plugins.default.yaml")
    parser.add_argument("plugin_builds_dir", type=Path, help="Path to plugin_builds/ directory containing workspace JSON files")
    args = parser.parse_args()
    if not args.dpdy_file.is_file():
        print(f"Error: DPDY file not found: {args.dpdy_file}", file=sys.stderr)
        return 1
    inject(args.dpdy_file, args.plugin_builds_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
