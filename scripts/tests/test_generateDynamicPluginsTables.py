"""Documentation pages describe the generated index, not every copied entity."""

import csv
import io
import json
import sys

import pytest
import yaml

from generateDynamicPluginsTables import CSV_COLUMNS, TableGenerationError, main, render_tables


def add_package(index_dir, name, *, support, reference=None, content="", role="frontend-plugin"):
    packages = index_dir / "catalog-entities/extensions/packages"
    packages.mkdir(parents=True, exist_ok=True)
    reference = reference or f"oci://ghcr.io/org/{name}@sha256:abc123"
    entity = {
        "kind": "Package",
        "metadata": {"name": name, "title": name.removeprefix("org-").title()},
        "spec": {
            "packageName": f"@org/{name.removeprefix('org-')}",
            "dynamicArtifact": reference,
            "version": "1.2.3",
            "support": support,
            "lifecycle": "active",
            "backstage": {"role": role},
            "appConfigExamples": [{"content": content}],
        },
    }
    (packages / f"{name}.yaml").write_text(yaml.safe_dump(entity), encoding="utf-8")


def add_index(index_dir, entries):
    (index_dir / "index.json").write_text(json.dumps(entries), encoding="utf-8")


def index_entry(name, support, registry="ghcr.io/org"):
    return {
        "registryReference": f"{registry}/{name}@sha256:abc123",
        "imageTag": "bs_1.54.9__1.2.3",
        "support": support,
    }


def add_defaults(index_dir, enabled=(), disabled=()):
    data = {"packages": {
        "enabled": [{"package": f"@org/{name}"} for name in enabled],
        "disabled": [{"package": f"@org/{name}"} for name in disabled],
    }}
    (index_dir / "default.packages.yaml").write_text(yaml.safe_dump(data), encoding="utf-8")


def test_community_table_uses_only_indexed_packages(tmp_path, monkeypatch):
    add_index(tmp_path, {"org-foo": index_entry("org-foo", "community")})
    add_package(tmp_path, "org-foo", support="community",
                content="token: ${TOKEN}\nother: ${ALPHA}\nagain: ${TOKEN}")
    add_package(tmp_path, "org-unselected", support="community")

    output_dir = tmp_path / "docs"
    monkeypatch.setattr(sys, "argv", [
        "generateDynamicPluginsTables.py", "--tier", "community",
        "--index-dir", str(tmp_path), "--output-dir", str(output_dir),
    ])
    assert main() == 0
    page = (output_dir / "ref-community-supported-plugins.adoc").read_text()
    assert "following 1 dynamic plugins" in page
    assert "|*Foo*" in page
    assert "|`oci://ghcr.io/org/org-foo@sha256:abc123`" in page
    assert "|bs_1.54.9__1.2.3" in page
    assert page.index("`ALPHA`") < page.index("`TOKEN`")
    assert page.count("`TOKEN`") == 1
    assert "Unselected" not in page
    with (output_dir / "rhdh-community-plugins.csv").open(newline="") as handle:
        reader = csv.DictReader(handle)
        assert reader.fieldnames == list(CSV_COLUMNS)
        rows = list(reader)
    assert rows == [{
        "Name": "Foo", "Plugin": "@org/foo", "Role": "Frontend",
        "Version": "1.2.3", "Support Level": "Community Support",
        "Lifecycle": "active", "Path": "oci://ghcr.io/org/org-foo@sha256:abc123",
        "Required Variables": "`ALPHA`;`TOKEN`", "Default": "N/A",
    }]
    assert len(list(output_dir.iterdir())) == 2


def test_community_csv_identifies_developer_preview(tmp_path):
    add_index(tmp_path, {"org-preview": index_entry("org-preview", "dev-preview")})
    add_package(tmp_path, "org-preview", support="dev-preview", role="backend-plugin")

    outputs = render_tables("community", tmp_path)
    row = next(csv.DictReader(io.StringIO(outputs["rhdh-community-plugins.csv"])))
    assert row["Support Level"] == "Developer Preview"
    assert row["Role"] == "Backend"
    assert row["Default"] == "N/A"
    assert "|*Preview*" in outputs["ref-community-supported-plugins.adoc"]


@pytest.mark.parametrize("registry", ["ghcr.io/org", "quay.io/rhdh", "registry.access.redhat.com/rhdh"])
def test_supported_tables_use_index_refs_and_defaults(tmp_path, registry):
    add_index(tmp_path, {
        "org-ga": index_entry("org-ga", "generally-available", registry),
        "org-tp": index_entry("org-tp", "tech-preview", registry),
    })
    add_package(tmp_path, "org-ga", support="generally-available",
                reference=f"oci://{registry}/org-ga@sha256:abc123")
    add_package(tmp_path, "org-tp", support="tech-preview",
                reference=f"oci://{registry}/org-tp@sha256:abc123", content="key: ${API_KEY}")
    add_package(tmp_path, "org-unselected", support="generally-available")
    add_defaults(tmp_path, enabled=("ga",), disabled=("tp", "unselected"))

    outputs = render_tables("supported", tmp_path)
    assert set(outputs) == {
        "ref-ga-plugins.adoc", "ref-technology-preview-plugins.adoc",
        "ref-deprecated-plugins.adoc", "con-preinstalled-dynamic-plugins.adoc",
        "rhdh-supported-plugins.csv",
    }
    assert "following 1 dynamic plugins" in outputs["ref-ga-plugins.adoc"]
    assert f"oci://{registry}/org-ga@sha256:abc123" in outputs["ref-ga-plugins.adoc"]
    assert "following 1 plugins" in outputs["ref-technology-preview-plugins.adoc"]
    assert "`API_KEY`" in outputs["ref-technology-preview-plugins.adoc"]
    assert "* `@org/ga`" in outputs["con-preinstalled-dynamic-plugins.adoc"]
    assert f"Skipping disabled dynamic plugin oci://{registry}/org-tp@sha256:abc123" in outputs["con-preinstalled-dynamic-plugins.adoc"]
    assert "Unselected" not in "".join(outputs.values())
    rows = list(csv.DictReader(io.StringIO(outputs["rhdh-supported-plugins.csv"])))
    assert len(rows) == 2
    assert rows[0]["Default"] == "Enabled"
    assert rows[1]["Default"] == "Disabled"


def test_rejects_index_entity_reference_mismatch(tmp_path):
    add_index(tmp_path, {"org-foo": index_entry("org-foo", "community")})
    add_package(tmp_path, "org-foo", support="community",
                reference="oci://ghcr.io/org/org-foo@sha256:wrong")
    with pytest.raises(TableGenerationError, match="OCI references differ"):
        render_tables("community", tmp_path)


def test_rejects_indexed_package_without_entity(tmp_path):
    add_index(tmp_path, {"org-foo": index_entry("org-foo", "community")})
    (tmp_path / "catalog-entities/extensions/packages").mkdir(parents=True)
    with pytest.raises(TableGenerationError, match="no Package entity"):
        render_tables("community", tmp_path)


def test_empty_community_index_renders_explicit_empty_page(tmp_path):
    add_index(tmp_path, {})
    (tmp_path / "catalog-entities/extensions/packages").mkdir(parents=True)
    outputs = render_tables("community", tmp_path)
    page = outputs["ref-community-supported-plugins.adoc"]
    assert "There are no community supported plugins" in page
    assert "%%COMMUNITY_TABLE_CONTENT%%" not in page
    assert list(csv.reader(io.StringIO(outputs["rhdh-community-plugins.csv"]))) == [list(CSV_COLUMNS)]
