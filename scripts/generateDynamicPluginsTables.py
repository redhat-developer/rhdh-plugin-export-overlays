#!/usr/bin/env python3
#
# Copyright (c) Red Hat, Inc.
# SPDX-License-Identifier: EPL-2.0

"""Render documentation tables and CSV inventories from a generated catalog index.

Usage:
  python scripts/generateDynamicPluginsTables.py --tier supported \
    --index-dir catalog-index/supported
  python scripts/generateDynamicPluginsTables.py --tier community \
    --index-dir catalog-index/community

The same supported invocation also works with a productized catalog index.
Each invocation writes into INDEX_DIR/extend_dynamic-plugins-reference/ unless
--output-dir is given. The supported tier produces four AsciiDoc pages and
rhdh-supported-plugins.csv; the community tier produces one page and
rhdh-community-plugins.csv. No registry calls are made during rendering.

index.json selects packages and provides their resolved OCI references and tags.
The matching catalog-entities/extensions/packages/*.yaml files provide titles,
versions, roles, lifecycle, and configuration variables. For example:
spec.packageName "@backstage-community/plugin-3scale-backend"
  -> index key "backstage-community-plugin-3scale-backend"
A Package entity copied into the directory without an index entry is never listed.

Supported pages also intersect the index with default.packages.yaml. Thus an
indexed supported package outside the defaults does not appear in those pages;
the defaults determine whether a listed package is enabled or disabled.
"""

import argparse
import csv
import io
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


TEMPLATES_DIR = Path(__file__).parent / "templates"
DOCS_DIR = "extend_dynamic-plugins-reference"
COMMUNITY_SUPPORT = {"community", "dev-preview"}
SUPPORTED_SUPPORT = {"production", "generally-available", "tech-preview"}
VARIABLE_PATTERN = re.compile(r"\$\{([^}]+)\}")
CSV_COLUMNS = (
    "Name", "Plugin", "Role", "Version", "Support Level", "Lifecycle",
    "Path", "Required Variables", "Default",
)


class TableGenerationError(Exception):
    """The generated index cannot produce a trustworthy documentation table."""


@dataclass(frozen=True)
class Plugin:
    """Fields from one validated index entry and its matching Package entity."""

    image: str
    package: str
    title: str
    version: str
    reference: str
    tag: str
    support: str
    lifecycle: str
    role: str
    variables: tuple[str, ...]


def image_name(package_name: str) -> str:
    """Convert an npm name to its catalog index key.

    Example: @backstage-community/plugin-3scale-backend
      -> backstage-community-plugin-3scale-backend
    """
    return package_name.lstrip("@").replace("/", "-")


def required_variables(spec: dict[str, Any]) -> tuple[str, ...]:
    """Return unique ${VAR} names from the first appConfig example, sorted.

    Example: ${TOKEN}, ${URL}, ${TOKEN} -> ("TOKEN", "URL")

    YAML mapping content is serialized before scanning because Package entities
    usually store appConfigExamples[0].content as a mapping, not a string.
    """
    examples = spec.get("appConfigExamples") or []
    if not isinstance(examples, list) or not examples or not isinstance(examples[0], dict):
        return ()
    content = examples[0].get("content") or ""
    if not isinstance(content, str):
        content = yaml.safe_dump(content, sort_keys=True)
    return tuple(sorted(set(VARIABLE_PATTERN.findall(content))))


def load_entities(packages_dir: Path, selected: set[str]) -> dict[str, dict[str, Any]]:
    """Find Package entities for the image names selected by index.json.

    The generator copies workspace metadata for both tiers, so this directory
    can contain packages outside the current index. Match by spec.packageName
    rather than filename: some metadata files use shortened filenames.
    """
    if not packages_dir.is_dir():
        raise TableGenerationError(f"Package entity directory is missing: {packages_dir}")

    entities = {}
    for path in sorted(packages_dir.glob("*.yaml")):
        if path.name == "all.yaml":
            continue
        try:
            entity = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            # An unselected entity cannot affect this tier's output. A selected
            # one must be valid; otherwise the missing row could go unnoticed.
            if path.stem in selected:
                raise TableGenerationError(f"Invalid Package entity {path}: {exc}") from exc
            continue
        if not isinstance(entity, dict) or entity.get("kind") != "Package":
            if path.stem in selected:
                raise TableGenerationError(f"Invalid Package entity: {path}")
            continue
        spec = entity.get("spec")
        if not isinstance(spec, dict):
            if path.stem in selected:
                raise TableGenerationError(f"Invalid Package entity: {path}")
            continue
        package = spec.get("packageName")
        if not isinstance(package, str) or not package:
            if path.stem in selected:
                raise TableGenerationError(f"Package entity has no packageName: {path}")
            continue
        image = image_name(package)
        if image not in selected:
            continue
        if image in entities:
            raise TableGenerationError(f"Duplicate Package entity for {image}: {path}")
        entities[image] = entity
    return entities


def required_string(value: Any, field: str, image: str) -> str:
    """Require a nonempty field used in a published table or CSV row."""
    if not isinstance(value, str) or not value.strip():
        raise TableGenerationError(f"Missing or invalid {field} for {image}")
    return value


def load_plugins(index_dir: Path, tier: str) -> list[Plugin]:
    """Join each indexed image with its Package entity and validate both.

    The returned list includes only index.json entries. For every entry, the
    entity's support and resolved OCI ref must agree with the index. For example:
    registryReference "ghcr.io/org/plugin@sha256:abc"
      -> table Path "oci://ghcr.io/org/plugin@sha256:abc"
    A mismatch fails generation instead of publishing a stale tag or digest.
    """
    index_file = index_dir / "index.json"
    if not index_file.is_file():
        raise TableGenerationError(f"Catalog index is missing: {index_file}")
    try:
        index = json.loads(index_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise TableGenerationError(f"Invalid catalog index {index_file}: {exc}") from exc
    if not isinstance(index, dict):
        raise TableGenerationError(f"Catalog index must be an object: {index_file}")

    entities = load_entities(index_dir / "catalog-entities/extensions/packages", set(index))
    expected_support = SUPPORTED_SUPPORT if tier == "supported" else COMMUNITY_SUPPORT
    plugins = []
    for image, entry in index.items():
        if not isinstance(entry, dict):
            raise TableGenerationError(f"Invalid index entry: {image}")
        entity = entities.get(image)
        if entity is None:
            raise TableGenerationError(f"Indexed package has no Package entity: {image}")
        spec = entity["spec"]
        metadata = entity.get("metadata")
        if not isinstance(metadata, dict):
            raise TableGenerationError(f"Invalid Package metadata for {image}")

        support = required_string(spec.get("support"), "support", image)
        if support != entry.get("support"):
            raise TableGenerationError(
                f"Support mismatch for {image}: index={entry.get('support')}, entity={support}"
            )
        if support not in expected_support:
            raise TableGenerationError(f"Unexpected {tier} support level for {image}: {support}")

        package = required_string(spec.get("packageName"), "packageName", image)
        title = required_string(metadata.get("title") or package, "title", image)
        version = required_string(str(spec.get("version") or ""), "version", image)
        reference = required_string(spec.get("dynamicArtifact"), "dynamicArtifact", image)
        registry_reference = required_string(entry.get("registryReference"), "registryReference", image)
        tag = required_string(entry.get("imageTag"), "imageTag", image)
        # A dynamicArtifact can carry a plugin suffix after "!"; the index
        # registryReference identifies the image itself, without that suffix.
        reference = reference.split("!", 1)[0]
        if reference != f"oci://{registry_reference}":
            raise TableGenerationError(f"Index and Package OCI references differ for {image}")
        if tier == "community" and not reference.startswith("oci://ghcr.io/"):
            raise TableGenerationError(f"Community package has a non-GHCR reference: {image}")

        backstage = spec.get("backstage") or {}
        role = backstage.get("role", "unknown") if isinstance(backstage, dict) else "unknown"
        plugins.append(Plugin(
            image=image, package=package, title=title, version=version,
            reference=reference, tag=tag, support=support,
            lifecycle=str(spec.get("lifecycle") or "unknown"), role=str(role),
            variables=required_variables(spec),
        ))
    return plugins


def template(name: str, replacements: dict[str, str]) -> str:
    """Load an AsciiDoc template and replace its required %%MARKERS%%.

    A missing marker is an error, since silently omitting a table would still
    leave a syntactically valid page for the documentation build to consume.
    """
    path = TEMPLATES_DIR / f"{name}.template.adoc"
    content = path.read_text(encoding="utf-8")
    for marker, value in replacements.items():
        if marker not in content:
            raise TableGenerationError(f"Template {path} is missing {marker}")
        content = content.replace(marker, value)
    return content


def empty_page(name: str, sentence: str) -> str:
    """Keep a page's title and abstract marker when its table has no rows."""
    content = template(name, {})
    heading, separator, _ = content.partition('[role="_abstract"]')
    if not separator:
        raise TableGenerationError(f"Template {name} is missing its abstract marker")
    return f'{heading}{separator}\n{sentence}\n'


def adoc_cell(value: str) -> str:
    """Prevent a newline or literal pipe in metadata from splitting a table cell."""
    return value.replace("\n", " ").replace("|", "\\|")


def adoc_variables(plugin: Plugin) -> str:
    """Format extracted variables as code paragraphs inside an AsciiDoc cell."""
    return "".join(f"`{variable}`\n\n" for variable in plugin.variables)


def render_community(plugins: list[Plugin]) -> dict[str, str]:
    """Render the community page and CSV from the same title-sorted packages.

    Example: title "3Scale" -> AsciiDoc |*3Scale* cell and CSV Name "3Scale"

    Developer Preview stays in this tier but receives its own Support Level
    label in the CSV.
    """
    rows = []
    csv_rows = []
    for plugin in sorted(plugins, key=lambda item: (item.title, item.package)):
        rows.append(
            f"|*{adoc_cell(plugin.title)}*\n|{adoc_cell(plugin.version)}\n"
            f"|`{plugin.reference}`\n\n{adoc_variables(plugin)}|{adoc_cell(plugin.tag)}\n"
        )
        csv_rows.append([
            plugin.title, plugin.package,
            "Frontend" if "front" in plugin.role else "Backend",
            plugin.version,
            "Developer Preview" if plugin.support == "dev-preview" else "Community Support",
            plugin.lifecycle, plugin.reference,
            ";".join(f"`{variable}`" for variable in plugin.variables),
            "N/A",  # This tier has no default.packages.yaml or DPDY.
        ])
    name = "ref-community-supported-plugins"
    if not rows:
        content = empty_page(
            name,
            "There are no community supported plugins in this release of "
            "{product} ({product-very-short})",
        )
    else:
        content = template(name, {
            "%%COMMUNITY_TABLE_COUNT%%": str(len(rows)),
            "%%COMMUNITY_TABLE_CONTENT%%": "\n".join(rows),
        })
    return {
        f"{name}.adoc": content,
        "rhdh-community-plugins.csv": csv_content(csv_rows),
    }


def load_defaults(path: Path) -> dict[str, str]:
    """Map npm package names to enabled/disabled status for supported pages.

    Example: packages.enabled: [{package: "@org/plugin-foo"}]
      -> {"@org/plugin-foo": "enabled"}

    Reject duplicates across both lists so the preinstalled page cannot report
    an ambiguous default state.
    """
    if not path.is_file():
        raise TableGenerationError(f"Supported package defaults are missing: {path}")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise TableGenerationError(f"Invalid package defaults {path}: {exc}") from exc
    packages = data.get("packages") if isinstance(data, dict) else None
    if not isinstance(packages, dict):
        raise TableGenerationError(f"Invalid package defaults: {path}")
    defaults = {}
    for status in ("enabled", "disabled"):
        entries = packages.get(status) or []
        if not isinstance(entries, list):
            raise TableGenerationError(f"Invalid {status} packages in {path}")
        for entry in entries:
            package = entry.get("package") if isinstance(entry, dict) else None
            if not isinstance(package, str) or not package:
                raise TableGenerationError(f"Invalid {status} package in {path}")
            if package in defaults:
                raise TableGenerationError(f"Package appears twice in {path}: {package}")
            defaults[package] = status
    return defaults


def pretty_name(package: str) -> str:
    """Preserve the legacy supported-page display names from npm packages.

    Example: @backstage/plugin-auth-backend-module-github-provider
      -> "Auth Backend Module GitHub Provider"

    The special cases retain names such as "Argo CD", "GitLab", and "TechDocs"
    used in existing docs.
    Community output uses metadata.title instead of this derived name.
    """
    if "pagerduty" in package:
        return "PagerDuty"
    if "redhat-argocd" in package:
        return "Argo CD (Red Hat)"
    if "scaffolder-backend-argocd" in package:
        return "Argo CD"
    if "notifications-backend-module-email" in package:
        return "Notifications"
    name = package.removeprefix("@").split("/", 1)[-1]
    for prefix in (
        "backstage-community-", "red-hat-developer-hub-", "redhat-",
        "roadiehq-", "immobiliarelabs-", "parfuemerie-douglas-",
        "backstage-plugin-", "plugin-", "catalog-backend-module-",
        "plugin-catalog-backend-module-", "scaffolder-backend-module-",
    ):
        if name.startswith(prefix):
            name = name[len(prefix):]
    name = name.removesuffix("-backend")
    special = {
        "aap": "Ansible Automation Platform (AAP)", "acr": "ACR", "cd": "CD",
        "ocm": "OCM", "rbac": "RBAC", "argocd": "Argo CD",
        "github": "GitHub", "gitlab": "GitLab", "jfrog": "JFrog",
        "msgraph": "MS Graph", "pagerduty": "PagerDuty",
        "servicenow": "ServiceNow", "sonarqube": "SonarQube",
        "techdocs": "TechDocs",
    }
    return " ".join(special.get(word, word.capitalize()) for word in name.split("-"))


def support_label(support: str) -> str:
    """Map supported metadata levels to the legacy supported CSV labels."""
    return "Red Hat Tech Preview" if support == "tech-preview" else "Production"


def csv_content(rows: list[list[str]]) -> str:
    """Serialize rows with the shared nine-column docs inventory header.

    csv.writer quotes values and escapes embedded quotes, so a metadata title
    containing a comma remains one Name cell. Empty inventories retain a header.
    """
    output = io.StringIO()
    writer = csv.writer(output, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    writer.writerows(rows)
    return output.getvalue()


def render_supported(plugins: list[Plugin], defaults: dict[str, str]) -> dict[str, str]:
    """Render the four supported pages and CSV using indexed default packages.

    The output contains GA, Technology Preview, Deprecated, and Preinstalled
    pages plus rhdh-supported-plugins.csv. Deprecated lifecycle takes precedence
    over support level for table placement. A package in defaults but absent
    from index.json is omitted because load_plugins supplied no row for it.
    """
    selected = [plugin for plugin in plugins if plugin.package in defaults]

    def sort_key(plugin: Plugin) -> tuple[str, int, str, str]:
        """Within a display name, put frontend before backend and scaffolder last."""
        role_sort = 1 if "front" in plugin.role else 2
        if "scaffolder" in plugin.package:
            role_sort = 3
        return (pretty_name(plugin.package), role_sort, plugin.role, plugin.package)

    selected.sort(key=sort_key)
    groups: dict[str, list[str]] = {"ga": [], "technology-preview": [], "deprecated": []}
    csv_rows = []
    enabled = []
    disabled = []
    for plugin in selected:
        label = support_label(plugin.support)
        status = defaults[plugin.package]
        if status == "enabled":
            enabled.append(plugin.package)
        else:
            disabled.append(plugin)
        # A deprecated plugin belongs in that reference page even if its
        # support level would otherwise place it in GA or Tech Preview.
        if plugin.lifecycle == "deprecated":
            group = "deprecated"
        elif plugin.support == "tech-preview":
            group = "technology-preview"
        else:
            group = "ga"
        groups[group].append(
            f"|{adoc_cell(pretty_name(plugin.package))} "
            f"|`https://npmjs.com/package/{plugin.package}/v/{plugin.version}[{plugin.package}]` "
            f"|{adoc_cell(plugin.version)}\n|`{plugin.reference}`\n\n"
            f"{adoc_variables(plugin)}|{adoc_cell(plugin.tag)}\n"
        )
        # Preserve the existing CSV omission (RHIDP-4196); TechDocs still
        # appears in the reference pages and enabled-by-default list.
        if "techdocs" not in plugin.package.lower():
            role = "Frontend" if "front" in plugin.role else "Backend"
            csv_rows.append(({"ga": 1, "technology-preview": 2, "deprecated": 4}[group], sort_key(plugin), [
                pretty_name(plugin.package), plugin.package, role, plugin.version,
                label, plugin.lifecycle, plugin.reference,
                ";".join(f"`{variable}`" for variable in plugin.variables),
                status.capitalize(),
            ]))

    outputs = {}
    specs = (
        ("ga", "ref-ga-plugins", "%%COUNT_1%%", "%%TABLE_CONTENT_1%%", "There are no {generally-available} plugins in this release of {product} ({product-very-short})"),
        ("technology-preview", "ref-technology-preview-plugins", "%%COUNT_2%%", "%%TABLE_CONTENT_2%%", "There are no {technology-preview} plugins in this release of {product} ({product-very-short})"),
        ("deprecated", "ref-deprecated-plugins", "%%COUNT_3%%", "%%TABLE_CONTENT_3%%", "There are no deprecated plugins in this release of {product} ({product-very-short})"),
    )
    for group, name, count_marker, content_marker, empty_sentence in specs:
        rows = groups[group]
        outputs[f"{name}.adoc"] = (
            template(name, {count_marker: str(len(rows)), content_marker: "".join(rows)})
            if rows else empty_page(name, empty_sentence)
        )
    # Use this index's actual disabled OCI ref for the configuration example.
    # This also works for upstream GHCR and downstream Quay/RAR indexes.
    bullets = "\n".join(f"* `{package}`" for package in sorted(set(enabled)))
    example_ref = disabled[0].reference if disabled else "oci://<registry>/<plugin>@sha256:<digest>"
    outputs["con-preinstalled-dynamic-plugins.adoc"] = template(
        "con-preinstalled-dynamic-plugins",
        {"%%COUNT_ENABLED_PLUGINS%%": str(len(set(enabled))),
         "%%ENABLED_PLUGINS%%": bullets,
         "%%DISABLED_PLUGIN_REF%%": example_ref},
    )
    outputs["rhdh-supported-plugins.csv"] = csv_content(
        [row for _, _, row in sorted(csv_rows)]
    )
    return outputs


def render_tables(tier: str, index_dir: Path, defaults_file: Path | None = None) -> dict[str, str]:
    """Choose the tier renderer after loading and validating indexed packages.

    The optional defaults_file lets downstream use a defaults file outside
    index_dir. Returned keys are filenames relative to --output-dir.
    """
    plugins = load_plugins(index_dir, tier)
    if tier == "community":
        return render_community(plugins)
    defaults = load_defaults(defaults_file or index_dir / "default.packages.yaml")
    return render_supported(plugins, defaults)


def main() -> int:
    """Parse CLI paths, render every file, then write them to one directory."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", required=True, choices=("supported", "community"))
    parser.add_argument("--index-dir", required=True, type=Path,
                        help="Generated catalog index directory")
    parser.add_argument("--default-packages-file", type=Path,
                        help="Supported tier defaults (default: INDEX_DIR/default.packages.yaml)")
    parser.add_argument("--output-dir", type=Path,
                        help="Documentation output directory (default: INDEX_DIR/extend_dynamic-plugins-reference)")
    args = parser.parse_args()
    try:
        outputs = render_tables(args.tier, args.index_dir, args.default_packages_file)
        output_dir = args.output_dir or args.index_dir / DOCS_DIR
        output_dir.mkdir(parents=True, exist_ok=True)
        for name, content in outputs.items():
            (output_dir / name).write_text(content, encoding="utf-8")
    except (TableGenerationError, OSError) as exc:
        print(f"Error generating {args.tier} plugin tables: {exc}", file=sys.stderr)
        return 1
    print(f"Generated {len(outputs)} {args.tier} documentation files in {output_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
