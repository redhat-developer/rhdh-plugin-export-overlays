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
the same reason test_upstream_paths.py does it that way, and the `run_node`
helper here is deliberately the same shape as that file's.
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


def run_node(script: str):
    """Evaluate `script` with the module in scope; it prints JSON on stdout.

    cwd is the repo root rather than the tests directory so a relative require
    in the module would resolve the way it does in CI, not against the fixture.
    """
    result = subprocess.run(
        ["node", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(SCRIPTS_DIR.parent),
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout), result.stderr


def parse(body):
    """Run the parser over a string body and return its result."""
    payload, _ = run_node(
        f"""
        const m = require({str(MODULE)!r});
        process.stdout.write(JSON.stringify(m.parsePassedE2eComment({json.dumps(body)})));
        """
    )
    return payload


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


def test_a_failed_run_quoting_a_passing_header_publishes_nothing():
    """The defect this guard exists for, and it defeated every other guard here.

    The header and the link are matched independently over the whole body, so a
    body whose first section FAILED and which quotes a passing header lower down
    used to return the quoted section's workspace paired with the FAILED run's
    artifacts — a red run publishing under another workspace's name, reported as
    success.
    """
    body = "\n".join(
        [
            "### ❌ Failed E2E Tests - `bulk-import`",
            f"[Build Log]({ARTIFACTS}/build-log.txt)",
            "",
            "> ### ✅ Passed E2E Tests - `extensions`",
        ]
    )
    assert parse(body) == {"workspace": None, "coverageUrl": None, "reason": "multi-section"}


def test_a_comment_carrying_two_passing_runs_is_refused_rather_than_paired():
    """Two results in one body cannot be split by position, so the parser
    refuses instead of guessing which link belongs to which header. One comment
    per result is today's shape; this is what notices if that changes."""
    body = f"{PASSING_COMMENT}\n\n{PASSING_COMMENT.replace('`extensions`', '`theme`')}"
    assert parse(body)["reason"] == "multi-section"


def test_the_header_must_be_the_comments_first_line():
    """Anchoring is what keeps a quoted or appended header from being read as
    the comment's own result."""
    body = f"some preamble\n{PASSING_COMMENT}"
    assert parse(body)["reason"] == "not-a-pass"


def test_an_unrelated_comment_is_not_a_publish_target():
    assert parse("/retest")["reason"] == "not-a-pass"


def test_a_lookalike_host_is_refused():
    """The comment body is data. Were the host pattern loose after
    `gcsweb-ci.apps.`, a crafted link would decide which artifacts get published
    under a Red Hat flag. refresh-coverage-snapshot.yaml still carries the loose
    form, which is why this is pinned here."""
    body = PASSING_COMMENT.replace(
        "gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com",
        "gcsweb-ci.apps.attacker.example.com",
    )
    assert parse(body)["reason"] == "no-build-log"


def test_a_host_smuggled_through_userinfo_is_refused():
    """`...openshiftapps.com@evil.example.com` is a URL whose real host is the
    part after the `@`, and it reads as legitimate at a glance."""
    body = PASSING_COMMENT.replace(
        "gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com",
        "gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com@evil.example.com",
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


@pytest.mark.parametrize(
    "name", ["../../etc", "a b", "/abs", "UPPER", "-lead", "with.dot", "with_underscore"]
)
def test_a_workspace_name_that_cannot_be_a_directory_is_refused(name):
    """The name is interpolated into a path downstream, so it is constrained
    here rather than trusted. `.` and `_` are refused because
    upload-coverage-upstream.sh refuses them, and one rule with two shapes is
    how the looser of the two eventually gets relied on."""
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


def test_a_non_string_that_stringifies_into_a_comment_is_refused():
    """What the `typeof` guard actually buys.

    `RegExp.exec` coerces its argument, so an object whose string form parses
    would be accepted as a comment without it. Asserting on `undefined` instead
    would prove nothing — that misses the header on its own, guard or no guard.
    """
    payload, _ = run_node(
        f"""
        const m = require({str(MODULE)!r});
        const shaped = {{ toString: () => {json.dumps(PASSING_COMMENT)} }};
        process.stdout.write(JSON.stringify(m.parsePassedE2eComment(shaped)));
        """
    )
    assert payload == {"workspace": None, "coverageUrl": None, "reason": "not-a-pass"}


def test_the_parser_writes_nothing_to_the_console():
    """The module's stated contract — callers decide how to report a refusal.
    A stray log here would land in the workflow's output as an unexplained line
    with no PR or workspace attached to it."""
    _, stderr = run_node(
        f"""
        const m = require({str(MODULE)!r});
        m.parsePassedE2eComment("/retest");
        m.parsePassedE2eComment({json.dumps(PASSING_COMMENT)});
        process.stdout.write("null");
        """
    )
    assert stderr == ""


def test_the_bot_login_has_one_definition():
    """The author pin is what makes the body trustworthy at all. The workflow
    imports this rather than restating it, so the two cannot drift apart."""
    payload, _ = run_node(
        f"""
        const m = require({str(MODULE)!r});
        process.stdout.write(JSON.stringify(m.E2E_BOT_LOGIN));
        """
    )
    assert payload == "rhdh-test-bot"
