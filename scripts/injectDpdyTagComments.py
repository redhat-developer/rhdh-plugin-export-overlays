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
    """Read all plugin_builds/*/*.json and build a lookup dict from image name to (tag, build_date).

    Each JSON file maps plugin image names to their registry references and
    build dates. For every entry, an alias is also added so that both the
    ``red-hat-developer-hub-`` and ``rhdh-`` prefixed forms resolve to the
    same tag info.

    Args:
        plugin_builds_dir: Path to the plugin_builds/ directory. Each
            subdirectory contains JSON files with plugin build metadata.

    Returns:
        A dict mapping image name (str) to a (tag, build_date) tuple.
        Returns an empty dict if the directory does not exist.

    Example::

        >>> load_tag_by_key(Path("plugin_builds"))
        {
            "red-hat-developer-hub-backstage-plugin-foo": ("1.11--1.5.4", "2025-05-01"),
            "rhdh-backstage-plugin-foo": ("1.11--1.5.4", "2025-05-01"),
        }
    """
    tag_by_key: dict[str, tuple[str, str]] = {}
    if not plugin_builds_dir.is_dir():
        return tag_by_key
    for jf in sorted(plugin_builds_dir.glob("*/*.json")):
        try:
            data = json.loads(jf.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"Warning: Skipping invalid plugin build file: {jf} ({e})", file=sys.stderr)
            continue
        for name, pdata in data.items():
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
    """Generate all lookup keys for a package name to try against tag_by_key.

    Produces the original name, a variant with the ``-dynamic`` suffix
    stripped, and a variant with the ``rhdh-`` prefix expanded to
    ``red-hat-developer-hub-``.

    Args:
        pkg: The package name to generate keys for (e.g.
            ``"rhdh-backstage-plugin-foo-dynamic"``).

    Returns:
        A list of candidate keys, ordered from most specific to least.

    Example::

        >>> keys_for_package("rhdh-backstage-plugin-foo-dynamic")
        ["rhdh-backstage-plugin-foo-dynamic",
         "rhdh-backstage-plugin-foo",
         "red-hat-developer-hub-backstage-plugin-foo-dynamic"]
    """
    keys = [pkg]
    if pkg.endswith("-dynamic"):
        keys.append(pkg[: -len("-dynamic")])
    if pkg.startswith("rhdh-"):
        keys.append("red-hat-developer-hub-" + pkg[5:])
    return keys


def comment_for_package(pkg: str, tag_by_key: dict[str, tuple[str, str]]) -> str | None:
    """Look up the tag comment string for a package name.

    Tries each key from ``keys_for_package`` against ``tag_by_key`` and
    returns the formatted YAML comment for the first match.

    Args:
        pkg: The package name to look up.
        tag_by_key: The lookup dict built by ``load_tag_by_key``.

    Returns:
        A formatted comment string (e.g.
        ``"  # Tag: 1.11--1.5.4, Build date: 2025-05-01\\n"``), or None
        if no matching tag info was found.

    Example::

        >>> comment_for_package("rhdh-backstage-plugin-foo", tag_by_key)
        "  # Tag: 1.11--1.5.4, Build date: 2025-05-01\\n"
    """
    for key in keys_for_package(pkg):
        if key in tag_by_key:
            tag, bd = tag_by_key[key]
            return f"  # Tag: {tag}, Build date: {bd}\n"
    return None


def package_name_from_oci_comment(line: str) -> str | None:
    """Extract the image name from a commented OCI package line.

    Parses lines like ``# - package: oci://registry/image-name@sha256:...``
    and returns the image name portion.
    """
    m = re.search(r"oci://[^/]+/([^@\s!]+)", line)
    if not m:
        return None
    return m.group(1).rsplit("/", 1)[-1]


def package_name_from_package_value(val: str) -> str:
    """Extract the package name from a package value string.

    Handles both local paths (``./dynamic-plugins/dist/foo`` returns
    ``foo``) and OCI references (returns the image name before ``@``).
    """
    if val.startswith("./"):
        return val.rsplit("/", 1)[-1]
    return val.split("/")[-1].split("@")[0]


def recent_has_tag(result: list[str]) -> bool:
    """Check if a Tag comment already exists between the current position and the previous package line."""
    for line in reversed(result):
        if TAG_LINE_RE.match(line):
            return True
        if PKG_LINE_RE.match(line) or COMMENTED_OCI_RE.match(line):
            return False
    return False


def inject(dpdy_path: Path, plugin_builds_dir: Path) -> bool:
    """Insert ``# Tag: ..., Build date: ...`` comments into dynamic-plugins.default.yaml.

    Reads the DPDY file and plugin build metadata, then inserts tag/build-date
    comments in two positions:

    - After ``# - package: oci://...`` lines (commented-out migration blocks)
    - Before ``- package: ./dynamic-plugins/dist/...`` lines (wrapper package
      entries), only when no Tag comment already exists nearby

    Args:
        dpdy_path: Path to the dynamic-plugins.default.yaml file.
        plugin_builds_dir: Path to the plugin_builds/ directory containing
            workspace subdirectories with JSON build metadata files.

    Returns:
        True if the file was modified and written back, False otherwise.

    Example:

        Before::

            # - package: oci://quay.io/rhdh/plugin-foo@sha256:abc123
            - package: ./dynamic-plugins/dist/rhdh-backstage-plugin-foo-dynamic

        After::

            # - package: oci://quay.io/rhdh/plugin-foo@sha256:abc123
            # Tag: 1.11--1.5.4, Build date: 2025-05-01
            - package: ./dynamic-plugins/dist/rhdh-backstage-plugin-foo-dynamic
    """
    tag_by_key = load_tag_by_key(plugin_builds_dir)
    lines = dpdy_path.read_text(encoding="utf-8").splitlines(keepends=True)
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
        dpdy_path.write_text("".join(result), encoding="utf-8")
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
