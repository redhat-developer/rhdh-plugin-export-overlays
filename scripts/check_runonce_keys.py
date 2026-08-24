#!/usr/bin/env python3
"""Find `test.runOnce` keys that two Playwright projects would silently share.

`runOnce` writes its flag file into a directory keyed on the Playwright runner's PID
alone::

    const flagDir = path.join(os.tmpdir(), `playwright-once-${process.ppid}`);
    const flagFile = path.join(flagDir, `${key}.done`);

Nothing in that path comes from the project. So when one spec runs in **two** projects —
which is exactly what adding an ``-app-next`` lane does — the first project's setup
satisfies the second, and the second skips its own. For a block that deploys, that means
no deployment at all, and then a failure much later on a missing element with nothing
pointing back at the cause. It cost a review round on
``rhdh-plugin-export-overlays#3318``.

`deploy()` was never affected because its key carries the namespace
(``deploy-${namespace}``). The fix at a call site is the same: end the key with the
namespace. This check finds the call sites that have not.

It is deliberately conservative. A key is only reported when **both** of these hold:

* the workspace declares two or more Playwright projects that match the same spec — with
  ``testMatch`` on every project, the specs are already partitioned and no key is shared;
* the key is a plain string literal, so it cannot vary by project.

A literal key is not wrong in itself: setup that is genuinely shared — an operator
installed once into a fixed namespace every project then uses — *should* have one. That
is why the reason is printed with the file and line rather than the check simply
failing: the reader has to decide which of the two intents applies. Passing
``--allow <key>`` records that decision so the check stays quiet about it.

Usage::

    scripts/check_runonce_keys.py [--repo-root .] [--allow KEY ...]

Exits 1 when a shared-project key is found that is not allowed, 0 otherwise.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

#: `name: "<project>"` in a playwright.config.ts.
PROJECT_NAME = re.compile(r'name:\s*"([^"]+)"')

#: Any `testMatch:` entry, whatever its form (string, array or regex).
TEST_MATCH = re.compile(r"\btestMatch\s*:")

#: `runOnce("literal"` — with any whitespace, including newlines, between the paren and
#: the key. Prettier puts a long key on its own line, which is exactly the shape the
#: bug appeared in, so this must not be matched line by line. A template literal never
#: matches, which is the point: `${namespace}` is what makes a key vary by project.
RUN_ONCE_LITERAL = re.compile(r'runOnce\(\s*"([^"]+)"')


@dataclass
class Finding:
    workspace: str
    file: Path
    line: int
    key: str
    projects: list[str]


def projects_sharing_specs(config: Path) -> list[str] | None:
    """The project names, when they all match the same specs; ``None`` otherwise.

    A config that gives every project a ``testMatch`` has already partitioned its specs,
    so no two projects run the same file and no key can be shared. A single project
    cannot collide with itself.
    """
    text = config.read_text(encoding="utf-8")
    names = PROJECT_NAME.findall(text)
    if len(names) < 2:
        return None
    if len(TEST_MATCH.findall(text)) >= len(names):
        return None
    return names


def find(repo_root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for config in sorted(repo_root.glob("workspaces/*/e2e-tests/playwright.config.ts")):
        e2e_root = config.parent
        projects = projects_sharing_specs(config)
        if not projects:
            continue
        for source in sorted(e2e_root.rglob("*.ts")):
            if "node_modules" in source.parts:
                continue
            text = source.read_text(encoding="utf-8")
            # Searched over the whole file, not line by line: Prettier moves a long key
            # onto its own line, and that is the shape the bug actually appeared in.
            for match in RUN_ONCE_LITERAL.finditer(text):
                findings.append(
                    Finding(
                        workspace=e2e_root.parent.name,
                        file=source.relative_to(repo_root),
                        line=text.count("\n", 0, match.start()) + 1,
                        key=match.group(1),
                        projects=projects,
                    )
                )
    return findings


def render(findings: list[Finding]) -> str:
    lines = []
    for f in findings:
        lines.append(f'{f.file}:{f.line}  runOnce("{f.key}")')
        lines.append(
            f"    {f.workspace} runs {len(f.projects)} projects over the same specs "
            f"({', '.join(f.projects)}), so this key is shared between them."
        )
        lines.append(
            "    If the setup belongs to one project, end the key with "
            "`-${rhdh.deploymentConfig.namespace}`, as deploy() does. If it is genuinely "
            "shared, pass --allow to record that."
        )
        lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", default=".")
    parser.add_argument(
        "--allow",
        action="append",
        default=[],
        metavar="KEY",
        help="a key that is deliberately shared by every project; repeatable",
    )
    args = parser.parse_args(argv)

    findings = [f for f in find(Path(args.repo_root)) if f.key not in args.allow]
    if not findings:
        print("no runOnce key is shared between projects that run the same specs")
        return 0

    print(render(findings), end="")
    print(
        f"{len(findings)} runOnce key(s) would be shared across projects. "
        "The second project skips the setup and reports nothing."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
