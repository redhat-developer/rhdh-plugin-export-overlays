#!/usr/bin/env python3
#
# Copyright (c) Red Hat, Inc.
#
# Static validation of a generated catalog index (Step 5 of update-index.sh).
#
# Reads what update-index.sh just wrote — dynamic-plugins.default.yaml, index.json,
# plugin_builds/ — and makes NO network calls, so it is cheap enough to gate every
# generation. The expensive install-and-boot half is the catalog-index sanity check
# (`yarn smoke --catalog-index`), which only runs on a schedule.
#
# It exists because the generator is forgiving: when a plugin's image is not found it
# logs a warning and carries on, so the index can ship an oci:// ref that was never
# confirmed to exist. Nothing downstream re-checked that.
#
# Findings carry a stable rule id and severity (`--list-rules`). Errors fail the run;
# warnings only under --strict. Ticketed exceptions go in
# catalog-index-validation-allowlist.txt — an entry with no ticket is a parse error.

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple

import yaml

from generatePluginBuildInfo import decode_dynamic_packages
from plugin_utils import (
    BuildReport,
    Colors,
    log_debug,
    log_error,
    log_info,
    log_warn,
    parse_image_reference,
    require_contained,
    set_debug,
)

ERROR = "error"
WARNING = "warning"


class Rule(NamedTuple):
    """What a rule is: how bad it is, what it means, and what it needs to run."""

    severity: str
    description: str
    #: True when the rule can only be answered from plugin_builds/. Kept here rather
    #: than in a parallel set so `--no-build-metadata`, the "not checked" line and the
    #: checks themselves cannot disagree — they all read this one table. An earlier
    #: version maintained two frozensets by hand and they drifted: the index.json pass
    #: was skipped wholesale, including a rule that needs no build metadata at all,
    #: and the skipped list never said so.
    needs_builds: bool = False


# Every rule this validator can report. Severities live in one table so `--list-rules`
# and the allowlist parser agree with the checks by construction — a rule id that is not
# here cannot be allowlisted, which is what stops a typo in the allowlist from silently
# disabling nothing.
RULES: dict[str, Rule] = {
    "ref-form": Rule(
        ERROR,
        "a plugins[].package value is not an oci:// reference",
    ),
    "duplicate-ref": Rule(
        ERROR,
        "the same package ref appears more than once — the later entry silently "
        "shadows the earlier one's pluginConfig",
    ),
    "registry-not-allowed": Rule(
        ERROR,
        "a generated OCI reference uses a registry other than the one required "
        "for its support tier",
    ),
    "unknown-image": Rule(
        ERROR,
        "an oci:// ref names an image with no plugin_builds/ entry — the index and "
        "the build metadata disagree",
        needs_builds=True,
    ),
    "digest-mismatch": Rule(
        ERROR,
        "a digest-pinned ref does not match the digest plugin_builds/ recorded",
        needs_builds=True,
    ),
    "unresolved-image": Rule(
        ERROR,
        "the index ships a package whose image was never found in the registry "
        "(no digest was resolved) — enabling it fails at pull time",
        needs_builds=True,
    ),
    "not-digest-pinned": Rule(
        ERROR,
        "an oci:// ref carries a tag rather than a digest — the tag points at the "
        "manifest list, which lacks io.backstage.dynamic-packages, so install fails",
    ),
    "fallback-tag": Rule(
        WARNING,
        "the requested build was missing and an older tag was substituted — the "
        "index ships a stale build of this plugin",
        needs_builds=True,
    ),
    "index-missing-entry": Rule(
        WARNING,
        "a resolved package is in dynamic-plugins.default.yaml but absent from "
        "index.json, so the Extensions UI will not list it",
        # Needs plugin_builds/ to tell a package that failed to resolve — and is
        # legitimately absent from the index — from one that went missing.
        needs_builds=True,
    ),
    "index-ref-mismatch": Rule(
        ERROR,
        "index.json and dynamic-plugins.default.yaml disagree on a package's "
        "registry reference",
    ),
    "missing-annotation": Rule(
        ERROR,
        "the image exists but lacks a usable io.backstage.dynamic-packages "
        "annotation (missing, empty, or unreadable) — always fails the build",
        needs_builds=True,
    ),
    "backstage-version-mismatch": Rule(
        WARNING,
        "the workspace targets an older Backstage minor than this branch "
        "expects — fails the build only under --strict",
    ),
    "version-regression": Rule(
        WARNING,
        "this plugin's version is lower than the previous published catalog "
        "index — fails only under --strict",
    ),
    "dpdy-missing-package": Rule(
        ERROR,
        "a package listed in default.packages.yaml is absent from "
        "dynamic-plugins.default.yaml (matched by exact npm name or OCI "
        "image name, not by count or substring)",
    ),
}

#: The rules `--no-build-metadata` cannot run, derived rather than listed.
RULES_NEEDING_BUILDS = sorted(r for r, spec in RULES.items() if spec.needs_builds)
# Registry policy is a hard gate even when the other rules run in report mode. A
# ticketed exception must not let a non-product registry into a product index.
NON_ALLOWLISTABLE_RULES = {"registry-not-allowed"}

OCI_PREFIX = "oci://"
LOCAL_PREFIX = "./dynamic-plugins/dist/"
DPDY_FILENAME = "dynamic-plugins.default.yaml"
INDEX_JSON_FILENAME = "index.json"
# Same key generatePluginBuildInfo.py writes onto plugin_builds entries.
DYNAMIC_PACKAGES_ANNOTATION = "io.backstage.dynamic-packages"
# Plugin version is the suffix after RHDH (`1.10--5.7.12`) or Backstage
# (`bs_1.49.4__5.7.12`) tag prefixes.
TAG_VERSION_RE = re.compile(r"(?:--|__)([^:@]+)$")

# A well-formed content digest. Checked separately from the rest of the reference
# because `not-digest-pinned` and `digest-mismatch` both key off `ref.digest`: a
# truncated or malformed digest must not read as "pinned".
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

# A ticket-bearing comment opening an allowlist block, e.g.
# `# TODO(RHDHBUGS-3515): image is not published yet`. Mirrors the grammar of
# smoke-tests-native/src/exclusions.ts so contributors learn one format, not two.
TICKET_COMMENT_RE = re.compile(
    r"^#\s*TODO\(([A-Z][A-Z0-9]+-\d+(?:[,\s]+[A-Z][A-Z0-9]+-\d+)*)\)"
)
TODO_COMMENT_RE = re.compile(r"^#\s*TODO\(")


@dataclass(frozen=True)
class Finding:
    """One rule violation, attributed to an image when the rule is about a package."""

    rule: str
    message: str
    image: str = ""

    @property
    def severity(self) -> str:
        # KeyError on an unknown id, deliberately: a typo in a rule name explodes when
        # the finding is built rather than being silently classified.
        return RULES[self.rule].severity


@dataclass(frozen=True)
class AllowlistEntry:
    """A ticketed exception: `<rule-id> <regex>` matched against the image name."""

    rule: str
    pattern: re.Pattern
    ticket: str
    pattern_source: str


@dataclass(frozen=True)
class ParsedRef:
    """An `oci://` package ref broken into the parts the rules reason about."""

    registry: str
    image: str
    digest: str = ""
    tag: str = ""


@dataclass(frozen=True)
class DpdyEntry:
    """One `plugins[]` entry of dynamic-plugins.default.yaml."""

    package: str
    enabled: bool
    #: 0-based position in the list, so a duplicate can name both offenders.
    position: int


@dataclass
class ValidationResult:
    findings: list[Finding] = field(default_factory=list)
    suppressed: list[tuple[Finding, AllowlistEntry]] = field(default_factory=list)
    #: Counts that make a green run informative rather than silent.
    stats: dict[str, int] = field(default_factory=dict)
    #: Rules this run could not answer, so a pass never overstates what was checked.
    skipped_rules: list[str] = field(default_factory=list)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == ERROR]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == WARNING]


def parse_oci_ref(ref: str) -> ParsedRef | None:
    """Split an `oci://…` package ref, or return None when it does not parse.

    The grammar is delegated to `parse_image_reference` — the same function
    generateCatalogIndex.py uses to write these refs. A second grammar here is what once
    made this the only parser in the repo to reject `name:tag@digest`.

    The `!plugin-path` selector is stripped BEFORE parsing: it names a plugin inside the
    image, and a selector containing `/` would otherwise be read as a path segment.
    """
    if not ref.startswith(OCI_PREFIX):
        return None
    body = ref[len(OCI_PREFIX):].split("!", 1)[0]
    name, tag, digest = parse_image_reference(body)
    # A bare `oci://plugin-a` or `oci://registry:5000` names no image: registry and
    # image are not separable, so every rule that reasons about either would be
    # guessing. Reject it as malformed rather than treating the host as an image.
    registry, sep, image = name.rpartition("/")
    if not sep or not registry or not image:
        return None
    if digest and not DIGEST_RE.match(digest):
        return None
    return ParsedRef(registry=registry, image=image, digest=digest, tag=tag)


def load_dpdy_entries(dpdy_path: Path) -> list[DpdyEntry]:
    """Read the `plugins[]` list of dynamic-plugins.default.yaml.

    Mirrors readIndexEntries/isEnabled in smoke-tests-native/src/catalog-index.ts, which
    reads the same file. Cross-language, so keep the accepted shapes in step.

    A malformed file raises: continuing with an empty list would report a clean index
    for a file that could not be parsed.
    """
    with open(dpdy_path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    if doc is None:
        raise ValueError(f"{dpdy_path} is empty")
    if not isinstance(doc, dict):
        raise ValueError(f"{dpdy_path}: expected a mapping at the top level")
    plugins = doc.get("plugins")
    if plugins is None:
        raise ValueError(f"{dpdy_path}: no 'plugins' key")
    if not isinstance(plugins, list):
        raise ValueError(f"{dpdy_path}: 'plugins' is not a list")

    entries: list[DpdyEntry] = []
    for position, item in enumerate(plugins):
        if not isinstance(item, dict):
            raise ValueError(
                f"{dpdy_path}: plugins[{position}] is not a mapping"
            )
        package = item.get("package")
        if not isinstance(package, str):
            raise ValueError(
                f"{dpdy_path}: plugins[{position}] has no string 'package' key"
            )
        # The generator writes `enabled:`; `disabled:` is the install CLI's own spelling
        # and appears in hand-written configs. Accept both so this reads the same file
        # the CLI would, and default to disabled — the index ships most plugins off.
        if isinstance(item.get("enabled"), bool):
            enabled = item["enabled"]
        elif isinstance(item.get("disabled"), bool):
            enabled = not item["disabled"]
        else:
            enabled = False
        entries.append(DpdyEntry(package=package, enabled=enabled, position=position))
    return entries


def load_plugin_builds(plugin_builds_dir: Path) -> dict[str, dict]:
    """Flatten `plugin_builds/<workspace>/<image>.json` into `{image: fields}`.

    Fourth reader of that tree, alongside collect_fallback_entries
    (generatePluginBuildInfo.py), load_tag_by_key (injectDpdyTagComments.py) and the loop
    in generateCatalogIndex.py. Consolidating them needs a generator with an explicit
    error policy (warn / silent / fatal), not a function returning one caller's dict —
    left as follow-up because converting all four touches three files this change does
    not, and would turn collect_fallback_entries' silent skip into a warning.
    """
    builds: dict[str, dict] = {}
    if not plugin_builds_dir.exists():
        return builds
    for json_file in sorted(plugin_builds_dir.glob("*/*.json")):
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            # Not a validation finding: an unreadable build file means the run that
            # produced it failed, and reporting it as an index defect would point at
            # the wrong step.
            log_warn(f"Skipping unreadable {json_file}: {exc}")
            continue
        if not isinstance(data, dict):
            continue
        for image, fields in data.items():
            if isinstance(fields, dict):
                builds[image] = fields
    return builds


def load_index_json(index_path: Path) -> dict[str, dict] | None:
    """Read index.json as `{image: entry}`, or None when the file is absent.

    None and `{}` differ on purpose: absent means this tier builds no index.json, while
    present-and-empty means every declared package is missing from it.
    """
    if not index_path.exists():
        return None
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{index_path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{index_path}: expected a mapping at the top level")
    return {k: v for k, v in data.items() if isinstance(v, dict)}


def load_selected_package_entities(
    output_dir: Path, selected_images: set[str]
) -> dict[str, tuple[str, str, Path]]:
    """Read support and dynamicArtifact for generated Package entities in this index.

    The generator copies every workspace's metadata into packages/, including
    plugins outside the selected tier. Only entities corresponding to a DPDY,
    plugin_builds/, or index.json image belong to this registry policy.
    """
    entities: dict[str, tuple[str, str, Path]] = {}
    packages_dir = output_dir / "catalog-entities" / "extensions" / "packages"
    for path in sorted(packages_dir.glob("*.yaml")):
        if path.name == "all.yaml":
            continue
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as exc:
            if path.stem in selected_images:
                raise ValueError(f"Cannot read selected Package entity {path}: {exc}") from exc
            continue
        if not isinstance(data, dict) or data.get("kind") != "Package":
            continue
        spec = data.get("spec") or {}
        if not isinstance(spec, dict):
            continue
        npm_name = spec.get("packageName")
        metadata = data.get("metadata") or {}
        metadata_name = metadata.get("name") if isinstance(metadata, dict) else None
        if isinstance(npm_name, str) and npm_name:
            image = npm_to_image_name(npm_name)
        elif isinstance(metadata_name, str) and metadata_name:
            image = metadata_name
        else:
            image = path.stem
        if image not in selected_images:
            continue
        support = spec.get("support")
        artifact = spec.get("dynamicArtifact")
        entities[image] = (
            support if isinstance(support, str) else "",
            artifact if isinstance(artifact, str) else "",
            path,
        )
    return entities


def check_registry_policy(
    entries: list[DpdyEntry],
    index: dict[str, dict] | None,
    builds: dict[str, dict],
    package_entities: dict[str, tuple[str, str, Path]],
    registry: str,
    community_registry: str,
) -> list[Finding]:
    """Require each selected plugin's OCI refs to use its support tier's base.

    Package metadata is the source of the support tier; bootstrap copies it into
    plugin_builds/ and index.json. Fall back to those copies when validating an
    extracted index without Package entities or build metadata. Missing support is
    treated as non-community, so it can never grant access to the community base.
    """
    findings: list[Finding] = []

    def expected_for(image: str) -> tuple[str, str]:
        package = package_entities.get(image)
        support = package[0] if package else ""
        if not support:
            support = builds.get(image, {}).get("support") or ""
        if not support and index:
            support = index.get(image, {}).get("support") or ""
        if not isinstance(support, str):
            support = ""
        return (
            community_registry if support == "community" else registry,
            support or "unspecified",
        )

    def check(image: str, value: str, source: str) -> None:
        expected, support = expected_for(image)
        oci_value = value if value.startswith(OCI_PREFIX) else f"{OCI_PREFIX}{value}"
        ref = parse_oci_ref(oci_value)
        if ref is None:
            findings.append(
                Finding(
                    rule="registry-not-allowed",
                    message=(
                        f"'{image}' ({support}) in {source} has an invalid OCI "
                        f"reference '{value}' (expected {expected})"
                    ),
                    image=image,
                )
            )
        elif ref.registry != expected:
            findings.append(
                Finding(
                    rule="registry-not-allowed",
                    message=(
                        f"'{image}' ({support}) in {source} references "
                        f"{ref.registry}; expected {expected}"
                    ),
                    image=image,
                )
            )

    for entry in entries:
        if entry.package.startswith(OCI_PREFIX):
            image = _image_of(entry.package)
            check(image, entry.package, f"{DPDY_FILENAME} plugins[{entry.position}]")

    for image, build in sorted(builds.items()):
        check(image, str(build.get("registryReference") or ""), "plugin_builds/")

    for image, entry in sorted((index or {}).items()):
        check(image, str(entry.get("registryReference") or ""), INDEX_JSON_FILENAME)

    for image, (_, artifact, path) in sorted(package_entities.items()):
        if artifact.startswith(OCI_PREFIX):
            check(image, artifact, str(path))

    return findings


def parse_allowlist(text: str, file_path: str) -> list[AllowlistEntry]:
    """Parse the allowlist, throwing on the first malformed entry.

    A dropped entry would either fail the build on something already accepted, or
    suppress a rule nobody meant to suppress. Both are refused rather than warned about.
    """
    entries: list[AllowlistEntry] = []
    ticket: str | None = None

    for index, raw in enumerate(text.split("\n")):
        trimmed = raw.strip()
        line = index + 1
        if trimmed == "":
            # A blank line closes the block, so a pattern further down cannot inherit a
            # ticket it has nothing to do with.
            ticket = None
            continue
        if trimmed.startswith("#"):
            matched = TICKET_COMMENT_RE.match(trimmed)
            if matched:
                ticket = matched.group(1)
            elif TODO_COMMENT_RE.match(trimmed):
                # A mistyped key (`RHIDP1234`) would otherwise leave the previous
                # block's ticket in place and file these entries under an unrelated
                # ticket — they would then be deleted when that ticket closes. Clear it
                # and let the pattern below fail with the explicit "no ticket" error.
                log_warn(
                    f"{file_path}:{line}: '{trimmed}' looks like a TODO marker but has "
                    f"no well-formed ticket key (expected e.g. TODO(RHIDP-1234)) — ignored"
                )
                ticket = None
            continue
        entries.append(_parse_allowlist_entry(trimmed, ticket, file_path, line))
    return entries


def _parse_allowlist_entry(
    trimmed: str, ticket: str | None, file_path: str, line: int
) -> AllowlistEntry:
    """Parse one `<rule-id> <regex>` line."""
    parts = trimmed.split()
    if len(parts) != 2:
        raise ValueError(
            f"{file_path}:{line}: expected '<rule-id> <regex>', got '{trimmed}'"
        )
    rule, pattern_source = parts
    if rule not in RULES:
        raise ValueError(
            f"{file_path}:{line}: unknown rule '{rule}' — expected one of "
            f"{', '.join(sorted(RULES))}"
        )
    if rule in NON_ALLOWLISTABLE_RULES:
        raise ValueError(
            f"{file_path}:{line}: '{rule}' is a mandatory registry policy and "
            "cannot be allowlisted"
        )
    if not ticket:
        raise ValueError(
            f"{file_path}:{line}: '{trimmed}' has no tracking ticket — precede it with "
            f"'# TODO(TICKET-123): <why, and what unblocks it>'. Allowlist entries "
            f"without a ticket never get removed."
        )
    try:
        pattern = re.compile(pattern_source)
    except re.error as exc:
        raise ValueError(
            f"{file_path}:{line}: invalid regex '{pattern_source}': {exc}"
        ) from exc
    return AllowlistEntry(
        rule=rule, pattern=pattern, ticket=ticket, pattern_source=pattern_source
    )


def load_allowlist(path: Path) -> list[AllowlistEntry]:
    """Read and parse an allowlist file. A missing file means no exceptions."""
    if not path.exists():
        return []
    return parse_allowlist(path.read_text(encoding="utf-8"), str(path))


def apply_allowlist(
    findings: list[Finding], allowlist: list[AllowlistEntry]
) -> tuple[list[Finding], list[tuple[Finding, AllowlistEntry]]]:
    """Split findings into those that stand and those a ticketed entry covers.

    A finding with no image is structural and never suppressed — an image-name regex has
    nothing to match against.
    """
    kept: list[Finding] = []
    suppressed: list[tuple[Finding, AllowlistEntry]] = []
    for finding in findings:
        if finding.rule in NON_ALLOWLISTABLE_RULES:
            kept.append(finding)
            continue
        if not finding.image:
            kept.append(finding)
            continue
        entry = next(
            (
                e
                for e in allowlist
                if e.rule == finding.rule and e.pattern.search(finding.image)
            ),
            None,
        )
        if entry:
            suppressed.append((finding, entry))
        else:
            kept.append(finding)
    return kept, suppressed


def check_dpdy(
    entries: list[DpdyEntry],
    builds: dict[str, dict],
    has_build_metadata: bool,
) -> tuple[list[Finding], dict[str, ParsedRef]]:
    """Validate every dynamic-plugins.default.yaml entry against plugin_builds/.

    Returns the findings and the `{image: ref}` map of everything that parsed, which
    the index.json checks then cross-reference.
    """
    findings: list[Finding] = []
    by_image: dict[str, ParsedRef] = {}
    seen_refs: dict[str, int] = {}

    for entry in entries:
        package = entry.package
        if package in seen_refs:
            findings.append(
                Finding(
                    rule="duplicate-ref",
                    message=(
                        f"'{package}' appears at plugins[{seen_refs[package]}] and "
                        f"plugins[{entry.position}]"
                    ),
                    image=_image_of(package),
                )
            )
            continue
        seen_refs[package] = entry.position

        ref = parse_oci_ref(package)
        if ref is None:
            findings.append(
                Finding(
                    rule="ref-form",
                    message=f"plugins[{entry.position}]: '{package}' is not an {OCI_PREFIX} reference",
                )
            )
            continue

        by_image[ref.image] = ref
        findings.extend(
            _check_ref(ref, builds, has_build_metadata)
        )

    return findings, by_image


def _image_of(package: str) -> str:
    """Image name for attribution, whether or not the ref is well formed.

    The selector is stripped for the same reason parse_oci_ref strips it: an image name
    carrying a `!plugin-path` tail matches no allowlist pattern.
    """
    body = package.removeprefix(OCI_PREFIX).split("!", 1)[0]
    name, _, _ = parse_image_reference(body)
    return name.rsplit("/", 1)[-1]


def _resolved_tag(build: dict) -> str:
    """The tag a plugin_builds entry actually resolved to."""
    _, tag, _ = parse_image_reference(str(build.get("registryReference", "")))
    return tag or "<unknown>"


def _label(finding: "Finding") -> str:
    """How a finding reads wherever it is written.

    One definition, because the copy in build-report.json is what
    renderCatalogStatus.py puts on the status page and the copy on stdout is what CI
    shows — the two drifting apart is the failure that matters.
    """
    return f"[{finding.rule}] {finding.message}"


def _check_ref(
    ref: ParsedRef,
    builds: dict[str, dict],
    has_build_metadata: bool,
) -> list[Finding]:
    """The per-ref rules: pinning, then plugin_builds agreement.

    Registry policy is checked across every generated artifact separately. Pinning is
    a property of the ref itself, so it is emitted before the build lookup and fires
    identically with or without plugin_builds/.
    """
    findings: list[Finding] = []

    if not ref.digest:
        findings.append(
            Finding(
                rule="not-digest-pinned",
                message=(
                    f"'{ref.image}' is referenced by tag "
                    f"({ref.tag or '<none>'}) rather than by digest"
                ),
                image=ref.image,
            )
        )

    if not has_build_metadata:
        return findings

    build = builds.get(ref.image)
    if build is None:
        findings.append(
            Finding(
                rule="unknown-image",
                message=(
                    f"'{ref.image}' is referenced by the index but has no "
                    f"plugin_builds/ entry"
                ),
                image=ref.image,
            )
        )
        return findings

    digest = build.get("digest")
    if not digest:
        findings.append(
            Finding(
                rule="unresolved-image",
                message=(
                    f"'{ref.image}' ships in the index as "
                    f"{ref.digest or ref.tag or '<no tag>'} but its image was never "
                    f"resolved in the registry (plugin_builds/ has no digest)"
                ),
                image=ref.image,
            )
        )
    elif ref.digest and ref.digest != digest:
        findings.append(
            Finding(
                rule="digest-mismatch",
                message=(
                    f"'{ref.image}' is pinned to {ref.digest} but plugin_builds/ "
                    f"recorded {digest}"
                ),
                image=ref.image,
            )
        )

    if build.get("fallback"):
        findings.append(
            Finding(
                rule="fallback-tag",
                message=(
                    f"'{ref.image}' resolved to {_resolved_tag(build)} "
                    f"after {build.get('requestedTag') or '<unknown>'} was not found — "
                    f"the index ships an older build"
                ),
                image=ref.image,
            )
        )

    if digest:
        finding = _annotation_finding(ref.image, build)
        if finding:
            findings.append(finding)

    return findings


def _annotation_finding(image: str, build: dict) -> Finding | None:
    """Fail when the annotation is missing, empty, or not a readable package list.

    plugin_builds/ stores the raw string even when decode fails, so a truthy
    value is not enough: an invalid Base64/JSON blob or an encoded empty list
    installs as a no-op, same as a missing annotation.
    """
    packages = decode_dynamic_packages(build.get(DYNAMIC_PACKAGES_ANNOTATION))
    if packages is None:
        return Finding(
            rule="missing-annotation",
            message=(
                f"'{image}' has an unreadable {DYNAMIC_PACKAGES_ANNOTATION} "
                "annotation"
            ),
            image=image,
        )
    if not packages:
        return Finding(
            rule="missing-annotation",
            message=f"'{image}' is missing or empty {DYNAMIC_PACKAGES_ANNOTATION}",
            image=image,
        )
    return None


def npm_to_image_name(package_name: str) -> str:
    """Same mapping bootstrapPluginBuilds.package_name_to_image_name uses."""
    return package_name.lstrip("@").replace("/", "-")


def plugin_version_from_tag(tag: str) -> str | None:
    """Plugin version suffix from an RHDH or Backstage image tag."""
    if not tag:
        return None
    body = tag.split("@", 1)[0]
    matched = TAG_VERSION_RE.search(body)
    if matched:
        return matched.group(1)
    if "--" in body:
        return body.rsplit("--", 1)[-1]
    if "__" in body:
        return body.rsplit("__", 1)[-1]
    return None


def parse_version_tuple(version: str) -> tuple[int, ...]:
    parts: list[int] = []
    for piece in re.split(r"[.\-+]", version):
        if not piece:
            continue
        if piece.isdigit():
            parts.append(int(piece))
        else:
            matched = re.match(r"^(\d+)", piece)
            parts.append(int(matched.group(1)) if matched else 0)
    return tuple(parts) if parts else (0,)


def version_less_than(left: str, right: str) -> bool:
    """Numeric comparison that treats missing components as zero: 1.2 == 1.2.0."""
    a = parse_version_tuple(left)
    b = parse_version_tuple(right)
    width = max(len(a), len(b), 3)
    a += (0,) * (width - len(a))
    b += (0,) * (width - len(b))
    return a < b


def expected_packages_from_default(default_packages_file: Path) -> list[str]:
    with open(default_packages_file, encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    packages = data.get("packages") or {}
    names: list[str] = []
    for section in ("enabled", "disabled"):
        for entry in packages.get(section) or []:
            if isinstance(entry, dict):
                pkg = entry.get("package")
                if isinstance(pkg, str) and pkg:
                    names.append(pkg)
    return names


def versions_from_dpdy_entries(entries: list[DpdyEntry]) -> dict[str, str]:
    """image name -> plugin version declared by dynamic-plugins.default.yaml."""
    versions: dict[str, str] = {}
    for entry in entries:
        ref = parse_oci_ref(entry.package)
        if ref is None:
            continue
        version = plugin_version_from_tag(ref.tag) or plugin_version_from_tag(
            entry.package
        )
        if version:
            versions[ref.image] = version
    return versions


def versions_from_index_json(index: dict[str, dict]) -> dict[str, str]:
    versions: dict[str, str] = {}
    for name, pdata in index.items():
        tag = pdata.get("imageTag")
        if isinstance(tag, str) and tag:
            version = plugin_version_from_tag(tag)
            if version:
                versions[name] = version
                continue
        ref = pdata.get("registryReference", "")
        if isinstance(ref, str) and ref:
            version = plugin_version_from_tag(ref)
            if version:
                versions[name] = version
    return versions


def check_builds_outside_dpdy(
    builds: dict[str, dict],
    seen_images: set[str],
) -> list[Finding]:
    """Search for packages not in generated DPDY (community catalog, omitted images)."""
    findings: list[Finding] = []
    for image, build in sorted(builds.items()):
        if image in seen_images:
            continue
        digest = build.get("digest")
        if not digest:
            findings.append(
                Finding(
                    rule="unresolved-image",
                    message=(
                        f"'{image}' was never resolved in the registry "
                        f"(plugin_builds/ has no digest)"
                    ),
                    image=image,
                )
            )
            continue
        finding = _annotation_finding(image, build)
        if finding:
            findings.append(finding)
        if build.get("fallback"):
            findings.append(
                Finding(
                    rule="fallback-tag",
                    message=(
                        f"'{image}' resolved to {_resolved_tag(build)} "
                        f"after {build.get('requestedTag') or '<unknown>'} "
                        f"was not found — the index ships an older build"
                    ),
                    image=image,
                )
            )
    return findings


def check_dpdy_vs_default_packages(
    default_packages_file: Path | None,
    entries: list[DpdyEntry],
) -> list[Finding]:
    """Every default.packages.yaml npm name must appear in the DPDY (by identity)."""
    if default_packages_file is None:
        return []
    if not default_packages_file.is_file():
        return [
            Finding(
                rule="dpdy-missing-package",
                message=f"default.packages.yaml not found: {default_packages_file}",
            )
        ]
    expected = expected_packages_from_default(default_packages_file)
    findings: list[Finding] = []
    for npm_name in expected:
        image = npm_to_image_name(npm_name)
        if _dpdy_covers(entries, npm_name, image):
            continue
        findings.append(
            Finding(
                rule="dpdy-missing-package",
                message=(
                    f"'{npm_name}' is listed in default.packages.yaml but is not "
                    f"in dynamic-plugins.default.yaml (expected image '{image}')"
                ),
                image=image,
            )
        )
    return findings


def _dpdy_covers(entries: list[DpdyEntry], npm_name: str, image: str) -> bool:
    """True when one DPDY entry is this default.packages.yaml package, by identity.

    Substring matches are forbidden: ``backstage-plugin-techdocs-backend``
    contains ``backstage-plugin-techdocs``, and that false cover is what would
    let a missing frontend package publish.
    """
    for entry in entries:
        package = entry.package
        if package == npm_name:
            return True
        ref = parse_oci_ref(package)
        if ref is not None and ref.image == image:
            return True
    return False


def check_version_regression(
    current_versions: dict[str, str],
    previous_versions: dict[str, str],
) -> list[Finding]:
    findings: list[Finding] = []
    for image, prev_version in previous_versions.items():
        current_version = current_versions.get(image)
        if current_version is None:
            continue
        if version_less_than(current_version, prev_version):
            findings.append(
                Finding(
                    rule="version-regression",
                    message=(
                        f"'{image}' version regressed from {prev_version} "
                        f"to {current_version}"
                    ),
                    image=image,
                )
            )
    return findings


def _versions_from_index_path(path: Path) -> dict[str, str]:
    index = load_index_json(path)
    return versions_from_index_json(index) if index else {}


def load_previous_versions(previous_index_dpdy: Path | None) -> dict[str, str]:
    if previous_index_dpdy is None:
        return {}
    if previous_index_dpdy.is_file():
        if previous_index_dpdy.name.endswith((".yaml", ".yml")):
            return versions_from_dpdy_entries(load_dpdy_entries(previous_index_dpdy))
        if previous_index_dpdy.name == INDEX_JSON_FILENAME:
            return _versions_from_index_path(previous_index_dpdy)
        return {}
    if not previous_index_dpdy.is_dir():
        return {}
    # Published catalogs pin DPDY refs to digests; tags live in index.json
    # imageTag. Prefer that map, and only fall back to DPDY when it has none.
    index_path = previous_index_dpdy / INDEX_JSON_FILENAME
    if index_path.is_file():
        versions = _versions_from_index_path(index_path)
        if versions:
            return versions
    dpdy = previous_index_dpdy / DPDY_FILENAME
    if dpdy.is_file():
        return versions_from_dpdy_entries(load_dpdy_entries(dpdy))
    return {}


def check_backstage_mismatch(report_file: Path | None) -> list[Finding]:
    if report_file is None or not report_file.is_file():
        return []
    try:
        with open(report_file, encoding="utf-8") as handle:
            report = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []
    findings: list[Finding] = []
    for plugin_name, plugin in (report.get("plugins") or {}).items():
        if not isinstance(plugin, dict):
            continue
        bootstrap = (plugin.get("stages") or {}).get("bootstrap") or {}
        if not bootstrap.get("bs_version_mismatch"):
            continue
        expected = bootstrap.get("expected_version", "?")
        found = bootstrap.get("found_version", "?")
        findings.append(
            Finding(
                rule="backstage-version-mismatch",
                message=(
                    f"'{plugin_name}': Backstage version mismatch "
                    f"(workspace {found}, expected {expected})"
                ),
                image=plugin_name,
            )
        )
    return findings


def check_index_json(
    index: dict[str, dict] | None,
    by_image: dict[str, ParsedRef],
    builds: dict[str, dict],
    has_build_metadata: bool,
) -> list[Finding]:
    """Cross-check index.json against the refs dynamic-plugins.default.yaml declares.

    `index` is None when the tier ships no index.json, which disables these rules
    rather than reporting every package as missing from it.

    `has_build_metadata=False` disables only `index-missing-entry` (see
    INDEX_RULES_NEEDING_BUILDS). `index-ref-mismatch` reads nothing but index.json and
    the DPDY, so it keeps running — skipping it was lost coverage the "not checked" line
    did not even admit to.
    """
    if index is None:
        return []
    findings: list[Finding] = []
    for image, ref in sorted(by_image.items()):
        findings.extend(
            _check_index_entry(
                image, ref, index.get(image), builds, has_build_metadata
            )
        )
    return findings


def _check_index_entry(
    image: str,
    ref: ParsedRef,
    entry: dict | None,
    builds: dict[str, dict],
    has_build_metadata: bool,
) -> list[Finding]:
    """The index.json rules for one declared package."""
    if entry is None:
        # An unresolved image is legitimately left out of index.json, and
        # `unresolved-image` already reports it — flagging it twice would make the
        # allowlist need two entries for one root cause.
        if has_build_metadata and builds.get(image, {}).get("digest"):
            return [
                Finding(
                    rule="index-missing-entry",
                    message=(
                        f"'{image}' is declared in dynamic-plugins.default.yaml "
                        f"but has no index.json entry"
                    ),
                    image=image,
                )
            ]
        return []

    declared = entry.get("registryReference")
    if not isinstance(declared, str) or not ref.digest:
        return []
    # index.json records the digest-pinned form; compare on the digest alone so a
    # registry rename (quay.io/rhdh -> registry.access.redhat.com/rhdh under
    # --rhec) is not reported as a mismatch when the artifact is identical.
    declared_digest = declared.split("@", 1)[1] if "@" in declared else ""
    if not declared_digest or declared_digest == ref.digest:
        return []
    return [
        Finding(
            rule="index-ref-mismatch",
            message=(
                f"'{image}': index.json points at {declared_digest} but "
                f"dynamic-plugins.default.yaml pins {ref.digest}"
            ),
            image=image,
        )
    ]


def validate(
    output_dir: Path,
    plugin_builds_dir: Path,
    registry: str,
    allowlist: list[AllowlistEntry],
    has_build_metadata: bool,
    default_packages_file: Path | None = None,
    previous_index_dpdy: Path | None = None,
    report_file: Path | None = None,
    community_registry: str | None = None,
    registry_policy_only: bool = False,
) -> ValidationResult:
    """Run every rule and return the surviving findings plus run statistics.

    `has_build_metadata=False` drops the rules RULES_NEEDING_BUILDS names, for a published
    index that ships without the plugin_builds/ tree that produced it.

    A missing DPDY (community tier) still runs plugin_builds checks so unresolved
    community images fail under `--validate-mode gate` (RHIDP-15725).
    """
    dpdy_path = output_dir / DPDY_FILENAME
    builds = load_plugin_builds(plugin_builds_dir) if has_build_metadata else {}
    index = load_index_json(output_dir / INDEX_JSON_FILENAME)

    entries = load_dpdy_entries(dpdy_path) if dpdy_path.is_file() else []
    selected_images = set(builds) | set(index or {})
    selected_images.update(
        ref.image for entry in entries
        if (ref := parse_oci_ref(entry.package)) is not None
    )
    package_entities = load_selected_package_entities(output_dir, selected_images)
    findings = check_registry_policy(
        entries, index, builds, package_entities,
        registry, community_registry or registry,
    )
    if registry_policy_only:
        # update-index.sh calls this unconditionally, even when its other rules run
        # in report/off mode. No allowlist is applied to this result.
        return ValidationResult(findings=findings)

    by_image: dict[str, ParsedRef] = {}
    skipped = [] if has_build_metadata else list(RULES_NEEDING_BUILDS)

    if dpdy_path.is_file():
        dpdy_findings, by_image = check_dpdy(
            entries, builds, has_build_metadata
        )
        findings.extend(dpdy_findings)
        findings.extend(check_index_json(index, by_image, builds, has_build_metadata))
    elif not has_build_metadata:
        skipped = list(RULES_NEEDING_BUILDS)

    if has_build_metadata:
        findings.extend(
            check_builds_outside_dpdy(builds, set(by_image))
        )

    findings.extend(check_dpdy_vs_default_packages(default_packages_file, entries))
    findings.extend(check_backstage_mismatch(report_file))

    current_versions = versions_from_dpdy_entries(entries)
    if not current_versions and index:
        current_versions = versions_from_index_json(index)
    previous_versions = load_previous_versions(previous_index_dpdy)
    if previous_index_dpdy is not None and not previous_versions:
        log_warn(
            f"Previous catalog index at {previous_index_dpdy} contains no "
            "comparable plugin versions; skipping version-regression"
        )
    elif previous_versions:
        findings.extend(check_version_regression(current_versions, previous_versions))

    kept, suppressed = apply_allowlist(findings, allowlist)

    oci_refs = sum(1 for entry in entries if parse_oci_ref(entry.package) is not None)
    return ValidationResult(
        findings=kept,
        suppressed=suppressed,
        stats={
            "packages": len(entries),
            "oci_refs": oci_refs,
            "oci_images": len(by_image),
            "enabled": sum(1 for e in entries if e.enabled),
            "plugin_builds": len(builds),
            "index_entries": len(index) if index is not None else 0,
        },
        skipped_rules=skipped,
    )


def render(result: ValidationResult) -> str:
    """Human-readable report: stats first, then suppressions, then the findings."""
    lines: list[str] = []
    stats = result.stats
    lines.append(
        f"{stats.get('packages', 0)} package(s) declared "
        f"({stats.get('oci_refs', 0)} OCI refs across {stats.get('oci_images', 0)} distinct "
        f"image(s), "
        f"{stats.get('enabled', 0)} enabled) against "
        f"{stats.get('plugin_builds', 0)} plugin_builds entries and "
        f"{stats.get('index_entries', 0)} index.json entries"
    )

    if result.skipped_rules:
        # A pass must never read as "everything was checked" when some rules could not
        # run: the caller has an index and no build metadata to compare it against.
        lines.append(
            f"Not checked (no build metadata): {', '.join(result.skipped_rules)}"
        )

    if result.suppressed:
        lines.append("")
        lines.append(f"Allowlisted ({len(result.suppressed)}):")
        for finding, entry in result.suppressed:
            lines.append(
                f"  - {_label(finding)} "
                f"(allowlisted by {entry.pattern_source}, {entry.ticket})"
            )

    for severity, colour, bucket in (
        (ERROR, Colors.RED, result.errors),
        (WARNING, Colors.YELLOW, result.warnings),
    ):
        if not bucket:
            continue
        lines.append("")
        lines.append(f"{colour}{severity.upper()}S ({len(bucket)}){Colors.NORM}:")
        for finding in bucket:
            lines.append(f"  - {_label(finding)}")

    return "\n".join(lines)


def to_json(
    result: ValidationResult,
    strict: bool,
    allowed_warnings: set[str] | None = None,
) -> dict:
    """The machine-readable shape a workflow step or a status page can consume."""
    allowed = allowed_warnings or set()
    return {
        "status": "fail" if _failed(result, strict, allowed) else "pass",
        "strict": strict,
        "stats": result.stats,
        "skippedRules": result.skipped_rules,
        "findings": [
            {
                "rule": f.rule,
                "severity": f.severity,
                "image": f.image,
                "message": f.message,
            }
            for f in result.findings
        ],
        "allowlisted": [
            {
                "rule": f.rule,
                "image": f.image,
                "message": f.message,
                "ticket": e.ticket,
                "pattern": e.pattern_source,
            }
            for f, e in result.suppressed
        ],
    }


def _failed(
    result: ValidationResult,
    strict: bool,
    allowed_warnings: set[str] | None = None,
) -> bool:
    """Errors always fail. Under --strict, warnings fail unless --allow-warnings named them."""
    if result.errors:
        return True
    if not strict:
        return False
    allowed = allowed_warnings or set()
    return any(finding.rule not in allowed for finding in result.warnings)


def record_in_report(result: ValidationResult, report: BuildReport) -> None:
    """Write a per-plugin `validate` stage into build-report.json.

    Only an ERROR fails the stage: BuildReport.save() derives overall status from the
    worst stage, so a fallback-tag or version-regression warning must not turn a plugin
    red. A tag-only DPDY ref (not-digest-pinned) is an error and should.

    Findings about an image with no plugin row are skipped — `set_stage` upserts, so
    writing one would fabricate a plugin, inflate `summary.total` and flip the run to
    "partial". `reason` is written because that is the field
    renderCatalogStatus.first_failed_stage reads.
    """
    if not report.enabled:
        return
    by_image: dict[str, list[Finding]] = {}
    for finding in result.findings:
        if finding.image:
            by_image.setdefault(finding.image, []).append(finding)

    for image, findings in by_image.items():
        if not report.has_plugin(image):
            log_debug(
                f"Not recording a validate stage for '{image}': no such plugin in the "
                f"build report (the index names an image plugin_builds/ does not)"
            )
            continue
        errors = [f for f in findings if f.severity == ERROR]
        warnings = [f for f in findings if f.severity == WARNING]
        details: dict = {}
        if errors:
            details["errors"] = [_label(f) for f in errors]
            details["reason"] = _label(errors[0])
        if warnings:
            details["warnings"] = [_label(f) for f in warnings]
        report.set_stage(image, "validate", "fail" if errors else "pass", **details)


def _resolve_paths(args) -> tuple[Path, Path, Path, Path | None]:
    """Confine every path that arrived from argv, and default the one that did not.

    Each is resolved and required to stay inside the working directory before any
    filesystem call — the rule smoke-tests-native/src/paths.ts already applies to the
    harness's own flags. Raises ValueError, which main() turns into a usage exit.

    The allowlist DEFAULT is exempt on purpose: it is derived from __file__, not from
    argv, so it is not an injection vector — and confining it would reject the midstream
    layout, where this script runs from a synced overlay-repo checkout reached through a
    symlink.
    """
    return (
        require_contained("--output-dir", args.output_dir),
        require_contained("--plugin-builds-dir", args.plugin_builds_dir),
        (
            require_contained("--allowlist", args.allowlist)
            if args.allowlist is not None
            else Path(__file__).resolve().parent
            / "catalog-index-validation-allowlist.txt"
        ),
        require_contained("--json", args.json_out) if args.json_out else None,
    )


def main() -> int:
    usage = """
Usage: python3 validateCatalogIndex.py \\
    -o|--output-dir PATH \\
    -b|--plugin-builds-dir PATH \\
    -r|--registry BASE \\
    [-cr|--community-registry BASE] \\
    [-a|--allowlist FILE] \\
    [--report-file FILE] [--json FILE] [--strict] [--allow-warnings RULE] \\
    [--registry-policy-only] \\
    [--default-packages-file FILE] \\
    [--previous-index-dpdy FILE] [--list-rules] [--debug]

Examples:

    # As update-index.sh runs it (community index built against ghcr.io)
    python3 validateCatalogIndex.py \\
        --output-dir catalog-index/community \\
        --plugin-builds-dir plugin_builds/community \\
        --registry ghcr.io/redhat-developer/rhdh-plugin-export-overlays

    # Midstream productized index, failing on warnings too
    python3 validateCatalogIndex.py \\
        --output-dir catalog-index \\
        --plugin-builds-dir plugin_builds \\
        --registry quay.io/rhdh \\
        --strict --json catalog-index/validation.json

    # A PUBLISHED index, extracted with scripts/extractCatalogIndex.sh — there is no
    # plugin_builds/ to cross-check against, so those rules are skipped explicitly
    python3 validateCatalogIndex.py \\
        --output-dir /tmp/published \\
        --registry quay.io/rhdh \\
        --no-build-metadata
"""

    parser = argparse.ArgumentParser(
        description="Statically validate a generated catalog index.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=usage,
    )
    parser.error = lambda msg: (
        print(f"\n{Colors.RED}[ERROR] {msg}{Colors.NORM}\n{usage}", file=sys.stderr),
        sys.exit(2),
    )
    parser.add_argument(
        "-o", "--output-dir", type=str, default="catalog-index", metavar="PATH",
        help="Directory holding the generated index (default: catalog-index)",
    )
    parser.add_argument(
        "-b", "--plugin-builds-dir", type=str, default="plugin_builds", metavar="PATH",
        help="Directory holding plugin_builds/ JSON (default: plugin_builds)",
    )
    parser.add_argument(
        "-r", "--registry", type=str, metavar="BASE",
        help="Registry base the index is built against (e.g. quay.io/rhdh)",
    )
    parser.add_argument(
        "-cr", "--community-registry", type=str, metavar="BASE",
        default=None,
        help="Required registry base for community-tier packages (defaults to --registry).",
    )
    parser.add_argument(
        "--registry-policy-only", action="store_true",
        help="Check only the mandatory per-support-tier registry policy. "
             "Used by update-index.sh even when other validation is report/off.",
    )
    parser.add_argument(
        "-a", "--allowlist", type=str, metavar="FILE", default=None,
        help="Ticketed exceptions file (default: scripts/catalog-index-validation-allowlist.txt)",
    )
    parser.add_argument(
        "--report-file", type=str, metavar="FILE",
        help="build-report.json to record a per-plugin 'validate' stage into "
             "and to read bootstrap Backstage-mismatch flags from",
    )
    parser.add_argument(
        "--json", type=str, metavar="FILE", dest="json_out",
        help="Write the findings as JSON to this path",
    )
    parser.add_argument(
        "--strict", action="store_true",
        help="Treat warnings as errors (fallback-tag, backstage-version-mismatch, "
             "version-regression, index-missing-entry)",
    )
    parser.add_argument(
        "--allow-warnings", action="append", default=[], metavar="RULE",
        help="Keep this warning rule non-fatal even under --strict. Repeatable. "
             "Used for a release-* emergency rollback of version-regression.",
    )
    parser.add_argument(
        "--default-packages-file", type=str, metavar="FILE",
        help="default.packages.yaml for dpdy-missing-package identity check",
    )
    parser.add_argument(
        "--previous-index-dpdy", type=str, metavar="FILE",
        help="Previous catalog index DPDY, index.json, or directory (index.json "
             "preferred for tags) for version-regression. Extract an OCI ref with "
             "extractCatalogIndex.sh first — this validator does not touch the network.",
    )
    parser.add_argument(
        "--no-build-metadata", action="store_true",
        help="Skip the rules that need plugin_builds/ "
             f"({', '.join(RULES_NEEDING_BUILDS)}). Use when validating a PUBLISHED "
             "index, which ships dynamic-plugins.default.yaml without the build "
             "metadata that produced it.",
    )
    parser.add_argument(
        "--list-rules", action="store_true",
        help="Print every rule id with its severity and meaning, then exit",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug output")

    args = parser.parse_args()
    set_debug(args.debug)

    if args.list_rules:
        for rule, spec in sorted(RULES.items()):
            needs = " (needs plugin_builds/)" if spec.needs_builds else ""
            print(f"{rule:24} {spec.severity:8} {spec.description}{needs}")
        return 0

    if not args.registry:
        parser.error("--registry is required")

    allowed_warnings = set(args.allow_warnings or [])
    unknown = sorted(allowed_warnings - set(RULES))
    if unknown:
        parser.error(f"unknown --allow-warnings rule: {', '.join(unknown)}")
    not_warnings = sorted(
        rule for rule in allowed_warnings if RULES[rule].severity != WARNING
    )
    if not_warnings:
        parser.error(
            "--allow-warnings only applies to warning rules: "
            + ", ".join(not_warnings)
        )

    try:
        output_dir, plugin_builds_dir, allowlist_path, json_out = _resolve_paths(args)
        default_packages_file = (
            require_contained("--default-packages-file", args.default_packages_file)
            if args.default_packages_file
            else None
        )
        previous_index_dpdy = (
            require_contained("--previous-index-dpdy", args.previous_index_dpdy)
            if args.previous_index_dpdy
            else None
        )
        report_file = (
            require_contained("--report-file", args.report_file)
            if args.report_file
            else None
        )
    except ValueError as exc:
        log_error(str(exc))
        return 2
    dpdy = output_dir / DPDY_FILENAME
    if not dpdy.is_file() and not args.registry_policy_only:
        # Community tier is generated without a DPDY. plugin_builds/ checks still run
        # so a missing community image fails under --validate-mode gate (RHIDP-15725).
        log_info(
            f"No {dpdy} — validating plugin_builds/ "
            "(unresolved-image, missing-annotation, fallback-tag)"
        )

    log_debug(f"output-dir={output_dir} plugin-builds-dir={plugin_builds_dir}")
    log_debug(
        f"registry policy: non-community={args.registry} "
        f"community={args.community_registry or args.registry}"
    )

    try:
        allowlist = [] if args.registry_policy_only else load_allowlist(allowlist_path)
        result = validate(
            output_dir,
            plugin_builds_dir,
            args.registry,
            allowlist,
            has_build_metadata=not args.no_build_metadata,
            default_packages_file=default_packages_file,
            previous_index_dpdy=previous_index_dpdy,
            report_file=report_file,
            community_registry=args.community_registry,
            registry_policy_only=args.registry_policy_only,
        )
    except (ValueError, OSError, yaml.YAMLError) as exc:
        log_error(f"Catalog index validation could not run: {exc}")
        return 1

    if args.registry_policy_only:
        if result.findings:
            for finding in result.findings:
                log_error(_label(finding))
            return 1
        log_info("Registry policy passed")
        return 0

    print(render(result))
    return _emit(result, args, json_out, report_file)


def _emit(
    result: ValidationResult,
    args,
    json_out: Path | None,
    report_file: Path | None,
) -> int:
    """Write the optional outputs and turn the findings into an exit code."""
    if json_out:
        json_out.parent.mkdir(parents=True, exist_ok=True)
        with open(json_out, "w", encoding="utf-8") as f:
            json.dump(
                to_json(result, args.strict, set(args.allow_warnings or [])),
                f,
                indent=2,
            )
            f.write("\n")
        log_debug(f"Wrote {json_out}")

    if report_file:
        record_in_report(result, BuildReport(str(report_file)))

    if _failed(result, args.strict, set(args.allow_warnings or [])):
        log_error(
            f"Catalog index validation failed: {len(result.errors)} error(s), "
            f"{len(result.warnings)} warning(s)"
        )
        return 1

    if result.warnings:
        log_warn(
            f"Catalog index validation passed with {len(result.warnings)} warning(s)"
        )
    else:
        log_info("Catalog index validation passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
