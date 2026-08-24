"""Tests for scripts/check_runonce_keys.py — a runOnce key two projects would share.

``runOnce`` keys its flag file by the key string alone, in a directory keyed on the
Playwright runner's PID. Nothing in that path comes from the project, so when one spec
runs in two projects the first project's setup satisfies the second and the second
silently skips its own — no deployment, and a failure much later on a missing element.
That is what happened on #3318.

The check has to be quiet on the repo as it stands and loud on that shape, and the
distinction is not "literal key = bad": a literal key is exactly right for setup that is
genuinely shared, like installing an operator into a fixed namespace every project then
uses. These tests pin both halves, and the two shapes that made the original bug
invisible: a key Prettier moved onto its own line, and a config where only *some*
projects carry a ``testMatch``.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from check_runonce_keys import find, main  # noqa: E402


def workspace(root: Path, name: str, config: str, spec: str = "") -> None:
    e2e = root / "workspaces" / name / "e2e-tests"
    (e2e / "tests" / "specs").mkdir(parents=True, exist_ok=True)
    (e2e / "playwright.config.ts").write_text(config)
    if spec:
        (e2e / "tests" / "specs" / f"{name}.spec.ts").write_text(spec)


def config(*projects: str, test_match: bool = False) -> str:
    entries = []
    for p in projects:
        match = f'\n      testMatch: "{p}.spec.ts",' if test_match else ""
        entries.append(f'    {{\n      name: "{p}",{match}\n    }}')
    return "export default defineConfig({\n  projects: [\n" + ",\n".join(entries) + "\n  ],\n});\n"


LITERAL = 'test.beforeAll(async ({ rhdh }) => {\n  await test.runOnce("ws-setup", async () => {\n    await rhdh.deploy();\n  });\n});\n'
NAMESPACED = 'test.beforeAll(async ({ rhdh }) => {\n  await test.runOnce(`ws-setup-${rhdh.deploymentConfig.namespace}`, async () => {\n    await rhdh.deploy();\n  });\n});\n'


class TestWhenItFires:
    @staticmethod
    def test_a_literal_key_in_a_two_project_workspace_is_reported(tmp_path):
        workspace(tmp_path, "ws", config("ws", "ws-app-next"), LITERAL)
        findings = find(tmp_path)
        assert [f.key for f in findings] == ["ws-setup"]
        assert findings[0].projects == ["ws", "ws-app-next"]

    @staticmethod
    def test_a_key_on_its_own_line_is_reported(tmp_path):
        # Prettier moves a long key onto the next line, which is the shape the bug
        # actually appeared in — a line-by-line scan misses it entirely.
        spec = (
            "test.beforeAll(async ({ rhdh }) => {\n"
            "  await test.runOnce(\n"
            '    "ws-setup-with-a-rather-long-name",\n'
            "    async () => {\n"
            "      await rhdh.deploy();\n"
            "    },\n"
            "  );\n"
            "});\n"
        )
        workspace(tmp_path, "ws", config("ws", "ws-app-next"), spec)
        assert [f.key for f in find(tmp_path)] == ["ws-setup-with-a-rather-long-name"]

    @staticmethod
    def test_a_partially_matched_config_still_shares_specs(tmp_path):
        # Two of three projects carry a testMatch: the third still matches everything,
        # so it runs the same specs as the ones that do. Counting testMatch entries
        # against the project count is what catches this.
        cfg = (
            "export default defineConfig({\n  projects: [\n"
            '    { name: "ws", testMatch: "ws.spec.ts" },\n'
            '    { name: "ws-other", testMatch: "other.spec.ts" },\n'
            '    { name: "ws-app-next" },\n'
            "  ],\n});\n"
        )
        workspace(tmp_path, "ws", cfg, LITERAL)
        assert [f.key for f in find(tmp_path)] == ["ws-setup"]

    @staticmethod
    def test_it_reports_the_line_the_key_is_on(tmp_path):
        workspace(tmp_path, "ws", config("ws", "ws-app-next"), "\n\n" + LITERAL)
        assert find(tmp_path)[0].line == 4


class TestWhenItStaysQuiet:
    @staticmethod
    def test_a_namespaced_key_is_fine(tmp_path):
        workspace(tmp_path, "ws", config("ws", "ws-app-next"), NAMESPACED)
        assert find(tmp_path) == []

    @staticmethod
    def test_one_project_cannot_collide_with_itself(tmp_path):
        workspace(tmp_path, "ws", config("ws"), LITERAL)
        assert find(tmp_path) == []

    @staticmethod
    def test_test_match_on_every_project_partitions_the_specs(tmp_path):
        # No two projects run the same file, so no key is shared however literal it is.
        workspace(tmp_path, "ws", config("ws", "ws-other", test_match=True), LITERAL)
        assert find(tmp_path) == []

    @staticmethod
    def test_node_modules_is_not_scanned(tmp_path):
        workspace(tmp_path, "ws", config("ws", "ws-app-next"))
        vendored = tmp_path / "workspaces/ws/e2e-tests/node_modules/pkg"
        vendored.mkdir(parents=True)
        (vendored / "index.ts").write_text(LITERAL)
        assert find(tmp_path) == []


class TestAllowList:
    @staticmethod
    def test_an_allowed_key_does_not_fail_the_check(tmp_path, capsys):
        # The real case: bulk-import installs an orchestrator workflow into a fixed
        # `orchestrator` namespace that every project then uses. One install is correct,
        # so the literal key is correct, and saying so should silence the check.
        workspace(tmp_path, "ws", config("ws", "ws-app-next"), LITERAL)
        assert main(["--repo-root", str(tmp_path), "--allow", "ws-setup"]) == 0
        assert "no runOnce key is shared" in capsys.readouterr().out

    @staticmethod
    def test_allowing_one_key_does_not_allow_another(tmp_path, capsys):
        spec = LITERAL + LITERAL.replace("ws-setup", "ws-other-setup")
        workspace(tmp_path, "ws", config("ws", "ws-app-next"), spec)
        assert main(["--repo-root", str(tmp_path), "--allow", "ws-setup"]) == 1
        out = capsys.readouterr().out
        assert "ws-other-setup" in out
        assert '"ws-setup"' not in out


class TestOutput:
    @staticmethod
    def test_a_finding_names_the_fix_and_the_escape_hatch(tmp_path, capsys):
        workspace(tmp_path, "ws", config("ws", "ws-app-next"), LITERAL)
        assert main(["--repo-root", str(tmp_path)]) == 1
        out = capsys.readouterr().out
        assert "rhdh.deploymentConfig.namespace" in out
        assert "--allow" in out
        assert "ws, ws-app-next" in out

    @staticmethod
    def test_a_clean_repo_passes_and_says_so(tmp_path, capsys):
        workspace(tmp_path, "ws", config("ws", "ws-app-next"), NAMESPACED)
        assert main(["--repo-root", str(tmp_path)]) == 0
        assert "no runOnce key is shared" in capsys.readouterr().out
