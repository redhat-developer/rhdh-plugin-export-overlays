"""Tests for scripts/upload-coverage-upstream.sh.

The contract under test is what reaches the Codecov CLI: which slug, which SHAs,
which branch, which flag, which session name, and from which working directory.
Those are exactly the things that are silently wrong in a cross-repo upload — an
upload with a bad slug, a bad branch or a bad CWD is still accepted by the API
and simply never displays.

Every run is hermetic, and stays that way only while BOTH checkout seams are
set: UPSTREAM_CHECKOUT_DIR stands in for the pinned shallow clone,
UPSTREAM_HEAD_CHECKOUT_DIR for the default-branch one. Setting only the first
leaves the HEAD copy fetching from github.com, which is how this suite briefly
became flaky rather than failing honestly.

REMAP_BIN stands in for the remap, so nothing reaches GitHub, Codecov or npm.
The one exception is documented on the test that needs it.
"""

import contextlib
import hashlib
import http.server
import itertools
import json
import os
import re
import threading
from pathlib import Path

import pytest

from tests.shell_harness import (
    SCRIPTS_DIR,
    call_count,
    git,
    link_script,
    run_script,
    write_stub_cli,
)

PINNED_REF = "a" * 40
WORKSPACE = "intelligent-assistant"
UPSTREAM_SLUG = "redhat-developer/rhdh-plugins"

# Symlinked into the fixture so the script finds its own helpers next to it.
LINKED_SCRIPTS = (
    "upload-coverage-upstream.sh",
    "download-coverage-json.sh",
    "remap-lcov.sh",
    "remap-coverage.cjs",
    "upstream-paths.cjs",
    "ensure-codecov-cli.sh",
)


def build_overlay(
    tmp_path: Path,
    repo_url=f"https://github.com/{UPSTREAM_SLUG}",
    workspace=WORKSPACE,
):
    """An overlay checkout with one workspace and its source.json.

    The script derives its repo root from its own location, so linking it into
    <root>/scripts/ relocates every path it reads.

    `workspace` is parameterised for the flag-override tests: the flag a
    workspace publishes under is normally derived from its name, and the
    exceptions can only be exercised by naming the workspace they apply to.
    """
    root = tmp_path / "overlay"
    for name in LINKED_SCRIPTS:
        link_script(root, name)

    ws = root / "workspaces" / workspace
    ws.mkdir(parents=True)
    (ws / "source.json").write_text(
        json.dumps({"repo": repo_url, "repo-ref": PINNED_REF})
    )
    return root


def build_upstream_checkout(
    tmp_path: Path, branch="main", head_sha=None, into=None, workspace=WORKSPACE
) -> Path:
    """A stand-in for the shallow clone, with a real git remote behind it.

    `git ls-remote --symref origin HEAD` is how the script learns both the
    default branch name and its tip, so origin points at a local repo: the
    resolution stays real without a network.

    `workspace` seeds the tree under the same name the overlay fixture uses.
    Nothing in the script reads those files today — REMAP_BIN is stubbed — so a
    mismatch is currently harmless, which is exactly why it is worth keeping in
    step: the first check that the workspace exists upstream would otherwise
    turn every override test red for a reason that has nothing to do with flags.
    """
    upstream = tmp_path / "upstream-origin"
    # Both checkouts share one origin — the same repo really does serve both the
    # pinned ref and the branch tip.
    if not upstream.exists():
        upstream.mkdir()
        git(upstream, "init", "-q", "-b", branch, ".")
        src = upstream / "workspaces" / workspace / "plugins" / "ia" / "src"
        src.mkdir(parents=True)
        (src / "Chat.tsx").write_text("export const a = 1;\n")
        git(upstream, "add", "-A")
        git(upstream, "commit", "-q", "-m", "seed")

    checkout = into or (tmp_path / "checkout")
    checkout.mkdir(parents=True, exist_ok=True)
    git(checkout, "init", "-q", ".")
    git(checkout, "remote", "add", "origin", str(upstream))
    return checkout


def session_names(stub: Path):
    """The --name each upload was given, in call order."""
    return [
        line.split("--name ", 1)[1].split()[0]
        for line in recorded(stub, ".calls").splitlines()
        if "--name " in line
    ]


def head_checkout_of(tmp_path: Path) -> Path:
    """Where run_upstream puts the default-branch checkout."""
    return tmp_path / "checkout-head"


def upstream_head(checkout: Path) -> str:
    """The SHA `ls-remote` will report for the checkout's origin."""
    result = git(checkout, "ls-remote", "origin", "HEAD")
    return result.stdout.split()[0]


def write_stub_remap(path: Path) -> Path:
    """A remap that records its arguments and writes a well-formed lcov.

    The real remap-lcov.sh npm-installs four istanbul packages per run. That
    belongs in a test of the remap itself; these tests are about what the upload
    does with whatever the remap produced — and about the arguments it hands
    over, which is why they are recorded.
    """
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f'echo "$*" >> "{path}.args"\n'
        'mkdir -p "$2"\n'
        # How many files this remap "resolved". Keyed by --upstream-root so a
        # test can make the HEAD tree resolve fewer than the pinned one, which
        # is the whole point of remapping twice — with one fixed body for both,
        # the drop the script reports could never happen and its warning could
        # never be exercised.
        'files=2\n'
        # Keyed on the VALUE of --upstream-root, which this file owns. Keying
        # on the output dir would couple the fixture to the script's private
        # temp-dir name, and matching anywhere in "$*" would fire on any tmp
        # path that happens to contain the word.
        'root=""; prev=""\n'
        'for a in "$@"; do [ "$prev" = "--upstream-root" ] && root="$a"; prev="$a"; done\n'
        'case "$root" in *checkout-head) files="${REMAP_HEAD_FILES:-2}";; esac\n'
        ': > "$2/lcov.info"\n'
        # NOT `seq 1 $files`: BSD seq counts DOWN when first > last, so
        # `seq 1 0` yields "1 0" on macOS and nothing on GNU. A fixture whose
        # zero case means "two files" on one developer's machine and "none" in
        # CI is worse than no fixture.
        # Models the real remap's contract, not a convenient one:
        # remap-coverage.cjs EXITS 1 when nothing resolves, it never writes an
        # empty lcov. A stub that exited 0 with an empty file made a guard the
        # script could not actually reach look tested.
        'if [ "$files" -eq 0 ]; then\n'
        '  echo "[remap] no source files resolved against the upstream checkout" >&2\n'
        '  exit 1\n'
        'fi\n'
        # REMAP_HEAD_SHIFT renames the HEAD tree's files without changing how
        # many there are, which is the churn a count-based comparison misses.
        'shift_by=0\n'
        'case "$root" in *checkout-head) shift_by="${REMAP_HEAD_SHIFT:-0}";; esac\n'
        'i=1\n'
        'while [ "$i" -le "$files" ]; do\n'
        '  n=$((i + shift_by))\n'
        '  printf "TN:\\nSF:workspaces/x/src/a$n.ts\\nDA:1,1\\nend_of_record\\n" >> "$2/lcov.info"\n'
        '  i=$((i + 1))\n'
        'done\n'
    )
    path.chmod(0o755)
    return path


def recorded(stub: Path, suffix: str) -> str:
    sidecar = Path(f"{stub}{suffix}")
    return sidecar.read_text() if sidecar.exists() else ""


@pytest.fixture
def coverage_dir(tmp_path: Path) -> Path:
    """A non-empty coverage directory.

    Only its non-emptiness matters: the remap is stubbed, so nothing parses the
    contents.
    """
    d = tmp_path / "coverage-json"
    d.mkdir()
    (d / "out.json").write_text("{}")
    return d


def run_upstream(
    tmp_path: Path,
    coverage_source,
    *flags,
    exit_codes=(0,),
    branch="main",
    repo_url=f"https://github.com/{UPSTREAM_SLUG}",
    workspace=WORKSPACE,
    env=None,
):
    """Drive the script against stubs, returning (result, stub_cli, checkout).

    Collapses the four-part fixture setup every test needs; the sibling suites
    (test_upload_coverage.py, test_seed_main_coverage.py) use the same shape.
    """
    root = build_overlay(tmp_path, repo_url=repo_url, workspace=workspace)
    checkout = build_upstream_checkout(tmp_path, branch=branch, workspace=workspace)
    # The HEAD copy gets its OWN checkout, because the Codecov CLI sends the file
    # network of the tree it runs in — uploading the pinned tree against the HEAD
    # sha declares files that commit does not have. head_checkout_of() is how a
    # test reaches it without changing this helper's return shape.
    head_checkout = head_checkout_of(tmp_path)
    build_upstream_checkout(
        tmp_path, branch=branch, into=head_checkout, workspace=workspace
    )
    stub = write_stub_cli(tmp_path / "codecov", list(exit_codes))
    remap = write_stub_remap(tmp_path / "remap.sh")

    base = {
        "CODECOV_BIN": str(stub),
        # Verification OFF by default, and off rather than pointed at an empty
        # fixture. An empty one made every default run emit its own
        # `::warning::e2e-`, which silently satisfied
        # test_a_skipped_head_copy_is_raised_as_a_run_annotation from an
        # unrelated code path — the annotation could then be deleted from the
        # HEAD-copy failure and the suite stayed green. Tests that exercise
        # verification turn it on themselves.
        "VERIFY_ATTEMPTS": "0",
        "VERIFY_DELAY_SECONDS": "0",
        # Still set, so a test that raises VERIFY_ATTEMPTS without naming an API
        # cannot reach the network by accident.
        "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
        # Same reasoning for the flag-visibility check. It answers "flag not
        # visible" from this fixture rather than asking Codecov, and the
        # VERIFY_ATTEMPTS=0 default keeps it from running at all.
        "CODECOV_GRAPHQL_API": write_graphql_api(tmp_path, []),
        "UPSTREAM_CHECKOUT_DIR": str(checkout),
        "UPSTREAM_HEAD_CHECKOUT_DIR": str(head_checkout),
        "REMAP_BIN": str(remap),
        "CODECOV_RHDH_PLUGINS_TOKEN": "test-token",
    }
    base.update(env or {})

    result = run_script(
        root / "scripts" / "upload-coverage-upstream.sh",
        workspace,
        str(coverage_source),
        *flags,
        env=base,
        cwd=root,
    )
    return result, stub, checkout, remap


class TestScriptHeader:
    """The header is long and is edited by hand a lot, and a comment that loses
    its `#` becomes a command.

    That happened: a rewrite of the --pinned-only block dropped the marker on
    one line, and bash ran `A: command not found` on every single invocation.
    Nothing caught it — shellcheck passes (it is valid shell), `bash -n` passes
    (it is valid syntax), and 56 tests passed because the stray line writes to
    stderr without changing any exit code or any assertion. Two reviewers found
    it by reading.
    """

    SCRIPT = SCRIPTS_DIR / "upload-coverage-upstream.sh"

    def test_nothing_before_the_first_command_is_executable(self):
        for number, line in enumerate(self.SCRIPT.read_text().splitlines(), 1):
            if line.startswith("#") or not line.strip():
                continue
            # The first real line, and the only one this is allowed to be.
            assert line == "set -euo pipefail", (
                f"line {number} sits in the header but is not a comment, so bash "
                f"will execute it: {line!r}"
            )
            return
        raise AssertionError("the script has no commands at all")

    def test_a_run_emits_nothing_bash_could_not_understand(self, tmp_path):
        """The symptom as a user sees it, rather than as the file looks."""
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )

        assert "command not found" not in result.stderr
        assert "não encontrado" not in result.stderr


class TestInputValidation:
    def test_rejects_unknown_workspace(self, tmp_path, coverage_dir):
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            "nope",
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "unknown workspace" in result.stderr

    @pytest.mark.parametrize("name", ["../evil", "trailing-", "a" * 51, "UPPER"])
    def test_rejects_a_name_that_would_forge_a_flag(
        self, tmp_path, coverage_dir, name
    ):
        """A bad name becomes a ghost e2e-<typo> flag carryforward keeps alive.

        The cap and the trailing hyphen are here because this script is a
        documented entry point of its own: it used to be the LOOSER of the two
        guards on the reasoning that scripts/e2e-comment.cjs always runs first,
        which is only true of the two callers that exist today.
        """
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            name,
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "invalid workspace name" in result.stderr

    def test_the_longest_real_workspace_name_is_not_rejected(
        self, tmp_path, coverage_dir
    ):
        """A cap is only safe if it clears the names actually in use; the
        longest in this repo is 36 characters. Rejected here for a DIFFERENT
        reason — no such workspace in the fixture — which is what proves the
        name itself got through."""
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            "scaffolder-backend-module-servicenow",
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert "invalid workspace name" not in result.stderr
        assert "unknown workspace" in result.stderr

    def test_rejects_a_source_that_is_neither_url_nor_directory(self, tmp_path):
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(tmp_path / "absent"),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "neither a URL nor a directory" in result.stderr

    def test_rejects_unknown_argument(self, tmp_path, coverage_dir):
        """A typo'd --dry-run must not silently become a real upload."""
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            "--dryrun",
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "unknown argument" in result.stderr

    def test_rejects_non_sha_repo_ref(self, tmp_path, coverage_dir):
        """Codecov needs a commit that exists on GitHub; a branch name produces
        an upload attributed to nothing."""
        root = build_overlay(tmp_path)
        (root / "workspaces" / WORKSPACE / "source.json").write_text(
            json.dumps(
                {"repo": f"https://github.com/{UPSTREAM_SLUG}", "repo-ref": "main"}
            )
        )
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "not a 40-char SHA" in result.stderr

    def test_reports_a_source_json_missing_its_fields(self, tmp_path, coverage_dir):
        root = build_overlay(tmp_path)
        (root / "workspaces" / WORKSPACE / "source.json").write_text(json.dumps({}))
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={"CODECOV_RHDH_PLUGINS_TOKEN": "t"},
            cwd=root,
        )
        assert result.returncode == 1
        assert "no 'repo' / 'repo-ref'" in result.stderr

    def test_requires_token_unless_dry_run(self, tmp_path, coverage_dir):
        root = build_overlay(tmp_path)
        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={},
            cwd=root,
        )
        assert result.returncode == 1
        assert "CODECOV_RHDH_PLUGINS_TOKEN" in result.stderr


class TestEligibility:
    def test_skips_a_repo_without_a_codecov_project(self, tmp_path, coverage_dir):
        """Not an error: most workspaces have nowhere upstream to publish."""
        result, stub, _, _ = run_upstream(
            tmp_path, coverage_dir, repo_url="https://github.com/someone/elsewhere"
        )
        assert result.returncode == 0
        assert "[SKIP]" in result.stdout
        assert call_count(stub) == 0

    @pytest.mark.parametrize(
        "repo_url",
        [
            f"https://github.com/{UPSTREAM_SLUG}",
            f"https://github.com/{UPSTREAM_SLUG}.git",
            f"https://github.com/{UPSTREAM_SLUG}/",
            f"git@github.com:{UPSTREAM_SLUG}.git",
        ],
        ids=["plain", "dot-git", "trailing-slash", "ssh"],
    )
    def test_derives_the_slug_from_every_url_form(
        self, tmp_path, coverage_dir, repo_url
    ):
        """Eligibility is exact string equality, so a URL form the derivation
        mishandles degrades to a silent [SKIP] and exit 0 — an invisible
        failure rather than a loud one."""
        result, stub, _, _ = run_upstream(tmp_path, coverage_dir, repo_url=repo_url)

        assert result.returncode == 0, result.stderr
        assert "[SKIP]" not in result.stdout
        assert f"--slug {UPSTREAM_SLUG}" in recorded(stub, ".calls")


class TestFlagOverrides:
    """The flag is derived from the workspace name, except where Codecov has
    deleted the derived name.

    Deletion is a soft delete with no inverse — `deleteFlag` exists, nothing
    undoes it, and the name stays unusable. So the only repair is to publish
    under a different one, and these tests pin which name that is. Getting this
    wrong is invisible in the run: the upload succeeds under either name, and
    only the dashboard knows the difference.
    """

    def test_orchestrator_publishes_under_the_replacement_flag(
        self, tmp_path, coverage_dir
    ):
        """e2e-orchestrator was deleted on redhat-developer/rhdh-plugins. An
        upload under that name is still accepted and still processed — and
        still invisible to everyone looking at the dashboard."""
        result, stub, _, _ = run_upstream(
            tmp_path, coverage_dir, workspace="orchestrator"
        )

        assert result.returncode == 0, result.stderr
        calls = recorded(stub, ".calls")
        assert "--flag e2e-orchestrator-plugin" in calls
        # Bounded on the right so the replacement's own name cannot satisfy the
        # check that the dead name is gone — `e2e-orchestrator-plugin` continues
        # past where this wants a boundary. A regex word boundary would be WRONG
        # here: `-` is a non-word character, so `\be2e-orchestrator\b` matches
        # the replacement too and the assertion would never fail.
        #
        # Newlines are flattened first. The stub records one line per call, so
        # a `--flag` that ended up last on its line would be followed by \n and
        # slip past a space-only check — passing without proving anything.
        assert "--flag e2e-orchestrator " not in f"{calls} ".replace("\n", " ")

    def test_both_uploads_use_the_replacement_flag(self, tmp_path, coverage_dir):
        """The pinned ref and the branch tip are separate uploads. One of each
        would split orchestrator's coverage across a live flag and a dead one,
        which reads as half the coverage rather than as a bug."""
        result, stub, _, _ = run_upstream(
            tmp_path, coverage_dir, workspace="orchestrator"
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 2
        assert recorded(stub, ".calls").count("--flag e2e-orchestrator-plugin") == 2

    def test_the_session_name_follows_the_replacement_flag(
        self, tmp_path, coverage_dir
    ):
        """Session names are `overlay-<flag>-<digest>`, and the post-upload
        check looks the session up by that name. A session still spelled with
        the dead flag would be looked for under a name nothing wrote."""
        result, stub, _, _ = run_upstream(
            tmp_path, coverage_dir, workspace="orchestrator"
        )

        assert result.returncode == 0, result.stderr
        assert "--name overlay-e2e-orchestrator-plugin-" in recorded(stub, ".calls")

    def test_every_override_the_table_can_produce_is_a_valid_flag(self):
        """The override table is a second door into a shared Codecov project,
        and it is the only one no runtime check can defend: the entries are
        source-code constants, so the workspace guard never sees them and an
        entry for a workspace nobody ran is never evaluated at all. A typo there
        would register a ghost flag on a repo we do not administer, which
        carryforward keeps alive with no way for us to remove it.

        That makes this the guard, not a backup for one. It checks the table
        itself rather than one path through it, and parses it out of the script
        so a NEW entry is covered without anyone remembering to add a test.
        """
        source = (SCRIPTS_DIR / "upload-coverage-upstream.sh").read_text()
        parts = source.split("upstream_flag_for() {", 1)
        assert len(parts) == 2, "upstream_flag_for() not found — renamed, or spelled differently?"
        body = parts[1].split("\n}", 1)[0]

        overrides = re.findall(r'^\s*([a-z0-9-]+)\)\s*echo "([^"]+)"', body, re.M)
        assert overrides, "no override entries found — has the table moved?"

        # The parse understands ONE shape of case arm. An entry written any
        # other way — `a|b)`, `echo 'x'`, the echo on the next line — would be
        # skipped in silence, and a skipped entry is exactly the one that
        # reaches the shared project unchecked. So count the arms independently
        # and refuse to pass while any went unread. Comment lines start with `#`
        # and are excluded; `*)` is the fallthrough, not an override.
        #
        # Verified by adding `foo|bar) echo "E2E_BAD_FLAG-" ;;` to the table:
        # without this count the whole class stayed green.
        arms = re.findall(r"^\s*([^#\s][^)]*)\)\s", body, re.M)
        assert len(overrides) == len(arms) - 1, (
            f"parsed {len(overrides)} override(s) out of {len(arms) - 1} case arm(s) — "
            "an entry is written in a shape this test cannot read, so it goes unchecked"
        )

        # Split rather than one composite assertion, so a failure names which
        # rule the entry broke instead of only that it broke one.
        valid = re.compile(r"^e2e-[a-z0-9][a-z0-9-]{0,49}$")
        for workspace, flag in overrides:
            assert valid.match(flag), (
                f"override for '{workspace}' is not a usable flag: {flag!r}"
            )
            # The character class above permits a trailing hyphen; Codecov and
            # the workspace guard both reject one.
            assert not flag.endswith("-"), (
                f"override for '{workspace}' ends in a hyphen: {flag!r}"
            )

    def test_a_workspace_with_no_override_keeps_the_derived_name(
        self, tmp_path, coverage_dir
    ):
        """The override list is an exception list, not a lookup table. A
        workspace that is not on it must need no entry at all — otherwise every
        new workspace acquires bookkeeping there.

        Bounded on the right for the same reason the orchestrator test is, and
        it is not hypothetical here: `e2e-intelligent-assistant` is a PREFIX of
        `e2e-intelligent-assistant-plugin`, so an unbounded match keeps passing
        after someone adds this very workspace to the table — the one thing this
        test exists to notice. Verified by adding that entry: unbounded, this
        stayed green while four sibling tests went red.
        """
        result, stub, _, _ = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        calls = f'{recorded(stub, ".calls")} '.replace("\n", " ")
        assert f"--flag e2e-{WORKSPACE} " in calls


class TestUploadContract:
    def test_uploads_to_both_the_pinned_ref_and_the_branch_tip(
        self, tmp_path, coverage_dir
    ):
        """The dual attribution: exact on the pinned ref, visible on the tip."""
        result, stub, checkout, _ = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 2
        calls = recorded(stub, ".calls")
        assert f"--slug {UPSTREAM_SLUG}" in calls
        assert f"--flag e2e-{WORKSPACE}" in calls
        assert f"--sha {PINNED_REF}" in calls
        # The second SHA is the real tip, not merely "some other 40 chars".
        assert f"--sha {upstream_head(checkout)}" in calls

    def test_each_upload_runs_from_a_checkout_of_the_sha_it_declares(
        self, tmp_path, coverage_dir
    ):
        """The load-bearing constraint, and the one this suite got wrong once.

        The Codecov CLI builds the file network it sends from the git repo in
        the CWD; `--sha` does not change that. Running BOTH uploads from the
        pinned checkout declares the pinned tree's file list against the HEAD
        commit, so Codecov is told about files that commit may not contain — it
        drops the report and the run still reports success.

        Measured before this was fixed: extensions, pinned 201 commits behind
        HEAD, uploaded cleanly and changed nothing at HEAD, while
        intelligent-assistant at 101 commits behind landed. The difference was
        how far the workspace had drifted, which is not a thing to leave to
        luck.
        """
        result, stub, checkout, _ = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        cwds = [
            Path(line).resolve()
            for line in recorded(stub, ".cwds").splitlines()
            if line.strip()
        ]
        # Two uploads, two DIFFERENT trees — a length check as well, so this
        # cannot pass when only one upload ran.
        assert len(cwds) == 2
        assert cwds[0] == checkout.resolve()
        assert cwds[1] == head_checkout_of(tmp_path).resolve()

    def test_the_head_copy_is_remapped_against_the_head_tree(
        self, tmp_path, coverage_dir
    ):
        """Resolving the HEAD copy against the pinned tree would publish paths
        that may have moved or been deleted since the ref was pinned."""
        result, _, checkout, remap = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        roots = [
            line.split("--upstream-root", 1)[1].split()[0]
            for line in recorded(remap, ".args").splitlines()
            if "--upstream-root" in line
        ]
        assert len(roots) == 2, "the HEAD copy needs its own remap"
        assert Path(roots[0]).resolve() == checkout.resolve()
        assert Path(roots[1]).resolve() == head_checkout_of(tmp_path).resolve()

    def test_each_upload_sends_its_own_remapped_report(self, tmp_path, coverage_dir):
        """Two checkouts are only half the fix. Pointing both uploads at the
        pinned remap's lcov would send the pinned tree's PATHS against the HEAD
        commit — the same mismatch, one layer down, and just as silent."""
        result, stub, _, _ = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        files = [
            line.split("--file", 1)[1].split()[0]
            for line in recorded(stub, ".calls").splitlines()
            if "--file" in line
        ]
        assert len(files) == 2
        assert files[0] != files[1], (
            "both uploads sent the same report file, so one of them describes "
            "a tree it was not resolved against"
        )

    def test_branch_is_derived_not_assumed(self, tmp_path, coverage_dir):
        """--branch decides which branch's trend the report joins. Hardcoding
        "main" while resolving the tip of whatever HEAD points at would attach
        the report to a branch that may not exist."""
        result, stub, _, _ = run_upstream(tmp_path, coverage_dir, branch="trunk")

        assert result.returncode == 0, result.stderr
        calls = recorded(stub, ".calls")
        assert "--branch trunk" in calls
        assert "--branch main" not in calls

    def test_passes_the_checkout_and_workspace_to_the_remap(
        self, tmp_path, coverage_dir
    ):
        """The remap resolves report paths against this checkout. Handing it the
        wrong root or the slug instead of the workspace produces a report that
        uploads cleanly and attributes to nothing."""
        result, _, checkout, remap = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        args = recorded(remap, ".args")
        assert f"--upstream-root {checkout.resolve()}" in args
        assert f"--upstream-workspace {WORKSPACE}" in args
        assert str(coverage_dir) in args

    def test_two_identical_reports_share_one_session_name(
        self, tmp_path, coverage_dir
    ):
        """Codecov treats a matching --name on the same commit as a replacement
        for that session. Deriving it from the report digest is what makes a
        retry idempotent."""
        first, stub, _, _ = run_upstream(tmp_path, coverage_dir)
        assert first.returncode == 0, first.stderr

        names = session_names(stub)
        assert len(set(names)) == 1
        name = names[0]
        assert name.startswith(f"overlay-e2e-{WORKSPACE}-")
        digest = name.rsplit("-", 1)[1]
        assert len(digest) == 8
        assert all(c in "0123456789abcdef" for c in digest)

    def test_two_different_reports_get_different_session_names(
        self, tmp_path, coverage_dir
    ):
        """The other half, and the half this suite briefly asserted backwards.

        Before each target got its own remap there was one report and one
        `readonly UPLOAD_NAME`, so "both uploads share a name" was true. It is
        now a fixture artefact: in production the two lcovs describe different
        trees. A name that ignored the report it names would collapse the HEAD
        session onto the pinned one and silently replace it.
        """
        result, stub, _, _ = run_upstream(
            tmp_path, coverage_dir, env={"REMAP_HEAD_FILES": "1"}
        )
        assert result.returncode == 0, result.stderr

        assert len(set(session_names(stub))) == 2


def write_git_shim(path: Path):
    """A `git` that passes everything through but fails `fetch`.

    The checkout seams and clone_at are mutually exclusive — setting the seam
    means clone_at never runs, and not setting it means the fetch goes to
    github.com — so the only hermetic way to reach the failure branch is to make
    git itself refuse. `fail_fetch_after` lets the pinned clone succeed and the
    HEAD one fail, which is the case that must NOT be fatal.
    """
    path.write_text(
        "#!/usr/bin/env bash\n"
        'for a in "$@"; do\n'
        '  if [ "$a" = "fetch" ]; then\n'
        '    echo "fatal: could not read from remote repository" >&2; exit 128\n'
        '  fi\n'
        'done\n'
        'exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" git "$@"\n'
    )
    path.chmod(0o755)
    return path


class TestRealClone:
    """The PR's central claim, exercised without a seam.

    Every other test hands both checkouts in, so `clone_at` never runs and the
    thing the change is about — each upload coming from a checkout of the sha it
    declares — is asserted only against directories the fixture prepared. Here
    the script really clones, twice, from a git shim that rewrites the remote to
    a local repository.
    """

    def test_it_clones_each_sha_and_uploads_from_the_right_one(
        self, tmp_path, coverage_dir
    ):
        root = build_overlay(tmp_path)
        origin = build_upstream_checkout(tmp_path).parent / "upstream-origin"
        # The pinned ref must be a real commit that is NOT the tip, or the
        # script takes its "pinned ref is already HEAD" shortcut and only one
        # upload happens — which is not what this test is about.
        pinned = git(origin, "rev-parse", "HEAD").stdout.strip()
        (origin / "workspaces" / WORKSPACE / "plugins" / "ia" / "src" / "Later.tsx").write_text(
            "export const b = 2;\n"
        )
        git(origin, "add", "-A")
        git(origin, "commit", "-q", "-m", "move on")
        (root / "workspaces" / WORKSPACE / "source.json").write_text(
            json.dumps(
                {
                    "repo": f"https://github.com/{UPSTREAM_SLUG}",
                    "repo-ref": pinned,
                    "repo-flat": False,
                }
            )
        )
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "git"
        # clone_at fetches by remote NAME, so the URL has to be swapped where it
        # is registered rather than where it is used.
        shim.write_text(
            "#!/usr/bin/env bash\n"
            "args=()\n"
            'for a in "$@"; do\n'
            f'  if [ "$a" = "https://github.com/{UPSTREAM_SLUG}" ]; then a="{origin}"; fi\n'
            '  args+=("$a")\n'
            "done\n"
            'exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" git "${args[@]}"\n'
        )
        shim.chmod(0o755)
        stub = write_stub_cli(tmp_path / "codecov", [0])

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={
                "CODECOV_BIN": str(stub),
                "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
                "VERIFY_ATTEMPTS": "1",
                "VERIFY_DELAY_SECONDS": "0",
                "REMAP_BIN": str(write_stub_remap(tmp_path / "remap.sh")),
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
                "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            },
            cwd=root,
        )

        assert result.returncode == 0, result.stderr
        cwds = [
            Path(line).resolve()
            for line in recorded(stub, ".cwds").splitlines()
            if line.strip()
        ]
        assert len(cwds) == 2
        # Two real clones in two different directories, neither handed in. The
        # directories themselves are gone by now — the script traps EXIT and
        # removes its work dir — so what is asserted is the pairing that
        # outlives it: distinct trees, and the right sha declared from each.
        assert cwds[0] != cwds[1]
        calls = recorded(stub, ".calls").splitlines()
        assert f"--sha {pinned}" in calls[0]
        assert f"--sha {git(origin, 'rev-parse', 'HEAD').stdout.strip()}" in calls[1]


_UPLOADS_API_SEQ = itertools.count()
_GRAPHQL_API_SEQ = itertools.count()


def expected_session_name(files=2):
    """The session name the script will derive for the stub's report.

    `upload_name_for` digests the lcov with `git hash-object`, which is a plain
    git blob sha1 — so it can be computed here instead of running the script
    once to find out. Deriving it keeps the check on the CONTRACT (the name
    follows the content) rather than on a digest pasted into the test.
    """
    body = "".join(
        f"TN:\nSF:workspaces/x/src/a{i}.ts\nDA:1,1\nend_of_record\n"
        for i in range(1, files + 1)
    ).encode()
    blob = b"blob " + str(len(body)).encode() + b"\x00" + body
    return f"overlay-e2e-{WORKSPACE}-{hashlib.sha1(blob).hexdigest()[:8]}"


def write_uploads_api(tmp_path, names, *, pages=1):
    """A stand-in for Codecov's uploads endpoint, served from files.

    Paginated on purpose: the endpoint really does page, and not paginating it
    is what hid the sessions during the investigation this check exists because
    of. A fixture that returned everything on one page would let that same bug
    back in.
    """
    # Its own directory per call: the harness writes an empty one for every run,
    # and a shared path would have it clobber the fixture a test just set up.
    api = tmp_path / f"api{next(_UPLOADS_API_SEQ)}"
    api.mkdir(parents=True, exist_ok=True)
    # Exactly `pages` pages, padding with empty ones when there are fewer names
    # than pages. Sizing by names instead rounded up and silently collapsed
    # `pages=3` into a single page whenever the names fit — so a test that named
    # pagination in its title was walking one page and proving nothing.
    chunks = [names[i::pages] for i in range(pages)]
    for i, chunk in enumerate(chunks):
        nxt = f"file://{api}/page{i + 2}.json" if i + 1 < len(chunks) else None
        (api / f"page{i + 1}.json").write_text(
            json.dumps({"results": [{"name": n} for n in chunk], "next": nxt})
        )
    return f"file://{api}/page1.json"


def write_graphql_api(tmp_path, names):
    """A stand-in for Codecov's GraphQL endpoint, served from a file.

    curl serves a file:// URL and ignores the POST body, so the same seam shape
    works for an endpoint the script only ever POSTs to. Not paginated: the
    query asks for the flag by name, so a real answer is one edge or none.
    """
    api = tmp_path / f"gql{next(_GRAPHQL_API_SEQ)}.json"
    api.write_text(
        json.dumps(
            {
                "data": {
                    "owner": {
                        "repository": {
                            "coverageAnalytics": {
                                "flags": {
                                    "edges": [{"node": {"name": n}} for n in names]
                                }
                            }
                        }
                    }
                }
            }
        )
    )
    return f"file://{api}"


@contextlib.contextmanager
def scripted_http_server(responses):
    """A loopback server that answers each request from `responses` in order.

    For the two things a file:// fixture cannot express: a status code at all,
    and an endpoint that works and then stops. The last entry repeats if more
    requests arrive, so a single-entry list is a server that always answers the
    same way.

    Bound to 127.0.0.1 on an ephemeral port, so this stays as hermetic as the
    rest of the suite — no name resolution, no route off the machine.
    """

    # Popped from the handler thread, which is safe only because HTTPServer
    # answers one request at a time. Switching to ThreadingHTTPServer would need
    # a lock — noted here because the failure would be a flake, not a red test.
    remaining = list(responses)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
            status, body = remaining.pop(0) if len(remaining) > 1 else remaining[0]
            payload = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/uploads"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class TestUploadVerification:
    """Codecov accepts an upload and returns before processing it, so "queued
    for processing" is a receipt rather than a result. This is the last place
    the script could publish nothing and report success."""

    def _run(self, tmp_path, coverage_dir, uploads_api):
        return run_upstream(
            tmp_path,
            coverage_dir,
            env={
                "CODECOV_UPLOADS_API": uploads_api,
                "VERIFY_ATTEMPTS": "2",
                "VERIFY_DELAY_SECONDS": "0",
            },
        )

    def test_a_session_that_appears_is_confirmed(self, tmp_path, coverage_dir):
        name = expected_session_name()

        result, _, _, _ = self._run(
            tmp_path, coverage_dir, write_uploads_api(tmp_path, [name], pages=3)
        )

        assert result.returncode == 0, result.stderr
        assert f"session '{name}' is on the commit" in result.stdout
        assert "unconfirmed" not in result.stderr

    def test_a_session_that_never_appears_is_reported(self, tmp_path, coverage_dir):
        """The upload was accepted and the report did not change — the exact
        outcome that read as success for a day."""
        result, _, _, _ = self._run(
            tmp_path, coverage_dir, write_uploads_api(tmp_path, ["someone-elses-session"])
        )

        assert "no session named" in result.stderr
        assert "uploaded but unconfirmed" in result.stderr

    def test_verification_can_be_switched_off_with_zero_attempts(
        self, tmp_path, coverage_dir
    ):
        """VERIFY_ATTEMPTS=0 is the obvious way to turn this off, and it must
        mean the same thing on both platforms. BSD seq counts DOWN when first >
        last, so the loop this replaced ran TWICE on macOS for zero attempts
        while skipping entirely on GNU."""
        result, _, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            env={
                "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
                "VERIFY_ATTEMPTS": "0",
                "VERIFY_DELAY_SECONDS": "0",
            },
        )

        assert result.returncode == 0, result.stderr
        assert "is on the commit" not in result.stdout
        assert "no session named" not in result.stderr

    def test_an_unreachable_api_is_not_reported_as_a_missing_session(
        self, tmp_path, coverage_dir
    ):
        """The two read identically in a log and send whoever is debugging to
        opposite places — Codecov, or their own network."""
        result, _, _, _ = self._run(
            tmp_path, coverage_dir, f"file://{tmp_path}/nothing-here.json"
        )

        assert result.returncode == 0, result.stderr
        assert "could not reach" in result.stderr
        assert "no session named" not in result.stderr

    def test_the_url_the_warning_prints_is_one_you_can_open(
        self, tmp_path, coverage_dir
    ):
        """It is the only thread anyone gets for investigating, and it used to
        be printed with two of its three placeholders unsubstituted.

        The fixture URL carries all three placeholders on purpose. Pointing this
        at an already-substituted path would assert the absence of something the
        input never contained — a test that passes whatever the code does.
        """
        owner, repo = UPSTREAM_SLUG.split("/")
        api = tmp_path / "tpl" / owner / repo / PINNED_REF
        api.mkdir(parents=True)
        (api / "page1.json").write_text(json.dumps({"results": [], "next": None}))
        templated = f"file://{tmp_path}/tpl/%OWNER%/%REPO%/%SHA%/page1.json"

        result, _, _, _ = self._run(tmp_path, coverage_dir, templated)

        assert "no session named" in result.stderr, (
            "the templated URL did not resolve, so this asserts nothing"
        )
        assert "%OWNER%" not in result.stderr
        assert "%REPO%" not in result.stderr
        assert "%SHA%" not in result.stderr

    def test_an_http_error_is_not_read_as_an_empty_listing(
        self, tmp_path, coverage_dir
    ):
        """Codecov answers 404 with `{"detail":"Not found."}` and 429 with its
        own JSON. Without `curl --fail` both are a successful fetch of an error
        body, which `jq '(.results // [])[]'` reads as "no sessions" — routing a
        rate-limit into the loud "the report may not have changed" instead of
        "could not reach".

        Served over real HTTP on loopback, because the file:// seam every other
        test uses has no status code: it can express "the file is there" and
        "it is not", never "the server answered 404 with a body". A fixture
        that cannot produce the condition cannot test the guard against it.
        """
        with scripted_http_server([(404, '{"detail": "Not found."}')]) as base:
            result, _, _, _ = self._run(tmp_path, coverage_dir, base)

        assert "no session named" not in result.stderr
        assert "could not reach" in result.stderr

    def test_one_reachable_poll_outweighs_a_later_blip(
        self, tmp_path, coverage_dir
    ):
        """A poll that reached the API and found nothing is evidence; a blip on
        a later attempt must not downgrade it to "could not reach", which is the
        message an operator dismisses.

        The server answers a real listing first and fails afterwards — a static
        fixture is either always reachable or never, so it cannot produce the
        ordering this guards. `--pinned-only` keeps it to ONE upload, so the
        scripted responses belong to a single verification rather than being
        split across two.
        """
        listing = json.dumps({"results": [{"name": "someone-elses"}], "next": None})
        with scripted_http_server([(200, listing), (500, "boom")]) as api:
            result, _, _, _ = run_upstream(
                tmp_path,
                coverage_dir,
                "--pinned-only",
                env={
                    "CODECOV_UPLOADS_API": api,
                    "VERIFY_ATTEMPTS": "2",
                    "VERIFY_DELAY_SECONDS": "0",
                },
            )

        assert "no session named" in result.stderr
        assert "could not reach" not in result.stderr

    def test_a_listing_that_never_ends_is_abandoned(self, tmp_path, coverage_dir):
        """A `next` that points at itself would otherwise spin until the job's
        own timeout kills it — turning a diagnostic into the thing that stops
        the publish."""
        api = tmp_path / "loop"
        api.mkdir()
        page = api / "page.json"
        page.write_text(json.dumps({"results": [], "next": f"file://{page}"}))

        result, _, _, _ = self._run(tmp_path, coverage_dir, f"file://{page}")

        assert result.returncode == 0, result.stderr
        assert "stopped after" in result.stderr

    def test_a_warning_cannot_forge_a_second_workflow_command(
        self, tmp_path, coverage_dir
    ):
        """`::warning::` is a workflow command, so a newline inside its data
        would start a second one. Nothing reaching it today is unconstrained —
        this closes the gap for the next caller, which is the only moment it is
        cheap to close."""
        # A REAL newline, in a filename — `%0A` written literally proves nothing,
        # since the string survives either way and only its escaping changes.
        api = tmp_path / "inject"
        api.mkdir()
        page = api / "p\n::error::forged.json"
        page.write_text(json.dumps({"results": [], "next": None}))

        # GITHUB_ACTIONS on, or the `::warning::` line is never emitted and the
        # test passes without ever reaching the thing it names.
        result, _, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            env={
                "CODECOV_UPLOADS_API": f"file://{page}",
                "VERIFY_ATTEMPTS": "1",
                "VERIFY_DELAY_SECONDS": "0",
                "GITHUB_ACTIONS": "true",
            },
        )

        # Unescaped, the newline ends the warning and the rest starts a command
        # of its own on the next line.
        for line in result.stdout.splitlines():
            assert not line.startswith("::error::"), (
                f"a forged workflow command reached the runner: {line!r}"
            )

    def test_an_unconfirmed_upload_does_not_fail_the_run(
        self, tmp_path, coverage_dir
    ):
        """A slow processing queue is not a failed publish. Turning every merge
        red on a timeout would be worse than the silence it replaces."""
        result, _, _, _ = self._run(
            tmp_path, coverage_dir, write_uploads_api(tmp_path, [])
        )

        assert result.returncode == 0, result.stderr

    def test_the_session_is_looked_for_beyond_the_first_page(
        self, tmp_path, coverage_dir
    ):
        """The endpoint paginates, and not following `next` is precisely what
        made these sessions look absent while they were there all along."""
        name = expected_session_name()
        api = write_uploads_api(tmp_path, ["filler-a", "filler-b", name], pages=3)

        result, _, _, _ = self._run(tmp_path, coverage_dir, api)

        assert f"session '{name}' is on the commit" in result.stdout


class TestCloneFailure:
    """clone_at's failure contract, which the two-checkout change created.

    The two checkouts fail differently on purpose: without the pinned tree there
    is nothing to publish at all, while without the HEAD tree the
    exactly-attributed copy is still worth having.
    """

    def _run(self, tmp_path, coverage_dir, *, pinned_seam):
        """`git fetch` always fails. Which clone that breaks depends on whether
        the pinned checkout is handed in: with the seam set, clone_at only ever
        runs for the HEAD copy."""
        root = build_overlay(tmp_path)
        checkout = build_upstream_checkout(tmp_path)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        write_git_shim(bin_dir / "git")
        stub = write_stub_cli(tmp_path / "codecov", [0])
        env = {
            "CODECOV_BIN": str(stub),
            "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
            "VERIFY_ATTEMPTS": "1",
            "VERIFY_DELAY_SECONDS": "0",
            "REMAP_BIN": str(write_stub_remap(tmp_path / "remap.sh")),
            "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
        }
        if pinned_seam:
            env["UPSTREAM_CHECKOUT_DIR"] = str(checkout)
        return (
            run_script(
                root / "scripts" / "upload-coverage-upstream.sh",
                WORKSPACE,
                str(coverage_dir),
                env=env,
                cwd=root,
            ),
            stub,
        )

    def test_a_pinned_clone_that_fails_stops_the_run(self, tmp_path, coverage_dir):
        """Nothing downstream can be attributed without the tree the coverage
        was measured against."""
        result, stub = self._run(tmp_path, coverage_dir, pinned_seam=False)

        assert result.returncode == 1
        assert "could not fetch" in result.stderr
        assert call_count(stub) == 0

    def test_a_head_clone_that_fails_still_publishes_the_pinned_copy(
        self, tmp_path, coverage_dir
    ):
        """The visible copy is lost, the attributed one is not — and the run
        says which, because a flag that never appears on the default branch with
        no explanation is the failure this whole path exists to remove."""
        result, stub = self._run(tmp_path, coverage_dir, pinned_seam=True)

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 1
        assert "could not check out main HEAD" in result.stderr


class TestStalenessReporting:
    """The diagnostic half of the two-checkout change.

    The counts are the only place a reader learns that a workspace's pinned ref
    has drifted far enough that the HEAD copy no longer describes the same
    files. The script header calls it "the number that says how stale a pinned
    ref has become, and it is invisible otherwise" — which is precisely why it
    needs a test: nothing else would notice if it stopped being printed.
    """

    def test_both_resolutions_are_reported(self, tmp_path, coverage_dir):
        result, _, _, _ = run_upstream(
            tmp_path, coverage_dir, env={"REMAP_HEAD_FILES": "1"}
        )

        assert result.returncode == 0, result.stderr
        assert "pinned ref resolved 2 file(s)" in result.stdout
        assert "HEAD resolved 1" in result.stdout

    def test_files_lost_since_the_pinned_ref_are_warned_about(
        self, tmp_path, coverage_dir
    ):
        """A file measured at the pinned ref that no longer exists at HEAD is
        absent from the copy anyone sees. Quietly publishing less than was
        measured is the kind of shortfall this whole change exists to surface."""
        result, _, _, _ = run_upstream(
            tmp_path, coverage_dir, env={"REMAP_HEAD_FILES": "1"}
        )

        assert result.returncode == 0, result.stderr
        assert "1 file(s) measured at the pinned ref no" in result.stderr

    def test_no_drift_warning_when_everything_still_resolves(
        self, tmp_path, coverage_dir
    ):
        """The warning is only worth having if the ordinary case is quiet."""
        result, _, _, _ = run_upstream(tmp_path, coverage_dir)

        assert result.returncode == 0, result.stderr
        assert "no longer exist" not in result.stderr

    def test_churn_that_keeps_the_count_equal_is_still_reported(
        self, tmp_path, coverage_dir
    ):
        """Counts would call this no drift. One measured file is missing from
        the copy anyone sees and another appeared in its place, which is exactly
        the case a count cannot see."""
        result, _, _, _ = run_upstream(
            tmp_path, coverage_dir, env={"REMAP_HEAD_SHIFT": "1"}
        )

        assert result.returncode == 0, result.stderr
        assert "1 file(s) measured at the pinned ref no longer resolve" in result.stderr

    def test_a_skipped_head_copy_is_raised_as_a_run_annotation(
        self, tmp_path, coverage_dir
    ):
        """The job is unattended now. Every HEAD-copy failure exits 0 on
        purpose, so stderr alone would mean "published nothing anyone can see,
        reported success" — the failure this change exists to remove."""
        result, _, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            env={"REMAP_HEAD_FILES": "0", "GITHUB_ACTIONS": "true"},
        )

        assert result.returncode == 0, result.stderr
        assert "::warning::e2e-" in result.stdout

    def test_nothing_is_annotated_outside_actions(self, tmp_path, coverage_dir):
        """`::warning::` is only meaningful to the Actions runner; printing it
        into a developer's terminal is noise pretending to be a mechanism."""
        result, _, _, _ = run_upstream(
            tmp_path, coverage_dir, env={"REMAP_HEAD_FILES": "0"}
        )

        assert "::warning::" not in result.stdout

    def test_a_head_remap_that_resolves_nothing_publishes_only_the_pinned_copy(
        self, tmp_path, coverage_dir
    ):
        """Every path the run measured has moved or gone since the ref was
        pinned. The exactly-attributed copy is still worth publishing; doing it
        without saying why the visible one is missing is not."""
        result, stub, _, _ = run_upstream(
            tmp_path, coverage_dir, env={"REMAP_HEAD_FILES": "0"}
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 1
        assert "resolved nothing against main HEAD" in result.stderr


class TestTargetSelection:
    def test_pinned_only_does_not_pay_for_the_head_resolution(
        self, tmp_path, coverage_dir
    ):
        """--pinned-only is the cheap staged run. Doing the HEAD checkout and
        remap anyway and then discarding them costs a shallow clone of a
        monorepo for nothing, and nothing else would notice."""
        result, _, _, remap = run_upstream(tmp_path, coverage_dir, "--pinned-only")

        assert result.returncode == 0, result.stderr
        assert len(recorded(remap, ".args").strip().splitlines()) == 1
        assert "Remapping onto main HEAD paths" not in result.stdout

    def test_pinned_only_skips_the_one_way_door(self, tmp_path, coverage_dir):
        """The tip copy cannot be taken back — once the flag is there,
        carryforward keeps it on every later commit and removal needs Codecov UI
        access. --pinned-only stages a first real run without that."""
        result, stub, _, _ = run_upstream(tmp_path, coverage_dir, "--pinned-only")

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 1
        calls = recorded(stub, ".calls")
        assert f"--sha {PINNED_REF}" in calls
        assert calls.count("--sha ") == 1

    def test_a_pinned_ref_that_is_already_the_tip_uploads_once_without_warning(
        self, tmp_path, coverage_dir
    ):
        """The normal state right after update-plugins-repo-refs bumps a
        workspace. One upload covers both roles; claiming the tip could not be
        resolved would be false, and would send a reader looking for a fault
        that is not there."""
        root = build_overlay(tmp_path)
        checkout = build_upstream_checkout(tmp_path)
        head = upstream_head(checkout)
        (root / "workspaces" / WORKSPACE / "source.json").write_text(
            json.dumps({"repo": f"https://github.com/{UPSTREAM_SLUG}", "repo-ref": head})
        )
        stub = write_stub_cli(tmp_path / "codecov", [0])
        remap = write_stub_remap(tmp_path / "remap.sh")

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={
                "CODECOV_BIN": str(stub),
                "UPSTREAM_CHECKOUT_DIR": str(checkout),
                "CODECOV_UPLOADS_API": write_uploads_api(
                    tmp_path, [expected_session_name()]
                ),
                "VERIFY_ATTEMPTS": "1",
                "VERIFY_DELAY_SECONDS": "0",
                # Without this the HEAD copy clones from github.com, and the
                # test's outcome starts depending on the network.
                "UPSTREAM_HEAD_CHECKOUT_DIR": str(
                    build_upstream_checkout(tmp_path, into=head_checkout_of(tmp_path))
                ),
                "REMAP_BIN": str(remap),
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            },
            cwd=root,
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 1
        # Nothing at all, not "nothing about the HEAD copy": the session the
        # upload creates is in the fixture, so a clean run here has to be
        # clean end to end.
        assert "[WARN]" not in result.stderr
        assert "will not be visible" not in result.stderr


class TestFailureHandling:
    def test_a_failed_upload_is_a_failed_run(self, tmp_path, coverage_dir):
        """Without this the job goes green while Codecov received nothing."""
        result, _, _, _ = run_upstream(
            tmp_path, coverage_dir, exit_codes=(1,), env={"UPLOAD_RETRY_DELAY_SECONDS": "0"}
        )

        assert result.returncode == 1
        assert "upload(s) failed" in result.stderr

    def test_a_target_that_exhausts_its_retries_does_not_skip_the_next(
        self, tmp_path, coverage_dir
    ):
        """Each SHA is an independent target. Abandoning the tip copy because the
        pinned-ref copy failed would lose the only one anyone sees — and the run
        must still end red, naming how many of how many failed."""
        # Both attempts on the pinned ref fail; the tip upload then succeeds.
        result, stub, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            exit_codes=(1, 1, 0),
            env={"UPLOAD_RETRY_DELAY_SECONDS": "0"},
        )

        assert result.returncode == 1
        # 2 attempts on the first target + 1 on the second: the second was tried.
        assert call_count(stub) == 3
        assert "1 of 2 upload(s) failed" in result.stderr

    def test_an_interrupted_retry_sleep_does_not_abandon_the_next_target(
        self, tmp_path, coverage_dir
    ):
        """A signalled `sleep` exits non-zero, and under `set -e` that would
        abort the loop — losing the remaining target on nothing more than a
        stray signal. upload-coverage.sh guards the same line for the same
        reason; here the blast radius is larger because there are two targets.

        A `sleep` shim that exits non-zero reproduces the signal case exactly.
        """
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "sleep"
        shim.write_text("#!/usr/bin/env bash\nexit 1\n")
        shim.chmod(0o755)

        result, stub, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            exit_codes=(1, 1, 0),
            env={
                "PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
                "UPLOAD_RETRY_DELAY_SECONDS": "0",
            },
        )

        # Without the guard the run dies during the first retry's sleep, so the
        # second target is never attempted and the count stops at 1.
        assert call_count(stub) == 3
        assert result.returncode == 1
        assert "1 of 2 upload(s) failed" in result.stderr

    def test_a_transient_failure_is_retried(self, tmp_path, coverage_dir):
        """Matches upload-coverage.sh: a 5xx or DNS blip should not need a
        human to re-dispatch the job."""
        result, stub, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            "--pinned-only",
            exit_codes=(1, 0),
            env={"UPLOAD_RETRY_DELAY_SECONDS": "0"},
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 2

    def test_a_remap_that_writes_nothing_is_an_error(self, tmp_path, coverage_dir):
        """An empty report would upload cleanly and publish nothing."""
        root = build_overlay(tmp_path)
        checkout = build_upstream_checkout(tmp_path)
        stub = write_stub_cli(tmp_path / "codecov", [0])
        silent = tmp_path / "silent-remap.sh"
        silent.write_text("#!/usr/bin/env bash\nmkdir -p \"$2\"\nexit 0\n")
        silent.chmod(0o755)

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={
                "CODECOV_BIN": str(stub),
                "UPSTREAM_CHECKOUT_DIR": str(checkout),
                "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
                "VERIFY_ATTEMPTS": "1",
                "VERIFY_DELAY_SECONDS": "0",
                # Without this the HEAD copy clones from github.com, and the
                # test's outcome starts depending on the network.
                "UPSTREAM_HEAD_CHECKOUT_DIR": str(
                    build_upstream_checkout(tmp_path, into=head_checkout_of(tmp_path))
                ),
                "REMAP_BIN": str(silent),
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            },
            cwd=root,
        )

        assert result.returncode == 1
        assert "remap produced no lcov" in result.stderr
        assert call_count(stub) == 0

    def test_an_unreachable_origin_reports_gits_own_error(self, tmp_path, coverage_dir):
        """"could not resolve the default branch" alone never says whether it
        was auth, DNS or a deleted repo, so git's message is kept."""
        root = build_overlay(tmp_path)
        checkout = tmp_path / "checkout"
        checkout.mkdir()
        git(checkout, "init", "-q", ".")
        git(checkout, "remote", "add", "origin", str(tmp_path / "does-not-exist"))
        stub = write_stub_cli(tmp_path / "codecov", [0])

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(coverage_dir),
            env={
                "CODECOV_BIN": str(stub),
                "UPSTREAM_CHECKOUT_DIR": str(checkout),
                "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
                "VERIFY_ATTEMPTS": "1",
                "VERIFY_DELAY_SECONDS": "0",
                # Without this the HEAD copy clones from github.com, and the
                # test's outcome starts depending on the network.
                "UPSTREAM_HEAD_CHECKOUT_DIR": str(
                    build_upstream_checkout(tmp_path, into=head_checkout_of(tmp_path))
                ),
                "REMAP_BIN": str(write_stub_remap(tmp_path / "remap.sh")),
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            },
            cwd=root,
        )

        assert result.returncode == 1
        assert "could not query" in result.stderr
        assert "does-not-exist" in result.stderr
        assert call_count(stub) == 0


class TestNoCoverage:
    def test_an_empty_coverage_dir_is_not_a_failure(self, tmp_path):
        """A backend-only or uninstrumented e2e legitimately produces no
        coverage. Turning that into a red job punishes a run that did nothing
        wrong."""
        empty = tmp_path / "no-coverage"
        empty.mkdir()
        result, stub, _, _ = run_upstream(tmp_path, empty)

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 0
        assert "nothing to publish upstream" in result.stdout

    def test_no_coverage_exits_before_cloning(self, tmp_path):
        """The empty check has to come first: cloning a large monorepo and then
        discovering there was nothing to publish is pure waste.

        This is the only test that can pin the order, because it deliberately
        omits UPSTREAM_CHECKOUT_DIR — the seam every other test uses to skip the
        clone. A `git` shim on PATH keeps it hermetic: if the ordering
        regresses, the clone runs and fails loudly instead of reaching GitHub.
        """
        root = build_overlay(tmp_path)
        empty = tmp_path / "no-coverage"
        empty.mkdir()
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "git"
        shim.write_text(
            "#!/usr/bin/env bash\n"
            'echo "git was called: $*" >&2\n'
            "exit 97\n"
        )
        shim.chmod(0o755)

        result = run_script(
            root / "scripts" / "upload-coverage-upstream.sh",
            WORKSPACE,
            str(empty),
            env={
                "PATH": f"{bin_dir}:/usr/bin:/bin",
                "CODECOV_RHDH_PLUGINS_TOKEN": "t",
            },
            cwd=root,
        )

        assert result.returncode == 0, result.stderr
        assert "nothing to publish upstream" in result.stdout
        assert "git was called" not in result.stderr


class TestDryRun:
    def test_dry_run_uploads_nothing_and_previews_the_arguments(
        self, tmp_path, coverage_dir
    ):
        """The preview is the whole value of a dry run — it is what a reviewer
        checks before authorising a real publish to a shared project."""
        result, stub, checkout, _ = run_upstream(
            tmp_path, coverage_dir, "--dry-run", env={"CODECOV_RHDH_PLUGINS_TOKEN": ""}
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 0
        assert "[DRY-RUN]" in result.stdout
        assert f"--slug {UPSTREAM_SLUG}" in result.stdout
        assert f"--sha {PINNED_REF}" in result.stdout
        assert f"--sha {upstream_head(checkout)}" in result.stdout
        assert f"--flag e2e-{WORKSPACE}" in result.stdout
        assert "--branch main" in result.stdout

    def test_dry_run_needs_no_token(self, tmp_path, coverage_dir):
        """So the remap can be exercised by anyone, including CI without the
        upstream project's secret."""
        result, _, _, _ = run_upstream(
            tmp_path, coverage_dir, "--dry-run", env={"CODECOV_RHDH_PLUGINS_TOKEN": ""}
        )
        assert result.returncode == 0, result.stderr

    def test_dry_run_composes_with_pinned_only(self, tmp_path, coverage_dir):
        """The documented first step of a staged rollout is both flags at once,
        so the pair has to preview exactly one target and upload nothing."""
        result, stub, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            "--dry-run",
            "--pinned-only",
            env={"CODECOV_RHDH_PLUGINS_TOKEN": ""},
        )

        assert result.returncode == 0, result.stderr
        assert call_count(stub) == 0
        assert result.stdout.count("[DRY-RUN] would upload") == 1
        assert f"--sha {PINNED_REF}" in result.stdout


class TestFlagVisibility:
    """A landed upload is not the same as a visible flag.

    A Codecov admin can DELETE a flag. The deletion is soft: uploads keep being
    accepted, the coverage stays in the report, and the v2 REST listing the
    upload check reads still returns the flag — but every UI surface hides it,
    because the GraphQL resolver behind them filters `deleted__isnot=True` and
    the REST one does not.

    That combination published e2e-orchestrator green twice while it was absent
    from the rhdh-plugins flag picker, and nothing in this script could tell.
    """

    FLAG = f"e2e-{WORKSPACE}"

    def _run(self, tmp_path, coverage_dir, graphql_api, **env):
        return run_upstream(
            tmp_path,
            coverage_dir,
            env={
                "CODECOV_UPLOADS_API": write_uploads_api(
                    tmp_path, [expected_session_name()]
                ),
                "CODECOV_GRAPHQL_API": graphql_api,
                "VERIFY_ATTEMPTS": "2",
                "VERIFY_DELAY_SECONDS": "0",
                **env,
            },
        )

    def test_a_visible_flag_is_confirmed(self, tmp_path, coverage_dir):
        result, _, _, _ = self._run(
            tmp_path, coverage_dir, write_graphql_api(tmp_path, [self.FLAG])
        )

        assert result.returncode == 0, result.stderr
        assert f"flag '{self.FLAG}' is visible" in result.stdout
        assert "deleted the flag" not in result.stderr

    def test_a_deleted_flag_is_reported(self, tmp_path, coverage_dir):
        """The upload landed and the dashboard shows nothing — the outcome that
        went unnoticed from 2026-08-17 to 2026-08-21."""
        result, _, _, _ = self._run(
            tmp_path, coverage_dir, write_graphql_api(tmp_path, [])
        )

        assert "deleted the flag" in result.stderr
        # Loud, but not fatal: the coverage IS published, and this needs a human
        # with Codecov admin rights rather than a red merge on main.
        assert result.returncode == 0, result.stderr

    def test_a_near_miss_name_does_not_count_as_visible(self, tmp_path, coverage_dir):
        """`term` is a SUBSTRING match server-side, so the answer can carry
        flags that merely contain the name. Matching loosely here would call a
        deleted `e2e-foo` visible on the strength of an `e2e-foo-legacy`."""
        result, _, _, _ = self._run(
            tmp_path, coverage_dir, write_graphql_api(tmp_path, [f"{self.FLAG}-legacy"])
        )

        assert "deleted the flag" in result.stderr

    def test_an_unreachable_endpoint_is_not_reported_as_a_deleted_flag(
        self, tmp_path, coverage_dir
    ):
        """The two read alike in a log and send whoever is debugging to opposite
        places — Codecov admin, or their own network."""
        result, _, _, _ = self._run(
            tmp_path, coverage_dir, f"file://{tmp_path}/no-such-endpoint.json"
        )

        assert "could not reach" in result.stderr
        assert "deleted the flag" not in result.stderr

    def test_a_graphql_error_is_not_reported_as_a_deleted_flag(
        self, tmp_path, coverage_dir
    ):
        """GraphQL answers its own errors with HTTP 200, a null `data` and an
        `errors` array — which curl --fail cannot see. Reading that as an empty
        flag list would accuse Codecov of deleting a perfectly live flag."""
        api = tmp_path / "gql-error.json"
        api.write_text(json.dumps({"errors": [{"message": "INTERNAL SERVER ERROR"}]}))

        result, _, _, _ = self._run(tmp_path, coverage_dir, f"file://{api}")

        assert "could not reach" in result.stderr
        assert "deleted the flag" not in result.stderr

    def test_an_unconfirmed_session_is_not_reported_as_a_deleted_flag(
        self, tmp_path, coverage_dir
    ):
        """The window between "upload accepted" and "upload processed".

        Codecov creates the RepositoryFlag row when it PROCESSES an upload, so
        in that window a perfectly healthy new flag genuinely is not in the
        visible list. Asking during it answers "a Codecov admin has deleted the
        flag ... re-running this job will not fix it" — categorical, actionable
        and false, and it would send someone to open a support ticket over a
        slow queue.

        Both fixtures here say "not there": the session never appears, and
        neither does the flag. The first is what must silence the second.
        """
        result, _, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            env={
                "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
                "CODECOV_GRAPHQL_API": write_graphql_api(tmp_path, []),
                "VERIFY_ATTEMPTS": "1",
                "VERIFY_DELAY_SECONDS": "0",
            },
        )

        assert result.returncode == 0, result.stderr
        # verify_landed still says its piece — the upload IS unconfirmed.
        assert "no session named" in result.stderr
        # But nothing accuses anyone of deleting a flag on that evidence.
        assert "deleted the flag" not in result.stderr
        assert "is visible" not in result.stdout

    def test_one_failed_and_one_unconfirmed_still_confirms_nothing(
        self, tmp_path, coverage_dir
    ):
        """The gap two independent comparisons leave open.

        A target lands in exactly one of FAILED_SHAS or UNVERIFIED_SHAS, so with
        two targets a failed upload plus an unconfirmed session satisfies
        `FAILED < 2` and `UNVERIFIED < 2` separately while confirming nothing —
        and the check would then run with no evidence the flag was ever
        registered. The gate has to be combined.

        exit_codes=(1, 1, 0) is the shape: UPLOAD_ATTEMPTS is 2, so the first
        target exhausts both attempts and fails, and the second uploads fine but
        never has its session confirmed by the empty uploads fixture.
        """
        result, _, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            exit_codes=(1, 1, 0),
            env={
                "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
                "CODECOV_GRAPHQL_API": write_graphql_api(tmp_path, []),
                "VERIFY_ATTEMPTS": "1",
                "VERIFY_DELAY_SECONDS": "0",
            },
        )

        # The run fails on the failed upload, which is correct and separate.
        assert result.returncode == 1
        assert "deleted the flag" not in result.stderr

    def test_a_dry_run_asks_nothing(self, tmp_path, coverage_dir):
        """Nothing reached Codecov, so there is no published flag to have an
        opinion about. The fixture says "not visible", which is the answer that
        WOULD warn — so a dry run that still asked would fail this."""
        result, _, _, _ = run_upstream(
            tmp_path,
            coverage_dir,
            "--dry-run",
            env={
                "CODECOV_GRAPHQL_API": write_graphql_api(tmp_path, []),
                "CODECOV_UPLOADS_API": write_uploads_api(tmp_path, []),
                "VERIFY_ATTEMPTS": "2",
                "VERIFY_DELAY_SECONDS": "0",
                "CODECOV_RHDH_PLUGINS_TOKEN": "",
            },
        )

        assert result.returncode == 0, result.stderr
        assert "deleted the flag" not in result.stderr

    def test_zero_attempts_switches_the_check_off(self, tmp_path, coverage_dir):
        """Same switch as the session check, and it has to mean the same thing:
        nothing was asked, so nothing is claimed either way."""
        result, _, _, _ = self._run(
            tmp_path,
            coverage_dir,
            write_graphql_api(tmp_path, []),
            VERIFY_ATTEMPTS="0",
        )

        assert result.returncode == 0, result.stderr
        assert "deleted the flag" not in result.stderr
        assert "is visible" not in result.stdout


def test_a_caller_supplied_checkout_survives_the_run(tmp_path, coverage_dir):
    """The cleanup trap removes the script's own temp dir. Deleting a checkout
    the caller handed in — or a test fixture — is not its to delete."""
    result, _, checkout, _ = run_upstream(tmp_path, coverage_dir)

    assert result.returncode == 0, result.stderr
    assert checkout.exists()
    assert (checkout / ".git").exists()
