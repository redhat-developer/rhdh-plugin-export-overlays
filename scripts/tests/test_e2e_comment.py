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
        "rejected": None,
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
    assert parse(body) == {
        "workspace": None,
        "coverageUrl": None,
        "reason": "multi-section",
        "rejected": None,
    }


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
    under a Red Hat flag. refresh-coverage-snapshot.yaml used to carry a looser
    form; it now calls this module, so this is the one place the rule lives."""
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
    assert payload == {
        "workspace": None,
        "coverageUrl": None,
        "reason": "not-a-pass",
        "rejected": None,
    }


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


def test_a_rejected_workspace_name_is_reported_back():
    """A refusal nobody can trace is a refusal nobody acts on. The name is
    exposed under its own key so a caller can log it without being able to
    mistake it for one that passed the guard."""
    body = PASSING_COMMENT.replace("`extensions`", "`../etc`")
    result = parse(body)
    assert result["reason"] == "bad-workspace"
    assert result["rejected"] == "../etc"
    assert result["workspace"] is None


@pytest.mark.parametrize("name", ["trailing-", "a" * 51])
def test_a_name_the_strictest_caller_refuses_is_refused_here(name):
    """The guard is the strictest of the shapes that used to exist for this one
    rule, not the most convenient. refresh-coverage-snapshot.yaml capped the
    length and rejected a trailing hyphen; consolidating on the looser shape
    would have widened what that workflow accepts, which is the wrong direction
    for the only thing standing between a comment body and a path."""
    body = PASSING_COMMENT.replace("`extensions`", f"`{name}`")
    assert parse(body)["reason"] == "bad-workspace"


def test_the_longest_real_workspace_name_still_fits():
    """A cap is only safe if it clears the names actually in use — the longest
    in this repo is 36 characters."""
    name = "scaffolder-backend-module-servicenow"
    body = PASSING_COMMENT.replace("`extensions`", f"`{name}`")
    assert parse(body)["workspace"] == name


class TestAgreementWithTheWorkflowGate:
    """refresh-coverage-snapshot.yaml decides at the JOB level whether to run at
    all, and a `if:` expression cannot call into a module — so the bot's login
    is spelled out there as a literal while this module owns it everywhere else.

    Nothing but this test stops the two from drifting, and drift is silent in
    the worse direction: a workflow pinned to a login the bot no longer uses
    stops firing, and a green run says nothing happened because nothing needed
    to.
    """

    WORKFLOW = (
        SCRIPTS_DIR.parent / ".github/workflows/refresh-coverage-snapshot.yaml"
    )

    def test_the_job_gate_pins_the_same_login_the_module_owns(self):
        payload, _ = run_node(
            f"""
            const m = require({str(MODULE)!r});
            process.stdout.write(JSON.stringify(m.E2E_BOT_LOGIN));
            """
        )
        gate = [
            line
            for line in self.WORKFLOW.read_text().splitlines()
            if "github.event.comment.user.login" in line
        ]
        assert gate, "the job-level author gate is gone"
        assert f"'{payload}'" in gate[0], (
            f"the workflow gate does not pin {payload!r}; "
            "it and scripts/e2e-comment.cjs have drifted"
        )


class TestAgreementWithTheShellCopy:
    """refresh-stale-coverage-snapshots.yaml still derives the coverage URL in
    shell, because it runs over many merged PRs in bash rather than in a
    github-script step.

    The repo has been here before: TestCrossLanguageAgreement in
    test_print_plugin_remotes.py exists because two derivations of one rule
    drifted and cost app-defaults a week of coverage. This pins the pair instead
    of trusting a comment that says to change them together.
    """

    WORKFLOW = SCRIPTS_DIR.parent / ".github/workflows/refresh-stale-coverage-snapshots.yaml"

    def shell_derivation(self, body):
        """Run the workflow's own grep + suffix rewrite over a comment body."""
        pattern = None
        for line in self.WORKFLOW.read_text().splitlines():
            if "grep -oE" in line and "build-log" in line:
                pattern = line.split("grep -oE", 1)[1].strip().split("<<<")[0].strip()
                break
        assert pattern, "the shell copy's build-log grep was not found"
        script = (
            f"log_url=$(grep -oE {pattern} <<<\"$BODY\" | head -1 | tr -d '()')\n"
            'printf "%s" "${log_url%build-log.txt}artifacts/e2e-test-results/coverage/"\n'
        )
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
            timeout=60,
            env={"BODY": body, "PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
        assert result.returncode == 0, result.stderr
        return result.stdout

    def test_both_derive_the_same_coverage_url(self):
        assert self.shell_derivation(PASSING_COMMENT) == EXPECTED_COVERAGE_URL

    def test_both_refuse_a_lookalike_host(self):
        body = PASSING_COMMENT.replace(
            "gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com",
            "gcsweb-ci.apps.attacker.example.com",
        )
        assert parse(body)["reason"] == "no-build-log"
        # The shell copy yields only the rewritten suffix when nothing matched,
        # which is what its own caller checks for.
        assert self.shell_derivation(body) == "artifacts/e2e-test-results/coverage/"
