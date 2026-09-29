"""Tests for validateCatalogIndex.py — the static catalog-index gate.

The validator's contract is the set of findings it produces for a given tree, so the
tests build small on-disk indexes and assert on rule ids rather than on log text. Each
rule gets both a firing case and a case where it must stay quiet: a validator that
reports everything is as useless as one that reports nothing, and only the negative
tests catch the over-broad rule.
"""

import json
import re
from pathlib import Path

import pytest
import yaml

from validateCatalogIndex import (
    ERROR,
    RULES,
    RULES_NEEDING_BUILDS,
    WARNING,
    AllowlistEntry,
    Finding,
    apply_allowlist,
    load_allowlist,
    load_dpdy_entries,
    load_plugin_builds,
    parse_allowlist,
    parse_oci_ref,
    record_in_report,
    render,
    to_json,
    validate,
    ValidationResult,
)
from plugin_utils import BuildReport

REGISTRY = "quay.io/rhdh"
COMMUNITY_REGISTRY = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays"
DIGEST = "sha256:" + "a" * 64
OTHER_DIGEST = "sha256:" + "b" * 64


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------
def write_index(
    tmp_path,
    packages,
    builds=None,
    index_json=None,
):
    """Lay out a minimal generated index and return (output_dir, plugin_builds_dir).

    `packages` is the plugins[] list verbatim, so a test can write a malformed entry.
    `builds` maps image name -> plugin_builds fields; `index_json` maps image name ->
    index.json entry. Passing None for either omits the file entirely, which is itself
    a case the validator has to survive.
    """
    output_dir = tmp_path / "catalog-index"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "dynamic-plugins.default.yaml").write_text(
        yaml.safe_dump({"plugins": packages}), encoding="utf-8"
    )

    plugin_builds_dir = tmp_path / "plugin_builds"
    if builds is not None:
        for image, fields in builds.items():
            workspace_dir = plugin_builds_dir / "ws"
            workspace_dir.mkdir(parents=True, exist_ok=True)
            (workspace_dir / f"{image}.json").write_text(
                json.dumps({image: fields}), encoding="utf-8"
            )

    if index_json is not None:
        (output_dir / "index.json").write_text(
            json.dumps(index_json), encoding="utf-8"
        )

    return output_dir, plugin_builds_dir


def resolved(image, digest=DIGEST, **extra):
    """A plugin_builds entry for an image whose registry lookup succeeded."""
    return {
        "workspacePath": f"ws/plugins/{image}",
        "registryReference": f"{REGISTRY}/{image}@{digest}",
        "digest": digest,
        **extra,
    }


SHIPPED_ALLOWLIST = (
    Path(__file__).resolve().parent.parent / "catalog-index-validation-allowlist.txt"
)


def run(tmp_path, packages, builds=None, index_json=None, allowlist=None,
        registries=None, has_build_metadata=True):
    output_dir, plugin_builds_dir = write_index(
        tmp_path, packages, builds=builds, index_json=index_json
    )
    return validate(
        output_dir,
        plugin_builds_dir,
        registries or {REGISTRY},
        allowlist or [],
        has_build_metadata=has_build_metadata,
    )


def allowlist_entry(rule, pattern, ticket="RHIDP-1"):
    """An AllowlistEntry without the positional noise at the call site."""
    return AllowlistEntry(
        rule=rule, pattern=re.compile(pattern), ticket=ticket, pattern_source=pattern
    )


def rules_of(result):
    return sorted(f.rule for f in result.findings)


# ---------------------------------------------------------------------------
# parse_oci_ref
# ---------------------------------------------------------------------------
class TestParseOciRef:
    @pytest.mark.parametrize(
        "ref, registry, image, digest, tag",
        [
            pytest.param(
                f"oci://{REGISTRY}/plugin-a@{DIGEST}",
                REGISTRY, "plugin-a", DIGEST, "",
                id="digest_pinned",
            ),
            pytest.param(
                f"oci://{REGISTRY}/plugin-a:2.0.0--1.2.3",
                REGISTRY, "plugin-a", "", "2.0.0--1.2.3",
                id="tag_only",
            ),
            pytest.param(
                f"oci://{COMMUNITY_REGISTRY}/plugin-a@{DIGEST}",
                COMMUNITY_REGISTRY, "plugin-a", DIGEST, "",
                id="multi_segment_registry_path",
            ),
            pytest.param(
                f"oci://{REGISTRY}/plugin-a@{DIGEST}!plugin-a-dynamic",
                REGISTRY, "plugin-a", DIGEST, "",
                id="selector_is_not_part_of_image_identity",
            ),
            pytest.param(
                f"oci://{REGISTRY}/plugin-a@{DIGEST}!scope/name",
                REGISTRY, "plugin-a", DIGEST, "",
                id="selector_containing_a_slash",
            ),
            pytest.param(
                f"oci://{REGISTRY}/plugin-a:1.11--1.5.4@{DIGEST}",
                REGISTRY, "plugin-a", DIGEST, "1.11--1.5.4",
                id="tag_and_digest",
            ),
            pytest.param(
                "oci://localhost:5000/foo/plugin-a:1.0",
                "localhost:5000/foo", "plugin-a", "", "1.0",
                id="registry_with_a_port",
            ),
        ],
    )
    def test_parses(self, ref, registry, image, digest, tag):
        parsed = parse_oci_ref(ref)
        assert parsed is not None
        assert (parsed.registry, parsed.image, parsed.digest, parsed.tag) == (
            registry,
            image,
            digest,
            tag,
        )

    @pytest.mark.parametrize(
        "ref",
        [
            pytest.param("./dynamic-plugins/dist/plugin-a", id="local_path"),
            pytest.param("plugin-a", id="bare_name"),
            pytest.param("oci://plugin-a", id="no_registry_segment"),
            pytest.param("oci://localhost:5000", id="registry_only"),
            pytest.param("oci://", id="prefix_only"),
            pytest.param("", id="empty"),
        ],
    )
    def test_rejects(self, ref):
        assert parse_oci_ref(ref) is None

    def test_agrees_with_the_repo_s_own_reference_parser(self):
        """The grammar is delegated, not re-invented.

        Writing a second grammar here is what made this the only parser in the repo
        that rejected `name:tag@digest` — and rejected it as `ref-form`, an error no
        allowlist entry can suppress because it carries no image name. Under
        `--validate-mode gate` that is an inescapable red build on a shape
        `generateCatalogIndex.py` documents as valid and writes itself.
        """
        from plugin_utils import parse_image_reference

        for body in (
            f"{REGISTRY}/plugin-a@{DIGEST}",
            f"{REGISTRY}/plugin-a:1.11--1.5.4",
            f"{REGISTRY}/plugin-a:1.11--1.5.4@{DIGEST}",
            "localhost:5000/foo/plugin-a:1.0",
        ):
            name, tag, digest = parse_image_reference(body)
            parsed = parse_oci_ref(f"oci://{body}")
            assert parsed is not None, body
            assert name == f"{parsed.registry}/{parsed.image}", body
            assert (parsed.tag, parsed.digest) == (tag, digest), body

    def test_a_short_digest_is_not_accepted_as_a_digest(self):
        """A truncated digest must not read as pinned.

        `not-digest-pinned` and `digest-mismatch` both key off `ref.digest`, so a
        loose pattern here would silently declare a malformed ref well-pinned.
        """
        assert parse_oci_ref(f"oci://{REGISTRY}/plugin-a@sha256:abc") is None


# ---------------------------------------------------------------------------
# load_dpdy_entries
# ---------------------------------------------------------------------------
class TestLoadDpdyEntries:
    def test_reads_package_and_enabled(self, tmp_path):
        output_dir, _ = write_index(
            tmp_path,
            [
                {"package": f"oci://{REGISTRY}/a@{DIGEST}", "enabled": True},
                {"package": f"oci://{REGISTRY}/b@{DIGEST}", "enabled": False},
            ],
        )
        entries = load_dpdy_entries(output_dir / "dynamic-plugins.default.yaml")
        assert [(e.package.rsplit("/", 1)[-1].split("@")[0], e.enabled, e.position)
                for e in entries] == [("a", True, 0), ("b", False, 1)]

    def test_accepts_the_install_cli_disabled_spelling(self, tmp_path):
        """`disabled: false` and `enabled: true` mean the same thing to the CLI."""
        output_dir, _ = write_index(
            tmp_path, [{"package": f"oci://{REGISTRY}/a@{DIGEST}", "disabled": False}]
        )
        entries = load_dpdy_entries(output_dir / "dynamic-plugins.default.yaml")
        assert entries[0].enabled is True

    def test_defaults_to_disabled(self, tmp_path):
        """The index ships most plugins off; an entry with neither key is one of them."""
        output_dir, _ = write_index(
            tmp_path, [{"package": f"oci://{REGISTRY}/a@{DIGEST}"}]
        )
        assert load_dpdy_entries(
            output_dir / "dynamic-plugins.default.yaml"
        )[0].enabled is False

    @pytest.mark.parametrize(
        "content, expected",
        [
            pytest.param("", "is empty", id="empty_file"),
            pytest.param("- a\n- b\n", "expected a mapping", id="top_level_list"),
            pytest.param("other: 1\n", "no 'plugins' key", id="no_plugins_key"),
            pytest.param("plugins: {}\n", "not a list", id="plugins_not_a_list"),
            pytest.param("plugins:\n  - just-a-string\n", "not a mapping",
                         id="entry_not_a_mapping"),
            pytest.param("plugins:\n  - enabled: true\n", "no string 'package' key",
                         id="entry_without_package"),
        ],
    )
    def test_malformed_files_raise_rather_than_read_as_empty(
        self, tmp_path, content, expected
    ):
        """Every rule reads this list, so an unparseable file must not look clean."""
        path = tmp_path / "dynamic-plugins.default.yaml"
        path.write_text(content, encoding="utf-8")
        with pytest.raises(ValueError, match=expected):
            load_dpdy_entries(path)


# ---------------------------------------------------------------------------
# load_plugin_builds
# ---------------------------------------------------------------------------
class TestLoadPluginBuilds:
    def test_flattens_the_workspace_tree(self, tmp_path):
        for workspace, image in (("ws1", "plugin-a"), ("ws2", "plugin-b")):
            d = tmp_path / "plugin_builds" / workspace
            d.mkdir(parents=True)
            (d / f"{image}.json").write_text(json.dumps({image: {"digest": DIGEST}}))
        builds = load_plugin_builds(tmp_path / "plugin_builds")
        assert sorted(builds) == ["plugin-a", "plugin-b"]

    def test_missing_directory_is_not_an_error(self, tmp_path):
        assert load_plugin_builds(tmp_path / "nope") == {}

    def test_an_unreadable_file_is_skipped_not_fatal(self, tmp_path):
        """A broken build file means the generation step failed, not the index."""
        d = tmp_path / "plugin_builds" / "ws"
        d.mkdir(parents=True)
        (d / "broken.json").write_text("{not json", encoding="utf-8")
        (d / "plugin-a.json").write_text(json.dumps({"plugin-a": {"digest": DIGEST}}))
        assert sorted(load_plugin_builds(tmp_path / "plugin_builds")) == ["plugin-a"]


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------
class TestRules:
    def test_a_well_formed_index_produces_no_findings(self, tmp_path):
        result = run(
            tmp_path,
            [
                {"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}", "enabled": True},
                {"package": "./dynamic-plugins/dist/plugin-b", "enabled": False},
            ],
            builds={"plugin-a": resolved("plugin-a")},
            index_json={"plugin-a": {"registryReference": f"{REGISTRY}/plugin-a@{DIGEST}"}},
        )
        assert result.findings == []
        assert result.stats == {
            "packages": 2,
            "oci_refs": 1,
            "oci_images": 1,
            "local_refs": 1,
            "enabled": 1,
            "plugin_builds": 1,
            "index_entries": 1,
        }

    def test_a_non_oci_scheme_is_reported(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": "docker://quay.io/rhdh/plugin-a:1.0"}],
            builds={},
        )
        assert rules_of(result) == ["ref-form"]

    def test_the_same_ref_declared_twice_is_reported(self, tmp_path):
        ref = f"oci://{REGISTRY}/plugin-a@{DIGEST}"
        result = run(
            tmp_path,
            [{"package": ref, "enabled": True}, {"package": ref, "enabled": False}],
            builds={"plugin-a": resolved("plugin-a")},
        )
        assert "duplicate-ref" in rules_of(result)
        duplicate = next(f for f in result.findings if f.rule == "duplicate-ref")
        # Naming both positions is what makes the finding actionable in a 50-entry file.
        assert "plugins[0]" in duplicate.message
        assert "plugins[1]" in duplicate.message

    def test_the_same_image_at_two_different_digests_is_not_a_duplicate(self, tmp_path):
        """Only an identical ref shadows config; two refs are a different problem."""
        result = run(
            tmp_path,
            [
                {"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"},
                {"package": f"oci://{REGISTRY}/plugin-a@{OTHER_DIGEST}"},
            ],
            builds={"plugin-a": resolved("plugin-a")},
        )
        assert "duplicate-ref" not in rules_of(result)
        assert "digest-mismatch" in rules_of(result)

    def test_a_ref_from_an_undeclared_registry_is_reported(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{COMMUNITY_REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
        )
        assert "registry-not-allowed" in rules_of(result)

    def test_a_declared_community_registry_is_allowed(self, tmp_path):
        """The supported index legitimately mixes in community-tier ghcr.io packages."""
        result = run(
            tmp_path,
            [{"package": f"oci://{COMMUNITY_REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
            registries={REGISTRY, COMMUNITY_REGISTRY},
        )
        assert "registry-not-allowed" not in rules_of(result)

    def test_an_image_with_no_build_entry_is_reported(self, tmp_path):
        result = run(
            tmp_path, [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}], builds={}
        )
        assert rules_of(result) == ["unknown-image"]

    def test_the_ref_only_rules_fire_even_when_the_image_is_unknown(self, tmp_path):
        """Registry and pinning are properties of the REF, so they never depend on
        plugin_builds/.

        An earlier version returned early on `unknown-image`, which made the same
        tag-only ref report `not-digest-pinned` under `--no-build-metadata` and not
        otherwise — the two paths disagreed about a rule neither of them needs build
        metadata to answer.
        """
        result = run(
            tmp_path, [{"package": f"oci://{REGISTRY}/plugin-a:1.0"}], builds={}
        )
        assert rules_of(result) == ["not-digest-pinned", "unknown-image"]

    def test_the_build_rules_stop_at_the_first_that_cannot_proceed(self, tmp_path):
        """With no build entry there is nothing to compare digests against."""
        result = run(
            tmp_path, [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}], builds={}
        )
        assert rules_of(result) == ["unknown-image"]

    def test_a_digest_disagreeing_with_plugin_builds_is_reported(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{OTHER_DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a", digest=DIGEST)},
        )
        assert "digest-mismatch" in rules_of(result)

    def test_unresolved_image(self, tmp_path):
        """The live defect this rule exists for: shipped, but never found in the registry.

        Modelled on backstage-community-plugin-auth-backend-module-keycloak-provider in
        the productized index — plugin_builds/ has a registryReference but no digest,
        because the lookup reported "Image not found in registry", and the package
        shipped anyway.
        """
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a:2.0.0--0.4.0"}],
            builds={
                "plugin-a": {
                    "workspacePath": "ws/plugins/plugin-a",
                    "registryReference": f"{REGISTRY}/plugin-a:2.0.0--0.4.0",
                }
            },
        )
        assert "unresolved-image" in rules_of(result)
        assert next(f for f in result.findings if f.rule == "unresolved-image").severity == ERROR

    def test_a_tag_only_ref_is_a_warning_not_an_error(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a:2.0.0--1.2.3"}],
            builds={"plugin-a": resolved("plugin-a")},
        )
        finding = next(f for f in result.findings if f.rule == "not-digest-pinned")
        assert finding.severity == WARNING

    def test_a_substituted_older_build_is_a_warning(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}],
            builds={
                "plugin-a": resolved(
                    "plugin-a",
                    fallback=True,
                    requestedTag="2.0.0--1.7.2",
                    registryReference=f"{REGISTRY}/plugin-a:2.0.0--1.7.0",
                )
            },
        )
        finding = next(f for f in result.findings if f.rule == "fallback-tag")
        assert finding.severity == WARNING
        # Both tags in the message: "ships an older build" is only actionable if you
        # can see which build was wanted and which one landed.
        assert "2.0.0--1.7.0" in finding.message
        assert "2.0.0--1.7.2" in finding.message

    def test_a_resolved_package_absent_from_index_json_is_reported(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
            index_json={},
        )
        assert "index-missing-entry" in rules_of(result)

    def test_an_unresolved_image_is_not_also_reported_as_missing_from_the_index(
        self, tmp_path
    ):
        """One root cause, one finding — otherwise the allowlist needs two entries."""
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a:1.0"}],
            builds={"plugin-a": {"registryReference": f"{REGISTRY}/plugin-a:1.0"}},
            index_json={},
        )
        assert "index-missing-entry" not in rules_of(result)
        assert "unresolved-image" in rules_of(result)

    def test_index_json_and_the_dpdy_disagreeing_is_reported(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
            index_json={
                "plugin-a": {"registryReference": f"{REGISTRY}/plugin-a@{OTHER_DIGEST}"}
            },
        )
        assert "index-ref-mismatch" in rules_of(result)

    def test_a_registry_rename_alone_is_not_a_ref_mismatch(self, tmp_path):
        """`--rhec` republishes the same artifact under registry.access.redhat.com."""
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
            index_json={
                "plugin-a": {
                    "registryReference": f"registry.access.redhat.com/rhdh/plugin-a@{DIGEST}"
                }
            },
        )
        assert "index-ref-mismatch" not in rules_of(result)

    def test_a_missing_index_json_disables_only_the_index_rules(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
            index_json=None,
        )
        assert result.findings == []

    def test_in_image_packages_are_exempt_from_every_registry_rule(self, tmp_path):
        """`./dynamic-plugins/dist/…` ships inside the RHDH image — nothing to resolve."""
        result = run(
            tmp_path,
            [{"package": "./dynamic-plugins/dist/plugin-a-dynamic"}],
            builds={},
            index_json={},
        )
        assert result.findings == []
        assert result.stats["local_refs"] == 1


# ---------------------------------------------------------------------------
# Allowlist
# ---------------------------------------------------------------------------
class TestAllowlist:
    def test_parses_a_ticketed_entry(self):
        entries = parse_allowlist(
            "# TODO(RHIDP-1234): not published yet\nunresolved-image ^plugin-a$\n",
            "allowlist.txt",
        )
        assert len(entries) == 1
        assert entries[0].rule == "unresolved-image"
        assert entries[0].ticket == "RHIDP-1234"

    def test_a_blank_line_ends_the_block(self):
        """Otherwise a later pattern inherits a ticket it has nothing to do with."""
        text = (
            "# TODO(RHIDP-1): reason\n"
            "unresolved-image ^plugin-a$\n"
            "\n"
            "unresolved-image ^plugin-b$\n"
        )
        with pytest.raises(ValueError, match="has no tracking ticket"):
            parse_allowlist(text, "allowlist.txt")

    def test_consecutive_patterns_share_one_ticket(self):
        text = (
            "# TODO(RHIDP-1): three unpublished images\n"
            "unresolved-image ^plugin-a$\n"
            "unresolved-image ^plugin-b$\n"
        )
        assert [e.pattern_source for e in parse_allowlist(text, "allowlist.txt")] == [
            "^plugin-a$",
            "^plugin-b$",
        ]

    def test_two_tickets_on_one_entry(self):
        entries = parse_allowlist(
            "# TODO(RHIDP-1, RHDHBUGS-2): blocked twice\nfallback-tag ^plugin-a$\n",
            "allowlist.txt",
        )
        assert entries[0].ticket == "RHIDP-1, RHDHBUGS-2"

    def test_a_malformed_ticket_key_does_not_leak_the_previous_block(self, capsys):
        """A typo would otherwise file entries under an unrelated, closable ticket."""
        text = (
            "# TODO(RHIDP-1): real block\n"
            "unresolved-image ^plugin-a$\n"
            "\n"
            "# TODO(RHIDP1234): typo\n"
            "unresolved-image ^plugin-b$\n"
        )
        with pytest.raises(ValueError, match="has no tracking ticket"):
            parse_allowlist(text, "allowlist.txt")
        assert "looks like a TODO marker" in capsys.readouterr().out

    def test_an_unknown_rule_id_is_a_parse_error(self):
        """A typo here must not silently suppress nothing."""
        with pytest.raises(ValueError, match="unknown rule 'unresolved-images'"):
            parse_allowlist(
                "# TODO(RHIDP-1): x\nunresolved-images ^plugin-a$\n", "allowlist.txt"
            )

    def test_an_invalid_regex_is_a_parse_error(self):
        with pytest.raises(ValueError, match="invalid regex"):
            parse_allowlist("# TODO(RHIDP-1): x\nfallback-tag ^plugin-($\n", "a.txt")

    @pytest.mark.parametrize(
        "line",
        [
            pytest.param("unresolved-image", id="no_pattern"),
            pytest.param("unresolved-image ^a$ extra", id="trailing_token"),
        ],
    )
    def test_a_malformed_entry_is_a_parse_error(self, line):
        with pytest.raises(ValueError, match="expected '<rule-id> <regex>'"):
            parse_allowlist(f"# TODO(RHIDP-1): x\n{line}\n", "allowlist.txt")

    def test_a_missing_file_means_no_exceptions(self, tmp_path):
        assert load_allowlist(tmp_path / "absent.txt") == []

    def test_suppresses_only_the_named_rule(self):
        allowlist = [allowlist_entry("unresolved-image", "^plugin-a$")]
        findings = [
            Finding("unresolved-image", "m", "plugin-a"),
            Finding("fallback-tag", "m", "plugin-a"),
            Finding("unresolved-image", "m", "plugin-b"),
        ]
        kept, suppressed = apply_allowlist(findings, allowlist)
        assert [(f.rule, f.image) for f in kept] == [
            ("fallback-tag", "plugin-a"),
            ("unresolved-image", "plugin-b"),
        ]
        assert len(suppressed) == 1

    def test_a_structural_finding_is_never_suppressed(self):
        """`ref-form` is about the file, not a package — an image regex cannot judge it."""
        allowlist = [allowlist_entry("ref-form", ".*")]
        kept, suppressed = apply_allowlist([Finding("ref-form", "m")], allowlist)
        assert len(kept) == 1
        assert suppressed == []

    def test_end_to_end_through_validate(self, tmp_path):
        allowlist_file = tmp_path / "allowlist.txt"
        allowlist_file.write_text(
            "# TODO(RHIDP-1): tracked\nunresolved-image ^plugin-a$\n", encoding="utf-8"
        )
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a:1.0"}],
            builds={"plugin-a": {"registryReference": f"{REGISTRY}/plugin-a:1.0"}},
            allowlist=load_allowlist(allowlist_file),
        )
        assert "unresolved-image" not in rules_of(result)
        assert [f.rule for f, _ in result.suppressed] == ["unresolved-image"]


# ---------------------------------------------------------------------------
# Severity accounting and output
# ---------------------------------------------------------------------------
class TestOutputs:
    def test_every_rule_has_a_documented_severity(self):
        """`--list-rules`, the allowlist parser and Finding.severity all read RULES."""
        assert RULES
        for rule, spec in RULES.items():
            assert spec.severity in (ERROR, WARNING), rule
            assert spec.description, rule

    def test_errors_and_warnings_are_partitioned(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a:1.0"}],
            builds={"plugin-a": {"registryReference": f"{REGISTRY}/plugin-a:1.0"}},
        )
        assert [f.rule for f in result.errors] == ["unresolved-image"]
        assert [f.rule for f in result.warnings] == ["not-digest-pinned"]

    def test_render_names_every_finding_and_the_allowlist_ticket(self, tmp_path):
        allowlist_file = tmp_path / "allowlist.txt"
        allowlist_file.write_text(
            "# TODO(RHIDP-99): tracked\nnot-digest-pinned ^plugin-a$\n", encoding="utf-8"
        )
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a:1.0"}],
            builds={"plugin-a": {"registryReference": f"{REGISTRY}/plugin-a:1.0"}},
            allowlist=load_allowlist(allowlist_file),
        )
        text = render(result)
        assert "unresolved-image" in text
        assert "RHIDP-99" in text
        assert "1 package(s) declared" in text

    @pytest.mark.parametrize(
        "strict, expected",
        [pytest.param(False, "pass", id="warnings_alone_pass"),
         pytest.param(True, "fail", id="strict_fails_on_warnings")],
    )
    def test_to_json_status_follows_strict(self, tmp_path, strict, expected):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}],
            builds={
                "plugin-a": resolved("plugin-a", fallback=True, requestedTag="2.0")
            },
        )
        assert to_json(result, strict)["status"] == expected

    def test_to_json_carries_rule_severity_and_image(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a:1.0"}],
            builds={"plugin-a": {"registryReference": f"{REGISTRY}/plugin-a:1.0"}},
        )
        payload = to_json(result, False)
        assert {f["rule"] for f in payload["findings"]} == {
            "unresolved-image",
            "not-digest-pinned",
        }
        assert all(f["image"] == "plugin-a" for f in payload["findings"])


# ---------------------------------------------------------------------------
# --no-build-metadata (a published index, with no plugin_builds/ beside it)
# ---------------------------------------------------------------------------
class TestNoBuildMetadata:
    PUBLISHED = [
        {"package": f"oci://{REGISTRY}/plugin-a:2.0.0--0.4.0"},
        {"package": f"oci://{REGISTRY}/plugin-b@{DIGEST}"},
    ]

    def test_the_build_metadata_rules_are_skipped(self, tmp_path):
        """Without the flag these fire for EVERY package and drown the real findings.

        A published catalog index image carries dynamic-plugins.default.yaml and not
        the plugin_builds/ tree that produced it, so there is nothing to cross-check.
        """
        result = run(tmp_path, self.PUBLISHED, builds={}, has_build_metadata=False)
        assert not (set(rules_of(result)) & set(RULES_NEEDING_BUILDS))

    def test_without_the_flag_the_same_input_is_all_errors(self, tmp_path):
        result = run(tmp_path, self.PUBLISHED, builds={})
        assert sorted(set(rules_of(result))) == ["not-digest-pinned", "unknown-image"]
        assert len([f for f in result.findings if f.rule == "unknown-image"]) == 2

    def test_pinning_is_still_checked(self, tmp_path):
        """Pinning is a property of the ref itself — still answerable."""
        result = run(tmp_path, self.PUBLISHED, builds={}, has_build_metadata=False)
        assert rules_of(result) == ["not-digest-pinned"]

    def test_the_registry_is_still_checked(self, tmp_path):
        """So is the registry — and a failure here should not read as a pinning fault."""
        result = run(
            tmp_path,
            [{"package": f"oci://{COMMUNITY_REGISTRY}/plugin-a@{DIGEST}"}],
            builds={},
            has_build_metadata=False,
        )
        assert "registry-not-allowed" in rules_of(result)

    def test_the_skipped_rules_are_named(self, tmp_path):
        """A pass must not read as "everything was checked".

        `index-missing-entry` belongs here too: it needs plugin_builds/ to tell a
        package that failed to resolve (and is legitimately absent from index.json)
        from one that went missing. An earlier version skipped it — along with
        `index-ref-mismatch`, which needs no build metadata at all — without naming
        either, which is exactly the overstated pass this field exists to prevent.
        """
        expected = RULES_NEEDING_BUILDS
        result = run(tmp_path, self.PUBLISHED, builds={}, has_build_metadata=False)
        assert result.skipped_rules == expected
        assert "Not checked (no build metadata)" in render(result)
        assert to_json(result, False)["skippedRules"] == expected

    def test_index_ref_mismatch_still_runs_without_build_metadata(self, tmp_path):
        """It reads index.json and the DPDY only — skipping it was lost coverage."""
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}],
            builds={},
            index_json={
                "plugin-a": {"registryReference": f"{REGISTRY}/plugin-a@{OTHER_DIGEST}"}
            },
            has_build_metadata=False,
        )
        assert "index-ref-mismatch" in rules_of(result)

    def test_a_normal_run_names_no_skipped_rules(self, tmp_path):
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-a@{DIGEST}"}],
            builds={"plugin-a": resolved("plugin-a")},
        )
        assert result.skipped_rules == []
        assert "Not checked" not in render(result)

    def test_index_missing_entry_is_skipped_without_build_metadata(self, tmp_path):
        """It cannot tell an unresolved package from a genuinely missing one."""
        result = run(
            tmp_path,
            [{"package": f"oci://{REGISTRY}/plugin-b@{DIGEST}"}],
            builds={},
            index_json={},
            has_build_metadata=False,
        )
        assert "index-missing-entry" not in rules_of(result)

    def test_the_skipped_set_is_derived_from_the_rule_table(self):
        """It used to be two hand-maintained frozensets, and they drifted.

        Deriving it means a rule cannot be skipped without saying so in its own row,
        and a typo can no longer name a rule that does not exist.
        """
        assert RULES_NEEDING_BUILDS == sorted(
            r for r, spec in RULES.items() if spec.needs_builds
        )
        assert set(RULES_NEEDING_BUILDS) <= set(RULES)


# ---------------------------------------------------------------------------
# build-report.json integration
# ---------------------------------------------------------------------------
class TestRecordInReport:
    """`record_in_report` writes the stage renderCatalogStatus.py will read back."""

    @staticmethod
    def _report(tmp_path, plugins=("plugin-a",)):
        report_file = tmp_path / "build-report.json"
        report = BuildReport(str(report_file))
        for name in plugins:
            report.add_plugin(name, package=f"@scope/{name}")
        return report_file, report

    def test_an_error_fails_the_plugins_validate_stage(self, tmp_path):
        report_file, report = self._report(tmp_path)
        record_in_report(
            ValidationResult(findings=[Finding("unresolved-image", "m", "plugin-a")]),
            report,
        )
        report.save()
        data = json.loads(report_file.read_text())
        stage = data["plugins"]["plugin-a"]["stages"]["validate"]
        assert stage["status"] == "fail"
        assert stage["errors"] == ["[unresolved-image] m"]
        # No warnings fired, so the key must be absent rather than an empty list —
        # a reader treats a present-but-empty list as "checked and clean".
        assert "warnings" not in stage
        assert data["plugins"]["plugin-a"]["overall"] == "fail"

    def test_an_error_writes_the_reason_the_status_page_reads(self, tmp_path):
        """renderCatalogStatus.first_failed_stage reads `reason` and nothing else.

        Without it a plugin whose only failing stage is this one renders as
        "Unknown error" on the generated status page, however precisely the finding
        was recorded.
        """
        from renderCatalogStatus import first_failed_stage

        report_file, report = self._report(tmp_path)
        record_in_report(
            ValidationResult(
                findings=[Finding("unresolved-image", "never resolved", "plugin-a")]
            ),
            report,
        )
        report.save()
        stages = json.loads(report_file.read_text())["plugins"]["plugin-a"]["stages"]
        label, reason = first_failed_stage(stages)
        assert label == "Catalog Index Validation"
        assert "never resolved" in reason

    def test_warnings_alone_keep_the_stage_passing(self, tmp_path):
        """A stale tag must not turn a plugin red and drown the genuinely broken ones."""
        report_file, report = self._report(tmp_path)
        record_in_report(
            ValidationResult(findings=[Finding("fallback-tag", "older", "plugin-a")]),
            report,
        )
        report.save()
        data = json.loads(report_file.read_text())
        stage = data["plugins"]["plugin-a"]["stages"]["validate"]
        assert stage["status"] == "pass"
        assert stage["warnings"] == ["[fallback-tag] older"]
        assert "errors" not in stage
        assert "reason" not in stage
        assert data["plugins"]["plugin-a"]["overall"] == "pass"

    def test_a_finding_about_an_unknown_image_creates_no_plugin(self, tmp_path):
        """`set_stage` upserts, so an image name the report does not track would be
        CREATED — inflating summary.total and flipping the run to "partial".

        `unknown-image` is by definition an image with no plugin_builds/ entry, so it
        is exactly the finding that names something bootstrap never registered.
        """
        report_file, report = self._report(tmp_path)
        record_in_report(
            ValidationResult(
                findings=[
                    Finding("unknown-image", "no build entry", "ghost-image"),
                    Finding("unresolved-image", "m", "plugin-a"),
                ]
            ),
            report,
        )
        report.save()
        data = json.loads(report_file.read_text())
        assert list(data["plugins"]) == ["plugin-a"]
        assert data["summary"]["total"] == 1

    def test_a_disabled_report_writes_nothing(self, tmp_path):
        """The no-op has to be observable, or "it did not raise" is all that is tested."""
        report_file = tmp_path / "build-report.json"
        record_in_report(
            ValidationResult(findings=[Finding("unresolved-image", "m", "plugin-a")]),
            BuildReport(None),
        )
        assert not report_file.exists()
        assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# The status page contract
# ---------------------------------------------------------------------------
class TestTroubleshootingAnchors:
    """AGENTS.md: "Anchor slugs must stay in sync with REASON_ANCHORS in the renderer."

    It lives here because this module is what put rule ids into that map: Step 5 writes
    its reason as "[rule-id] message", so the rule id IS the prefix reason_to_link
    matches on. Nothing tested that contract before, and a broken anchor is invisible —
    the status page just renders the reason with no link.
    """

    @staticmethod
    def _doc_ids():
        import re

        doc = (
            Path(__file__).resolve().parent.parent.parent
            / "user-guide"
            / "troubleshooting-catalog-index.md"
        ).read_text(encoding="utf-8")
        explicit = set(re.findall(r'<a id="([^"]+)"', doc))
        headings = {
            re.sub(r"[^a-z0-9]+", "-", h.lower()).strip("-")
            for h in re.findall(r"^#{2,4} (.+)$", doc, re.M)
        }
        return explicit | headings

    def test_every_anchor_exists_in_the_troubleshooting_doc(self):
        from renderCatalogStatus import REASON_ANCHORS

        ids = self._doc_ids()
        missing = sorted(a for a in REASON_ANCHORS.values() if a not in ids)
        assert missing == [], "REASON_ANCHORS pointing at headings that do not exist"

    def test_every_rule_id_anchor_names_a_live_rule(self):
        """A `[rule-id]` prefix that no longer exists links a reason nothing produces."""
        from renderCatalogStatus import REASON_ANCHORS

        for prefix in REASON_ANCHORS:
            if prefix.startswith("[") and prefix.endswith("]"):
                assert prefix[1:-1] in RULES, prefix

    def test_a_validate_reason_resolves_to_a_link(self):
        """End to end: the reason this module writes becomes a documented link."""
        from renderCatalogStatus import reason_to_link

        doc = (
            Path(__file__).resolve().parent.parent.parent
            / "user-guide"
            / "troubleshooting-catalog-index.md"
        ).read_text(encoding="utf-8")
        rendered = reason_to_link("[unresolved-image] 'plugin-a' was never resolved", doc)
        assert "#validation-unresolved-image" in rendered


# ---------------------------------------------------------------------------
# The shipped allowlist
# ---------------------------------------------------------------------------
class TestShippedAllowlist:
    """The committed file is loaded on every run; a typo breaks every generation."""

    def test_it_parses(self):
        load_allowlist(SHIPPED_ALLOWLIST)

    def test_every_entry_names_a_live_rule_and_carries_a_ticket(self):
        """An entry naming a deleted rule suppresses nothing, silently, forever.

        Trivially true while the file ships empty — which is the point: it goes red the
        first time an entry outlives the rule it was written against, rather than the
        entry surviving until someone thinks to re-read the file.
        """
        for entry in load_allowlist(SHIPPED_ALLOWLIST):
            assert entry.rule in RULES, entry.pattern_source
            assert entry.ticket, entry.pattern_source
