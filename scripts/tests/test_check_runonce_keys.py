"""Tests for scripts/check_runonce_keys.py — a runOnce key two projects would share.

``runOnce`` keys its flag file by the key string alone, in a directory keyed on the
Playwright runner's PID. Nothing in that path comes from the project, so when one spec
runs in two projects the first project's setup satisfies the second and the second
silently skips its own — no deployment, and a failure much later on a missing element.
That is what happened on #3318.

What these mostly pin is the direction the parser fails in. It reads TypeScript with
regexes and brace counting, which is approximate, and every approximation here had a
version that failed *quietly*: a project entry with a nested object dropped the project,
a matcher with a metacharacter dropped every file, a key extracted to a `const` matched
nothing. All of those returned "clean" — the one answer this check must never give
without being sure. So the tests are written around inputs the parser might not
understand, not only around inputs it does.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from check_runonce_keys import ParseError, find, main, parse_matcher, projects_in


def workspace(root: Path, name: str, projects: str, specs: dict[str, str]) -> Path:
    e2e = root / "workspaces" / name / "e2e-tests"
    (e2e / "tests").mkdir(parents=True, exist_ok=True)
    (e2e / "playwright.config.ts").write_text(
        f"export default defineConfig({{\n  projects: [\n{projects}\n  ],\n}});\n"
    )
    for spec_name, body in specs.items():
        target = e2e / "tests" / spec_name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)
    return e2e


def project(name: str, test_match: str | None = None, extra: str = "") -> str:
    match = f"\n      testMatch: {test_match}," if test_match else ""
    return f'    {{\n      name: "{name}",{match}{extra}\n    }}'


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


class TestSharedSpecs:
    @staticmethod
    def test_two_projects_with_no_matcher_share_every_spec(tmp_path):
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": literal()})
        found = find(tmp_path)
        assert [f.key for f in found] == ["ws-setup"]
        assert "ws, ws-app-next" in found[0].reason

    @staticmethod
    def test_two_projects_naming_the_same_spec_share_it(tmp_path):
        # The bulk-import shape: same testMatch on two projects. Counting matchers
        # against the project count read this as partitioned and skipped the workspace
        # where the bug actually happened.
        projects = (
            project("ws", '"ws.spec.ts"') + ",\n" + project("ws-app-next", '"ws.spec.ts"')
        )
        workspace(tmp_path, "ws", projects, {"specs/ws.spec.ts": literal()})
        assert [f.key for f in find(tmp_path)] == ["ws-setup"]

    @staticmethod
    def test_a_key_in_a_shared_helper_belongs_to_every_project(tmp_path):
        # No project's testMatch names a helper, so it is imported from every project's
        # specs. backstage gives all 13 of its projects a testMatch — without this, a
        # literal key in its shared helpers is invisible, and the repo already puts
        # runOnce in helpers.
        projects = (
            project("ws", '"a.spec.ts"') + ",\n" + project("ws2", '"b.spec.ts"')
        )
        workspace(
            tmp_path,
            "ws",
            projects,
            {"specs/a.spec.ts": "x\n", "specs/b.spec.ts": "y\n", "support/setup.ts": literal()},
        )
        assert [f.key for f in find(tmp_path)] == ["ws-setup"]

    @staticmethod
    def test_a_spec_only_one_project_reaches_is_not_shared(tmp_path):
        projects = (
            project("ws", '"ws.spec.ts"')
            + ",\n"
            + project("ws-app-next", '"ws.spec.ts"')
            + ",\n"
            + project("ws-solo", '"solo.spec.ts"')
        )
        workspace(
            tmp_path,
            "ws",
            projects,
            {"specs/ws.spec.ts": NAMESPACED, "specs/solo.spec.ts": literal()},
        )
        assert find(tmp_path) == []

    @staticmethod
    def test_the_same_key_in_two_workspaces_collides_in_a_root_run(tmp_path):
        # run-e2e.sh runs every workspace in one Playwright process, so one flag
        # directory covers all of them — single-project workspaces included.
        for name in ("alpha", "beta"):
            workspace(tmp_path, name, project(name), {"specs/s.spec.ts": literal("keycloak-groups")})
        found = find(tmp_path)
        assert [f.key for f in found] == ["keycloak-groups"]
        assert "alpha, beta" in found[0].workspace


class TestParsingFailsLoudly:
    @staticmethod
    def test_a_project_entry_with_a_nested_object_is_still_read(tmp_path):
        # `use: { ... }` is the first thing anyone adds. A regex stopping at the first
        # `}` drops the project; one spanning a nested pair swallows defineConfig and
        # reads every project as one. Both come out "clean".
        projects = (
            project("ws", extra="\n      use: { viewport: { width: 1 } },")
            + ",\n"
            + project("ws-app-next")
        )
        e2e = workspace(tmp_path, "ws", projects, {"specs/ws.spec.ts": literal()})
        assert [p.name for p in projects_in(e2e / "playwright.config.ts")] == [
            "ws",
            "ws-app-next",
        ]
        assert [f.key for f in find(tmp_path)] == ["ws-setup"]

    @staticmethod
    def test_a_project_it_cannot_read_raises_instead_of_vanishing(tmp_path):
        e2e = workspace(tmp_path, "ws", BOTH, {})
        config = e2e / "playwright.config.ts"
        # A shape the brace counter does not reach: a name outside any entry.
        config.write_text(config.read_text().replace("  ],", '    name: "ws-orphan",\n  ],'))
        with pytest.raises(ParseError, match="silently drop out"):
            projects_in(config)

    @staticmethod
    def test_a_single_quoted_project_name_does_not_erase_the_workspace(tmp_path):
        projects = "    { name: 'ws' },\n    { name: 'ws-app-next' }"
        workspace(tmp_path, "ws", projects, {"specs/ws.spec.ts": literal()})
        assert [f.key for f in find(tmp_path)] == ["ws-setup"]

    @staticmethod
    def test_a_root_that_is_not_a_directory_is_rejected(tmp_path):
        # A typo'd --repo-root would otherwise glob nothing and read as a clean tree,
        # which is the same silence this whole check exists to remove.
        with pytest.raises(ParseError, match="not a directory"):
            find(tmp_path / "does-not-exist")

        a_file = tmp_path / "root.txt"
        a_file.write_text("")
        with pytest.raises(ParseError, match="not a directory"):
            find(a_file)

    @staticmethod
    def test_a_repo_with_no_configs_is_not_a_clean_repo(tmp_path):
        # Scanning nothing and finding nothing are different answers. The workflow step
        # relies on the default --repo-root, so a future working-directory change would
        # otherwise turn the gate into a green no-op.
        with pytest.raises(ParseError, match="Nothing was scanned"):
            find(tmp_path)


class TestKeysThatAreNotLiterals:
    @staticmethod
    def test_a_key_extracted_to_a_const_is_reported(tmp_path):
        # The natural refactor, and it used to walk straight past the check.
        spec = 'const KEY = "ws-setup";\nawait test.runOnce(KEY, async () => {});\n'
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": spec})
        found = find(tmp_path)
        assert [f.key for f in found] == ["KEY"]
        assert "not a literal" in found[0].reason

    @staticmethod
    def test_a_template_that_does_not_vary_by_project_is_reported(tmp_path):
        # Being a template is not the point; varying by project is.
        spec = "await test.runOnce(`${WORKSPACE}-setup`, async () => {});\n"
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": spec})
        assert "does not vary by project" in find(tmp_path)[0].reason

    @staticmethod
    @pytest.mark.parametrize(
        "key",
        [
            "`s-${rhdh.deploymentConfig.namespace}`",
            "`s-${namespace}`",
            "`s-${lightspeedNamespace}`",
            "`s-${testInfo.project.name}`",
        ],
    )
    def test_every_varying_template_the_repo_uses_stays_quiet(tmp_path, key):
        workspace(
            tmp_path, "ws", BOTH, {"specs/ws.spec.ts": f"await test.runOnce({key}, async () => {{}});\n"}
        )
        assert find(tmp_path) == []

    @staticmethod
    def test_a_namespace_held_in_a_local_alias_still_counts(tmp_path):
        # intelligent-assistant does exactly this, and matching only the literal word
        # "namespace" called a correct key a collision — a false positive on an open PR
        # is how a check like this loses the room.
        spec = (
            "const ns = rhdh.deploymentConfig.namespace;\n"
            "await test.runOnce(`ws-deploy-${ns}`, async () => {});\n"
        )
        workspace(tmp_path, "ws", BOTH, {"support/helper.ts": spec})
        assert find(tmp_path) == []

    @staticmethod
    def test_an_alias_from_another_file_does_not_count(tmp_path):
        # The alias has to be visible where the key is written; otherwise any file that
        # names a variable `ns` would launder an unrelated key.
        workspace(
            tmp_path,
            "ws",
            BOTH,
            {
                "support/other.ts": "const ns = rhdh.deploymentConfig.namespace;\n",
                "support/helper.ts": "await test.runOnce(`ws-deploy-${ns}`, async () => {});\n",
            },
        )
        assert len(find(tmp_path)) == 1
    @staticmethod
    def test_a_key_spanning_lines_cannot_forge_ci_output(tmp_path, capsys):
        # A TypeScript string cannot contain a raw newline, so this is not a key — it is
        # reported as unreadable, which is the loud direction. What it must not do is
        # reach stdout with the newline intact: GitHub Actions reads a line beginning
        # `::` as a workflow command, and an earlier version emitted a forged annotation
        # into the job log.
        spec = 'await test.runOnce("x\n::error::forged\n", async () => {});\n'
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": spec})
        assert "not a literal" in find(tmp_path)[0].reason

        main(["--repo-root", str(tmp_path)])
        printed = capsys.readouterr().out
        assert "::error::forged" in printed  # still visible to a human
        assert not any(line.startswith("::") for line in printed.splitlines())

    @staticmethod
    def test_a_key_on_its_own_line_is_reported_at_the_call(tmp_path):
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
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": spec})
        found = find(tmp_path)
        assert [f.key for f in found] == ["ws-setup-with-a-rather-long-name"]
        # The runOnce( call, not the key a line below it — that is where a reader
        # clicking file:line wants to land.
        assert found[0].line == 3


class TestMatcherForms:
    """Every form the repo uses reduces to a path fragment; anything else to nothing."""

    @staticmethod
    def test_a_bare_string():
        assert parse_matcher('"bulk-import.spec.ts",') == ["bulk-import.spec.ts"]

    @staticmethod
    def test_a_leading_glob():
        assert parse_matcher('"**/tests/specs/default-global-header.spec.ts",') == [
            "tests/specs/default-global-header.spec.ts"
        ]

    @staticmethod
    def test_a_regex_literal():
        assert parse_matcher(r"/tests\/specs\/auth\.spec\.ts/,") == [
            "tests/specs/auth.spec.ts"
        ]

    @staticmethod
    def test_an_array():
        assert parse_matcher('["lightspeed.spec.ts", "notebook.spec.ts"],') == [
            "lightspeed.spec.ts",
            "notebook.spec.ts",
        ]

    @staticmethod
    def test_a_matcher_split_across_lines():
        # roadie-backstage-plugins is written this way, and it is the same trap the
        # runOnce side already has a test for.
        assert parse_matcher('\n        "roadie.spec.ts",\n') == ["roadie.spec.ts"]

    @staticmethod
    @pytest.mark.parametrize(
        "value", [r"/tests\/specs\/.*\.spec\.ts/,", '"**/specs/*.spec.ts",', '"a|b",']
    )
    def test_a_metacharacter_yields_nothing_rather_than_junk(value):
        # Stripping `*` out of `**/specs/*.spec.ts` leaves `specs/.spec.ts`, which
        # matches no real path — the project would silently reach no file at all.
        # Nothing means "matches everything", which is the cautious direction.
        assert parse_matcher(value) == []


class TestAllowing:
    @staticmethod
    def test_an_allowed_key_does_not_fail_the_check(tmp_path, capsys):
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": literal()})
        assert main(["--repo-root", str(tmp_path), "--allow", "ws-setup"]) == 0
        assert "no runOnce key is shared" in capsys.readouterr().out

    @staticmethod
    def test_the_allow_file_is_read_and_takes_comments(tmp_path, capsys):
        # The escape hatch has to live next to the code, not in the workflow that runs
        # the check.
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": literal()})
        (tmp_path / "scripts").mkdir()
        (tmp_path / "scripts" / "runonce-shared-keys.txt").write_text(
            "# one operator for every project\nws-setup  # RHIDP-16456\n"
        )
        assert main(["--repo-root", str(tmp_path)]) == 0
        capsys.readouterr()

    @staticmethod
    def test_an_allow_file_reached_through_a_symlink_is_refused(tmp_path, capsys):
        # The file name is a constant, so the only way out of the root is a symlinked
        # scripts/ — which is exactly why the join is checked rather than trusted.
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": literal()})
        outside = tmp_path.parent / f"outside-{tmp_path.name}"
        outside.mkdir()
        (outside / "runonce-shared-keys.txt").write_text("ws-setup\n")
        (tmp_path / "scripts").symlink_to(outside, target_is_directory=True)

        assert main(["--repo-root", str(tmp_path)]) == 2
        assert "must sit inside" in capsys.readouterr().err

    @staticmethod
    def test_allowing_one_key_does_not_allow_another(tmp_path, capsys):
        spec = literal() + literal("ws-other-setup")
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": spec})
        assert main(["--repo-root", str(tmp_path), "--allow", "ws-setup"]) == 1
        out = capsys.readouterr().out
        assert "ws-other-setup" in out
        assert '"ws-setup"' not in out


class TestOutput:
    @staticmethod
    def test_a_finding_names_the_fix_and_the_escape_hatch(tmp_path, capsys):
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": literal()})
        assert main(["--repo-root", str(tmp_path)]) == 1
        out = capsys.readouterr().out
        assert "rhdh.deploymentConfig.namespace" in out
        assert "runonce-shared-keys.txt" in out

    @staticmethod
    def test_an_unreadable_tree_exits_two_not_one(tmp_path, capsys):
        # Distinct from "found something": one means fix a key, two means fix the check
        # or the invocation.
        assert main(["--repo-root", str(tmp_path)]) == 2
        assert "Nothing was scanned" in capsys.readouterr().err

    @staticmethod
    def test_a_clean_repo_passes_and_says_so(tmp_path, capsys):
        workspace(tmp_path, "ws", BOTH, {"specs/ws.spec.ts": NAMESPACED})
        assert main(["--repo-root", str(tmp_path)]) == 0
        assert "no runOnce key is shared" in capsys.readouterr().out

    @staticmethod
    def test_node_modules_is_not_scanned(tmp_path):
        workspace(tmp_path, "ws", BOTH, {})
        vendored = tmp_path / "workspaces/ws/e2e-tests/node_modules/pkg"
        vendored.mkdir(parents=True)
        (vendored / "index.ts").write_text(literal())
        assert find(tmp_path) == []
