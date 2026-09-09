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


# The head commit's timestamp and the comment's are what the staleness gate
# compares. Defaults put every comment AFTER the merged commit, which is the
# ordinary case: a run that measured the tree being merged.
HEAD_COMMITTED_AT = "2026-08-11T10:00:00Z"
AFTER_HEAD = "2026-08-11T11:00:00Z"
BEFORE_HEAD = "2026-08-11T09:00:00Z"


def resolve(
    *,
    event="push",
    inputs=None,
    prs=(),
    comments=(),
    head_committed_at=HEAD_COMMITTED_AT,
):
    """Drive the module against stubbed github/context/core.

    Returns `{targets, warnings, infos}` — the warnings matter as much as the
    targets here, since a refusal nobody is told about is the failure this
    module is meant to make visible.
    """
    fixture = {
        "event": event,
        "inputs": inputs or {},
        "prs": [{"head": {"sha": "headsha"}, **pr} for pr in prs],
        # A flat list is served to every PR; a dict keyed by PR number serves
        # each its own, which is what distinguishes "this PR's run failed" from
        # "some other merged PR's run failed".
        "comments": (
            {
                str(n): [{"created_at": AFTER_HEAD, **c} for c in cs]
                for n, cs in comments.items()
            }
            if isinstance(comments, dict)
            else [{"created_at": AFTER_HEAD, **c} for c in comments]
        ),
        "headCommittedAt": head_committed_at,
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
              getCommit: async () => {{
                if (!fixture.headCommittedAt) throw new Error("no such commit");
                return {{ data: {{ commit: {{ committer: {{ date: fixture.headCommittedAt }} }} }} }};
              }},
            }},
            issues: {{ listComments: 'listComments' }},
          }},
          // The real paginate takes the method and its params; the fixture is
          // flat because no test here needs per-PR comment lists.
          paginate: async (_m, params) =>
            Array.isArray(fixture.comments)
              ? fixture.comments
              : (fixture.comments[String(params.issue_number)] ?? []),
        }};
        const context = {{
          eventName: fixture.event,
          sha: 'deadbeef',
          repo: {{ owner: 'o', repo: 'r' }},
          payload: {{ inputs: fixture.inputs }},
        }};
        resolvePublishTargets({{ github, context, core }}).then((targets) => {{
          process.stdout.write(JSON.stringify({{ targets, warnings, infos, error: null }}));
        }}, (e) => {{
          process.stdout.write(JSON.stringify({{ targets: [], warnings, infos, error: String(e.message) }}));
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


def test_a_dispatch_workspace_is_held_to_the_same_shape():
    """The name reaches a `::group::` line in the workflow before the script
    that validates it ever runs. Dispatching needs write access, so this is not
    the main defence — but a guard that applies to the comment path and not the
    dispatch path is not a guard."""
    out = resolve(
        event="workflow_dispatch",
        inputs={"workspace": "../etc", "coverage-url": coverage_url()},
    )
    assert out["error"] is not None
    assert "not a usable workspace name" in out["error"]


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


def test_bot_comments_that_no_longer_parse_raise_a_drift_alarm():
    """The failure this whole workflow exists to remove, one level up.

    If the bot's header wording changes, every comment falls through as the
    ordinary `not-a-pass`, nothing resolves, and the run is green — publishing
    would stop for good while CI kept reporting success. The bot having spoken
    and nothing having been understood is what makes that visible.
    """
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[
            {"user": {"login": BOT}, "body": "### ✅ E2E Tests Passed - `extensions`"},
            {"user": {"login": BOT}, "body": "### ✅ E2E Tests Passed - `theme`"},
        ],
    )
    assert out["targets"] == []
    assert any("format has probably changed" in m for m in out["warnings"])


def test_no_drift_alarm_when_the_bot_was_understood():
    """The alarm is only worth having if an ordinary run stays quiet."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": passing_comment("extensions")}],
    )
    assert not any("format has probably changed" in m for m in out["warnings"])


def test_no_drift_alarm_when_the_bot_said_nothing():
    """A PR that never ran e2e is not drift."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[{"user": {"login": "someone"}, "body": "looks good"}],
    )
    assert out["warnings"] == []


def test_a_rejected_workspace_is_named_in_the_warning():
    """An unattended job telling you it skipped something, without saying what,
    sends whoever reads it back to the PR to guess."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T00:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": passing_comment("../etc")}],
    )
    assert out["targets"] == []
    assert "../etc" in out["warnings"][0]


def test_a_run_that_predates_the_merged_commit_is_not_published():
    """The finding that survived two rounds of being deferred.

    e2e here is on-demand, not per-push: green run on commit A, another commit
    bumping the workspace's repo-ref, merge with no re-run. The coverage
    measured against A would then be uploaded with the repo-ref read from the
    MERGED tree and remapped onto it — per-line hit counts on source lines that
    build never executed, on a flag whose default-branch copy cannot be taken
    back.
    """
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T12:00:00Z"}],
        comments=[
            {
                "user": {"login": BOT},
                "body": passing_comment("extensions"),
                "created_at": BEFORE_HEAD,
            }
        ],
    )
    assert out["targets"] == []
    assert any("measured a different tree" in m for m in out["warnings"])


def test_a_run_after_the_merged_commit_still_publishes():
    """The gate is only safe if the ordinary case survives it — otherwise it
    trades a wrong report for no report at all."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T12:00:00Z"}],
        comments=[
            {
                "user": {"login": BOT},
                "body": passing_comment("extensions"),
                "created_at": AFTER_HEAD,
            }
        ],
    )
    assert [t["workspace"] for t in out["targets"]] == ["extensions"]


def test_an_unreadable_head_commit_publishes_and_says_the_check_is_off():
    """Skipping every workspace because one API call failed would be a worse
    answer than publishing with the missing check announced."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T12:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": passing_comment("extensions")}],
        head_committed_at=None,
    )
    assert [t["workspace"] for t in out["targets"]] == ["extensions"]
    assert any("cannot be told from a current one" in m for m in out["warnings"])


def test_one_prs_failure_does_not_retract_another_prs_pass():
    """`targets` spans every merged PR associated with the pushed commit. A
    global delete let a red run on one PR silently stop an unrelated workspace
    from publishing."""
    out = resolve(
        prs=[
            {"number": 1, "merged_at": "2026-08-11T12:00:00Z"},
            {"number": 2, "merged_at": "2026-08-11T12:00:00Z"},
        ],
        comments={
            1: [{"user": {"login": BOT}, "body": passing_comment("extensions")}],
            2: [
                {
                    "user": {"login": BOT},
                    "body": "### ❌ Failed E2E Tests - `extensions`",
                }
            ],
        },
    )
    assert [t["workspace"] for t in out["targets"]] == ["extensions"]


def test_an_unreadable_failure_report_is_flagged_rather_than_ignored():
    """A refusal means the opposite thing on each side. On the passing side it
    means "do not publish"; on the failing side it means "do not retract", so a
    failure report this cannot parse leaves an earlier pass standing and
    publishes a run that is known to be red."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T12:00:00Z"}],
        comments=[
            {"user": {"login": BOT}, "body": passing_comment("extensions")},
            {"user": {"login": BOT}, "body": "### ❌ Failed E2E Tests - `NOT A SLUG`"},
        ],
    )
    assert any("cannot retract anything" in m for m in out["warnings"])


def test_drift_is_seen_even_when_failure_comments_still_parse():
    """The hole the first version of this alarm had.

    If the bot rewords only the PASSING header, its failure comments keep
    parsing. Counting those as "understood" kept the alarm silent while no
    passing run could be read any more — publishing would have stopped forever
    and every run stayed green.
    """
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T12:00:00Z"}],
        comments=[
            {"user": {"login": BOT}, "body": "### ✅ E2E Tests Passed - `extensions`"},
            {"user": {"login": BOT}, "body": "### ❌ Failed E2E Tests - `theme`"},
        ],
    )
    assert out["targets"] == []
    assert any("matched no e2e result" in m for m in out["warnings"])


def test_a_pr_whose_e2e_only_failed_is_not_reported_as_drift():
    """Red is not drift. Its comments parse; they just say no. Alarming here
    would fire on every genuinely-failing PR and teach everyone to ignore it."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T12:00:00Z"}],
        comments=[
            {"user": {"login": BOT}, "body": "### ❌ Failed E2E Tests - `bulk-import`"}
        ],
    )
    assert not any("matched no e2e result" in m for m in out["warnings"])


def test_a_stale_run_counts_as_the_parser_still_working():
    """A skipped stale run proves the shape was read. Treating it as
    unrecognised would raise drift on an ordinary re-bumped PR."""
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T12:00:00Z"}],
        comments=[
            {
                "user": {"login": BOT},
                "body": passing_comment("extensions"),
                "created_at": BEFORE_HEAD,
            }
        ],
    )
    assert not any("matched no e2e result" in m for m in out["warnings"])


@pytest.mark.parametrize(
    "url",
    [
        "https://gcsweb-ci.apps.attacker.example.com/gcs/x/artifacts/e2e-test-results/coverage/",
        "https://gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com/gcs/x/artifacts/playwright-report/",
        "http://gcsweb-ci.apps.ci.l2s4.p1.openshiftapps.com/gcs/x/artifacts/e2e-test-results/coverage/",
        "",
    ],
)
def test_a_dispatch_coverage_url_is_held_to_the_pinned_host(url):
    """The push path pins the host by construction — it swaps the tail of a link
    the parser already validated. The dispatched URL is typed in, and was the
    only one nothing checked."""
    out = resolve(
        event="workflow_dispatch",
        inputs={"workspace": "extensions", "coverage-url": url},
    )
    assert out["error"] is not None
    assert "coverage listing URL" in out["error"]


def test_the_url_the_push_path_derives_is_accepted_by_the_dispatch_guard():
    """The two paths feed one uploader, so a guard that rejected what the other
    produces would be wrong rather than strict."""
    out = resolve(
        event="workflow_dispatch",
        inputs={"workspace": "extensions", "coverage-url": coverage_url()},
    )
    assert out["error"] is None
    assert out["targets"][0]["coverageUrl"] == coverage_url()


def test_a_passing_comment_that_mentions_a_failure_in_prose_still_publishes():
    """The failure marker is anchored to the first line, like the passing one.

    As a bare phrase it also matched a PASSING comment that merely referred to
    an earlier red run, and refused to publish a result that had parsed
    perfectly one line above — a false negative with nothing to gain.
    """
    body = (
        f"{passing_comment('extensions')}\n"
        "Retried after a Failed E2E Tests run earlier."
    )
    out = resolve(
        prs=[{"number": 1, "merged_at": "2026-08-11T12:00:00Z"}],
        comments=[{"user": {"login": BOT}, "body": body}],
    )
    assert [t["workspace"] for t in out["targets"]] == ["extensions"]
    assert not any("cannot retract anything" in m for m in out["warnings"])
