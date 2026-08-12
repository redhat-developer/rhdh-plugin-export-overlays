"""Tests for scripts/resolve-publish-targets.cjs — what a publish run will publish.

This is the step that turns "someone merged something" into "upload this
workspace's coverage to a shared Codecov project". Every way it can be wrong is
quiet: resolving nothing looks identical to a merge that had no coverage,
resolving the wrong comment publishes another run's numbers under a Red Hat
flag, and both report success.

It went untested once already and it cost something concrete. The first version
read the dispatch inputs with `core.getInput`, which returns the *step's* own
inputs — `github-script` declares only `script`, so every manual publish ran
`upload-coverage-upstream.sh` with two empty strings. Nothing but a human
reading the diff caught it, which is what these stubs exist to change.

`github`, `context` and `core` are the objects actions/github-script injects, so
the module takes them as an argument and a test can hand it fakes: an octokit
whose two calls return canned data, and a `core` that records what it was told.
Same idea as the `gh` shim in test_generate_coverage_anchors.py, in the language
the module happens to be written in.
"""

import json
import shutil
import subprocess

import pytest

from tests.shell_harness import SCRIPTS_DIR

MODULE = SCRIPTS_DIR / "resolve-publish-targets.cjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not available"
)

BOT = "rhdh-test-bot"
ARTIFACTS = (
    "https://gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com/gcs/test-platform-results"
    "/pr-logs/pull/redhat-developer_rhdh-plugin-export-overlays/3241/job/1"
)


def passing_comment(workspace, artifacts=ARTIFACTS):
    """The bot's comment, trimmed to the two lines this module reads."""
    return (
        f"### ✅ Passed E2E Tests - `{workspace}`\n"
        f"[Build Log]({artifacts}/build-log.txt)"
    )


def coverage_url(artifacts=ARTIFACTS):
    return f"{artifacts}/artifacts/e2e-test-results/coverage/"


def resolve(*, event="push", inputs=None, prs=(), comments=()):
    """Drive the module against stubbed github/context/core.

    Returns `{targets, warnings, infos}` — the warnings matter as much as the
    targets here, since a refusal nobody is told about is the failure this
    module is meant to make visible.
    """
    fixture = {
        "event": event,
        "inputs": inputs or {},
        "prs": list(prs),
        "comments": list(comments),
    }
    script = f"""
        const {{ resolvePublishTargets }} = require({str(MODULE)!r});
        const fixture = {json.dumps(fixture)};
        const warnings = [];
        const infos = [];
        const core = {{
          warning: (m) => warnings.push(m),
          info: (m) => infos.push(m),
          setOutput: () => {{}},
        }};
        const github = {{
          rest: {{
            repos: {{
              listPullRequestsAssociatedWithCommit: async () => ({{ data: fixture.prs }}),
            }},
            issues: {{ listComments: 'listComments' }},
          }},
          // The real paginate takes the method and its params; the fixture is
          // flat because no test here needs per-PR comment lists.
          paginate: async () => fixture.comments,
        }};
        const context = {{
          eventName: fixture.event,
          sha: 'deadbeef',
          repo: {{ owner: 'o', repo: 'r' }},
          payload: {{ inputs: fixture.inputs }},
        }};
        resolvePublishTargets({{ github, context, core }}).then((targets) => {{
          process.stdout.write(JSON.stringify({{ targets, warnings, infos }}));
        }});
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


def test_a_dispatch_passes_its_inputs_through():
    """The regression that shipped. `core.getInput` returned '' for both fields,
    so the publish ran with no arguments and died on its usage guard."""
    out = resolve(
        event="workflow_dispatch",
        inputs={"workspace": "extensions", "coverage-url": coverage_url()},
    )
    assert out["targets"] == [
        {"workspace": "extensions", "coverageUrl": coverage_url()}
    ]


def test_a_dispatch_does_not_consult_the_pull_requests():
    """A backfill names the run it wants. Reading comments as well would let a
    PR's newer coverage silently override the one an operator asked for."""
    out = resolve(
        event="workflow_dispatch",
        inputs={"workspace": "theme", "coverage-url": coverage_url()},
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": passing_comment("extensions")}],
    )
    assert [t["workspace"] for t in out["targets"]] == ["theme"]


def test_a_merged_prs_passing_comment_becomes_a_target():
    out = resolve(
        prs=[{"number": 3241, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": passing_comment("extensions")}],
    )
    assert out["targets"] == [
        {"workspace": "extensions", "coverageUrl": coverage_url()}
    ]


def test_a_commit_with_no_merged_pr_publishes_nothing():
    """A direct push to main, or a commit that only appears in an open PR."""
    out = resolve(prs=[{"number": 9, "merged_at": None}])
    assert out["targets"] == []
    assert any("No merged PR" in m for m in out["infos"])


def test_an_unmerged_pr_is_not_a_source_of_coverage():
    """Coverage from a PR that was never accepted describes code that does not
    exist on main."""
    out = resolve(
        prs=[{"number": 9, "merged_at": None}],
        comments=[{"user": {"login": BOT}, "body": passing_comment("extensions")}],
    )
    assert out["targets"] == []


def test_a_comment_from_anyone_but_the_bot_is_ignored():
    """The author pin is what makes the body trustworthy enough to take a URL
    from — without it, anyone able to comment picks the artifacts."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[
            {"user": {"login": "someone-else"}, "body": passing_comment("extensions")}
        ],
    )
    assert out["targets"] == []


def test_the_last_passing_comment_for_a_workspace_wins():
    """One e2e invocation posts one comment per RHDH version. They measure the
    same image, so the choice is only about being deterministic."""
    later = f"{ARTIFACTS}-later"
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[
            {"user": {"login": BOT}, "body": passing_comment("extensions")},
            {"user": {"login": BOT}, "body": passing_comment("extensions", later)},
        ],
    )
    assert out["targets"] == [
        {"workspace": "extensions", "coverageUrl": coverage_url(later)}
    ]


def test_a_failed_run_produces_no_target_and_no_noise():
    """Most of the bot's comments on a PR are failures or reruns. Warning on
    each would bury the two refusals that mean the format has drifted."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[
            {
                "user": {"login": BOT},
                "body": "### ❌ Failed E2E Tests - `bulk-import`",
            }
        ],
    )
    assert out["targets"] == []
    assert out["warnings"] == []


@pytest.mark.parametrize(
    "body,reason",
    [
        ("### ✅ Passed E2E Tests - `extensions`", "no-build-log"),
        (f"{passing_comment('extensions')}\n\n{passing_comment('theme')}", "multi-section"),
        (passing_comment("../etc"), "bad-workspace"),
    ],
)
def test_a_comment_that_cannot_be_read_is_warned_about(body, reason):
    """These three mean something changed — the bot's format, or what it names.
    Silence here is how a publish stops happening and nobody finds out."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": body}],
    )
    assert out["targets"] == []
    assert len(out["warnings"]) == 1
    assert reason in out["warnings"][0]


def test_nothing_to_publish_is_reported_rather_than_left_silent():
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": "/retest"}],
    )
    assert out["targets"] == []
    assert any("nothing to publish" in m for m in out["infos"])


def test_what_will_be_published_is_named_in_the_log():
    """An unattended job that publishes to a shared project should say what it
    published, so the Codecov side can be traced back to a run."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": passing_comment("extensions")}],
    )
    assert any("Publishing: extensions" in m for m in out["infos"])


def test_a_later_failure_retracts_an_earlier_pass():
    """e2e here is on-demand, not per-push, so a PR can carry a green comment
    from an early commit and a red one from a re-run. Publishing the green one
    would put a superseded run's numbers on a shared upstream project as the
    plugin's record — a wrong report, not a missing one."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[
            {"user": {"login": BOT}, "body": passing_comment("extensions")},
            {
                "user": {"login": BOT},
                "body": "### ❌ Failed E2E Tests - `extensions`",
            },
        ],
    )
    assert out["targets"] == []
    assert any("superseded" in m for m in out["warnings"])


def test_a_failure_retracts_only_its_own_workspace():
    """A red run for one workspace says nothing about another's."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[
            {"user": {"login": BOT}, "body": passing_comment("extensions")},
            {"user": {"login": BOT}, "body": passing_comment("theme")},
            {
                "user": {"login": BOT},
                "body": "### ❌ Failed E2E Tests - `extensions`",
            },
        ],
    )
    assert [t["workspace"] for t in out["targets"]] == ["theme"]


def test_a_pass_after_a_failure_still_publishes():
    """The retraction is ordered, not absolute — a re-run that goes green after
    a red one is the run that describes the merged code."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[
            {
                "user": {"login": BOT},
                "body": "### ❌ Failed E2E Tests - `extensions`",
            },
            {"user": {"login": BOT}, "body": passing_comment("extensions")},
        ],
    )
    assert [t["workspace"] for t in out["targets"]] == ["extensions"]
