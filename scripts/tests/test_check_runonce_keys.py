"""Tests for scripts/check_runonce_keys.py — a runOnce key two projects would share.

``runOnce`` keys its flag file by the key string alone, in a directory keyed on the
Playwright runner's PID. Nothing in that path comes from the project, so when one spec
runs in two projects the first project's setup satisfies the second and the second
silently skips its own — no deployment, and a failure much later on a missing element.
That is what happened on #3318.

The check has to be quiet on the repo as it stands and loud on that shape. Two things
make it hard, and both are pinned here because the first attempt got both wrong:

* **A shared spec is not the same as a workspace without ``testMatch``.** ``bulk-import``
  gives ``bulk-import`` and ``bulk-import-app-next`` the *same* ``testMatch`` — counting
  matchers against the project count reads that as partitioned and skips the workspace
  where the bug actually happened.
* **The unit is the file, not the workspace.** ``bulk-import`` runs three projects but
  only two reach ``bulk-import.spec.ts``; a key in the orchestrator spec is shared with
  nothing, and reporting it would be noise that costs the check its credibility.

A literal key is also not wrong in itself — setup genuinely shared by every project,
like an operator in a fixed namespace, should have one. That is why findings explain
themselves and ``--allow`` exists.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from check_runonce_keys import find, main, parse_matcher  # noqa: E402


def workspace(root: Path, name: str, projects: str, specs: dict[str, str]) -> None:
    e2e = root / "workspaces" / name / "e2e-tests"
    (e2e / "tests" / "specs").mkdir(parents=True, exist_ok=True)
    (e2e / "playwright.config.ts").write_text(
        f"export default defineConfig({{\n  projects: [\n{projects}\n  ],\n}});\n"
    )
    for spec_name, body in specs.items():
        (e2e / "tests" / "specs" / spec_name).write_text(body)


def project(name: str, test_match: str | None = None) -> str:
    match = f"\n      testMatch: {test_match}," if test_match else ""
    return f'    {{\n      name: "{name}",{match}\n    }}'


def literal(key: str = "ws-setup", quote: str = '"') -> str:
    return (
        "test.beforeAll(async ({ rhdh }) => {\n"
        f"  await test.runOnce({quote}{key}{quote}, async () => {{\n"
        "    await rhdh.deploy();\n"
        "  });\n"
        "});\n"
    )


NAMESPACED = (
    "test.beforeAll(async ({ rhdh }) => {\n"
    "  await test.runOnce(`ws-setup-${rhdh.deploymentConfig.namespace}`, async () => {\n"
    "    await rhdh.deploy();\n"
    "  });\n"
    "});\n"
)

BOTH = project("ws") + ",\n" + project("ws-app-next")


class TestWhenItFires:
    @staticmethod
    def test_two_projects_with_no_test_match_share_every_spec(tmp_path):
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": literal()})
        findings = find(tmp_path)
        assert [f.key for f in findings] == ["ws-setup"]
        assert findings[0].projects == ["ws", "ws-app-next"]

    @staticmethod
    def test_two_projects_naming_the_same_spec_share_it(tmp_path):
        # The bulk-import shape. Counting matchers against the project count calls this
        # partitioned and skips the workspace where the bug happened.
        projects = (
            project("ws", '"ws.spec.ts"')
            + ",\n"
            + project("ws-app-next", '"ws.spec.ts"')
        )
        workspace(tmp_path, "ws", projects, {"ws.spec.ts": literal()})
        assert [f.key for f in find(tmp_path)] == ["ws-setup"]

    @staticmethod
    def test_a_single_quoted_key_is_not_a_way_out(tmp_path):
        # A check whose whole value is not passing silently must not be defeated by a
        # quote character.
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": literal(quote="'")})
        assert [f.key for f in find(tmp_path)] == ["ws-setup"]

    @staticmethod
    def test_a_key_on_its_own_line_is_reported_at_the_call(tmp_path):
        # Prettier moves a long key onto the next line, which is the shape the bug
        # appeared in — a line-by-line scan misses it entirely.
        spec = (
            "\ntest.beforeAll(async ({ rhdh }) => {\n"
            "  await test.runOnce(\n"
            '    "ws-setup-with-a-rather-long-name",\n'
            "    async () => {\n"
            "      await rhdh.deploy();\n"
            "    },\n"
            "  );\n"
            "});\n"
        )
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": spec})
        found = find(tmp_path)
        assert [f.key for f in found] == ["ws-setup-with-a-rather-long-name"]
        # The runOnce( call, not the key a line below it — that is where a reader
        # clicking file:line wants to land.
        assert found[0].line == 3

    @staticmethod
    def test_one_project_without_a_matcher_shares_with_every_other(tmp_path):
        projects = (
            project("ws", '"ws.spec.ts"')
            + ",\n"
            + project("ws-other", '"other.spec.ts"')
            + ",\n"
            + project("ws-app-next")
        )
        workspace(tmp_path, "ws", projects, {"ws.spec.ts": literal()})
        assert [f.key for f in find(tmp_path)] == ["ws-setup"]


class TestWhenItStaysQuiet:
    @staticmethod
    def test_a_namespaced_key_is_fine(tmp_path):
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": NAMESPACED})
        assert find(tmp_path) == []

    @staticmethod
    def test_one_project_cannot_collide_with_itself(tmp_path):
        workspace(tmp_path, "ws", project("ws"), {"ws.spec.ts": literal()})
        assert find(tmp_path) == []

    @staticmethod
    def test_a_spec_only_one_project_reaches_is_not_shared(tmp_path):
        # bulk-import runs three projects; only two reach bulk-import.spec.ts. A key in
        # the orchestrator spec is shared with nothing, and flagging it is noise.
        projects = (
            project("ws", '"ws.spec.ts"')
            + ",\n"
            + project("ws-app-next", '"ws.spec.ts"')
            + ",\n"
            + project("ws-solo", '"solo.spec.ts"')
        )
        workspace(
            tmp_path, "ws", projects, {"ws.spec.ts": NAMESPACED, "solo.spec.ts": literal()}
        )
        assert find(tmp_path) == []

    @staticmethod
    def test_distinct_matchers_partition_the_specs(tmp_path):
        projects = (
            project("ws", '"ws.spec.ts"')
            + ",\n"
            + project("ws-other", '"other.spec.ts"')
        )
        workspace(
            tmp_path,
            "ws",
            projects,
            {"ws.spec.ts": literal(), "other.spec.ts": literal("other-setup")},
        )
        assert find(tmp_path) == []

    @staticmethod
    def test_a_match_spanning_lines_is_not_a_key(tmp_path):
        # A TypeScript string literal cannot contain a raw newline, so this is a parse
        # artefact rather than a key. Printing it would put a pull request's own text at
        # the start of a line in CI output, where `::error::` is a workflow command and
        # not a string — verified before the fix by emitting a forged annotation.
        spec = 'await test.runOnce("x\n::error::forged\n", async () => {});\n'
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": spec})
        assert find(tmp_path) == []

    @staticmethod
    def test_node_modules_is_not_scanned(tmp_path):
        workspace(tmp_path, "ws", BOTH, {})
        vendored = tmp_path / "workspaces/ws/e2e-tests/node_modules/pkg"
        vendored.mkdir(parents=True)
        (vendored / "index.ts").write_text(literal())
        assert find(tmp_path) == []


class TestMatcherForms:
    """Every form the repo actually uses reduces to a path fragment."""

    @staticmethod
    def test_a_bare_string(tmp_path):
        assert parse_matcher('"bulk-import.spec.ts",') == ["bulk-import.spec.ts"]

    @staticmethod
    def test_a_glob(tmp_path):
        assert parse_matcher('"**/tests/specs/default-global-header.spec.ts",') == [
            "tests/specs/default-global-header.spec.ts"
        ]

    @staticmethod
    def test_a_regex_literal(tmp_path):
        # backstage writes every matcher this way.
        assert parse_matcher(r"/tests\/specs\/auth\.spec\.ts/,") == [
            "tests/specs/auth.spec.ts"
        ]

    @staticmethod
    def test_an_array(tmp_path):
        assert parse_matcher('["lightspeed.spec.ts", "notebook.spec.ts"],') == [
            "lightspeed.spec.ts",
            "notebook.spec.ts",
        ]

    @staticmethod
    def test_an_unreadable_matcher_makes_the_project_match_everything(tmp_path):
        # The cautious direction: a finding to read costs less than a collision that
        # ships. Nothing in the repo takes this path today.
        assert parse_matcher("someImportedPattern,") == []


class TestAllowList:
    @staticmethod
    def test_an_allowed_key_does_not_fail_the_check(tmp_path, capsys):
        # bulk-import installs an orchestrator workflow into a fixed namespace every
        # project then uses. One install is correct, so one key is correct.
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": literal()})
        assert main(["--repo-root", str(tmp_path), "--allow", "ws-setup"]) == 0
        assert "no runOnce key is shared" in capsys.readouterr().out

    @staticmethod
    def test_allowing_one_key_does_not_allow_another(tmp_path, capsys):
        spec = literal() + literal("ws-other-setup")
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": spec})
        assert main(["--repo-root", str(tmp_path), "--allow", "ws-setup"]) == 1
        out = capsys.readouterr().out
        assert "ws-other-setup" in out
        assert '"ws-setup"' not in out


class TestOutput:
    @staticmethod
    def test_a_finding_names_the_fix_the_projects_and_the_escape_hatch(tmp_path, capsys):
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": literal()})
        assert main(["--repo-root", str(tmp_path)]) == 1
        out = capsys.readouterr().out
        assert "rhdh.deploymentConfig.namespace" in out
        assert "--allow" in out
        assert "ws, ws-app-next" in out

    @staticmethod
    def test_a_clean_repo_passes_and_says_so(tmp_path, capsys):
        workspace(tmp_path, "ws", BOTH, {"ws.spec.ts": NAMESPACED})
        assert main(["--repo-root", str(tmp_path)]) == 0
        assert "no runOnce key is shared" in capsys.readouterr().out
