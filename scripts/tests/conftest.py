import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

sys.path.insert(0, str(SCRIPTS_DIR))


def _load_fixture_json(filename: str) -> dict:
    """Load a JSON fixture file from scripts/tests/fixtures/."""
    with open(FIXTURES_DIR / filename, "r", encoding="utf-8") as f:
        return json.load(f)


def _fixture_path(filename: str) -> Path:
    """Return the absolute path to a fixture file."""
    return FIXTURES_DIR / filename


@pytest.fixture
def sample_plugin_data():
    """Real plugin_builds JSON for a downstream quay.io/rhdh build.

    Source: plugin_builds/supported/adoption-insights/
    Downstream builds include build-date, vcs-ref, upstream, and midstream.
    """
    return _load_fixture_json(
        "red-hat-developer-hub-backstage-plugin-adoption-insights.json"
    )


@pytest.fixture
def sample_plugin_data_no_digest(sample_plugin_data):
    """Plugin_builds entry stripped to pre-enrichment state.

    This is what a plugin_builds JSON looks like before generatePluginBuildInfo
    enriches it with registry metadata — only workspacePath and registryReference.
    """
    data = {}
    for name, fields in sample_plugin_data.items():
        data[name] = {
            "workspacePath": fields["workspacePath"],
            "registryReference": fields["registryReference"],
        }
    return data


@pytest.fixture
def sample_plugin_data_ghcr():
    """Real plugin_builds JSON for a community ghcr.io image.

    Source: plugin_builds/community/3scale/
    Community builds do NOT have build-date, vcs-ref, upstream, or midstream —
    those are only present in downstream quay.io/rhdh builds.
    """
    return _load_fixture_json(
        "backstage-community-plugin-3scale-backend.json"
    )


@pytest.fixture
def sample_package_yaml():
    """Real Package entity YAML from workspaces/backstage/metadata/.

    Source: backstage-plugin-catalog-backend-module-github.yaml
    """
    return _fixture_path("sample-package.yaml")


@pytest.fixture
def sample_packages_yaml():
    """Trimmed default.packages.yaml with enabled and disabled sections.

    Source: derived from default.packages.yaml
    """
    return str(_fixture_path("sample-packages.yaml"))


@pytest.fixture
def sample_packages_txt():
    """Trimmed community packages txt file.

    Source: derived from rhdh-community-packages.txt
    """
    return str(_fixture_path("sample-packages.txt"))


@pytest.fixture
def sample_workspace_dir():
    """Real workspace directory structure from fixtures/workspaces/.

    Contains::

        workspaces/
          backstage/
            plugins-list.yaml
            metadata/
              backstage-plugin-catalog-backend-module-github.yaml
          3scale/
            plugins-list.yaml
            metadata/
              backstage-community-plugin-3scale-backend.yaml
    """
    return FIXTURES_DIR
