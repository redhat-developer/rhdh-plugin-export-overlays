"""Tests for scripts/e2e-comment.cjs — reading a publish target out of a comment.

This parser decides two things that nothing downstream re-checks: WHICH run's
coverage gets published upstream, and WHETHER a run publishes at all. Both fail
quietly. A pattern that matches a failure report publishes a broken run's number
as the plugin's record; one that stops matching publishes nothing, and a
workflow that publishes nothing still reports success.

The fixture body below is a real comment from PR #3241 (extensions), kept
verbatim so a drift in the bot's format shows up here rather than in a silent
no-op weeks later.

Driven through `node` rather than imported, because the logic is CommonJS —
the same reason test_upstream_paths.py does it that way.
"""

import json
import shutil
import subprocess

import pytest

from tests.shell_harness import SCRIPTS_DIR

MODULE = SCRIPTS_DIR / "e2e-comment.cjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not available"
)

ARTIFACTS = (
    "https://gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com/gcs/test-platform-results"
    "/pr-logs/pull/redhat-developer_rhdh-plugin-export-overlays/3241"
    "/pull-ci-redhat-developer-rhdh-plugin-export-overlays-main-e2e-ocp-helm"
    "/2087320237446795264/artifacts/e2e-ocp-helm"
    "/redhat-developer-rhdh-plugin-export-overlays-ocp-helm"
)

PASSING_COMMENT = f"""### ✅ Passed E2E Tests - `extensions`
**Platform:** ocp 4.20 | **RHDH Version:** 1.11 | **Duration:** 5m 36s
Passed: 11 | Failed: 0 | Flaky: 0 | Skipped: 3
[Playwright Report]({ARTIFACTS}/artifacts/playwright-report/index.html) | \
[Build Log]({ARTIFACTS}/build-log.txt) | \
[Logs]({ARTIFACTS}/artifacts/e2e-test-results/logs/) | \
[Artifacts]({ARTIFACTS}/artifacts)"""

EXPECTED_COVERAGE_URL = f"{ARTIFACTS}/artifacts/e2e-test-results/coverage/"


def parse(body):
    """Run the module's parser over `body` and return its result as a dict."""
    script = f"""
        const m = require({str(MODULE)!r});
        process.stdout.write(JSON.stringify(m.parsePassedE2eComment({json.dumps(body)})));
    """
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(SCRIPTS_DIR.parent),
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_a_real_passing_comment_yields_its_coverage_listing():
    """The whole point: the build-log link becomes the coverage listing beside
    it. This exact URL is the one the extensions publish ran against."""
    assert parse(PASSING_COMMENT) == {
        "workspace": "extensions",
        "coverageUrl": EXPECTED_COVERAGE_URL,
        "reason": None,
    }


def test_a_failed_run_is_not_a_publish_target():
    """A failed run still writes coverage JSONs, and they measure the tests that
    died. bulk-import's blocked run collected 22% that way — publishing it would
    have made that the plugin's number upstream."""
    body = PASSING_COMMENT.replace(
        "✅ Passed E2E Tests - `extensions`", "❌ Failed E2E Tests - `bulk-import`"
    )
    assert parse(body)["reason"] == "not-a-pass"


def test_an_unrelated_comment_is_not_a_publish_target():
    assert parse("/retest")["reason"] == "not-a-pass"


def test_a_lookalike_host_is_refused():
    """The comment body is data. Were the host pattern loose after
    `gcsweb-ci.apps.`, a crafted link would decide which artifacts get published
    under a Red Hat flag."""
    body = PASSING_COMMENT.replace(
        "gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com",
        "gcsweb-ci.apps.attacker.example.com",
    )
    assert parse(body)["reason"] == "no-build-log"


def test_a_url_in_prose_is_not_the_artifact_link():
    """Anchored inside the markdown link's parens for the same reason
    refresh-stale-coverage-snapshots.yaml anchors its copy: a URL someone typed
    into a sentence is not the run's artifact link."""
    body = (
        "### ✅ Passed E2E Tests - `extensions`\n"
        f"see {ARTIFACTS}/build-log.txt for details"
    )
    assert parse(body)["reason"] == "no-build-log"


@pytest.mark.parametrize("name", ["../../etc", "a b", "/abs", "UPPER", "-lead"])
def test_a_workspace_name_that_cannot_be_a_directory_is_refused(name):
    """The name is interpolated into a path downstream, so it is constrained
    here rather than trusted."""
    body = PASSING_COMMENT.replace("`extensions`", f"`{name}`")
    assert parse(body)["reason"] == "bad-workspace"


@pytest.mark.parametrize("name", ["bulk-import", "app-defaults", "theme", "acr"])
def test_the_workspace_names_actually_in_use_are_accepted(name):
    """The guard above is only worth having if it lets real names through —
    every hyphenated workspace in this repo would fail a stricter pattern."""
    body = PASSING_COMMENT.replace("`extensions`", f"`{name}`")
    assert parse(body)["workspace"] == name


def test_a_passing_comment_without_a_build_log_is_distinguished():
    """Reported separately from "not a pass" because it means the bot's format
    drifted and this parser needs updating — a publish silently going quiet is
    exactly the failure this module exists to make visible."""
    assert parse("### ✅ Passed E2E Tests - `extensions`")["reason"] == "no-build-log"


def test_a_non_string_body_is_refused_rather_than_crashing():
    """The GitHub API omits `body` on some comment payloads, and a parser that
    throws there takes down the publish for every workspace in the push."""
    script = f"""
        const m = require({str(MODULE)!r});
        process.stdout.write(JSON.stringify(m.parsePassedE2eComment(undefined)));
    """
    result = subprocess.run(
        ["node", "-e", script], capture_output=True, text=True, timeout=60,
        cwd=str(SCRIPTS_DIR.parent),
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["reason"] == "not-a-pass"


def test_the_bot_login_has_one_definition():
    """The author pin is what makes the body trustworthy at all. The workflow
    imports this rather than restating it, so the two cannot drift apart."""
    script = f"""
        const m = require({str(MODULE)!r});
        process.stdout.write(JSON.stringify(m.E2E_BOT_LOGIN));
    """
    result = subprocess.run(
        ["node", "-e", script], capture_output=True, text=True, timeout=60,
        cwd=str(SCRIPTS_DIR.parent),
    )
    assert json.loads(result.stdout) == "rhdh-test-bot"
