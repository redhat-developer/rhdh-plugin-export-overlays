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

#: One `{ ... }` entry in the `projects` array. Entries are flat in every config here —
#: name, testMatch, timeout — so a non-greedy match to the closing brace is enough.
PROJECT_ENTRY = re.compile(r"\{([^{}]*)\}")

#: `name: "<project>"` inside such an entry.
PROJECT_NAME = re.compile(r'name:\s*"([^"]+)"')

#: The value of a `testMatch:`, whatever its form — string, array or regex — to the end
#: of the line. Compared as text, so two projects naming the same spec are seen to.
TEST_MATCH_VALUE = re.compile(r"testMatch\s*:\s*(.+)")

#: `runOnce("literal"` or `runOnce('literal'`, with any whitespace — newlines included —
#: between the paren and the key. Prettier puts a long key on its own line, which is the
#: shape the bug appeared in, so this must not be matched line by line. Both quote
#: styles, because a check whose whole value is not passing silently must not be
#: defeated by a quote character. A template literal never matches, which is the point:
#: `${namespace}` is what makes a key vary by project. The key may not span lines: a
#: TypeScript string literal cannot contain a raw newline, so a multi-line match is a
#: parse artefact rather than a key — and printing one would put a pull request's own
#: text at the start of a line in CI output, where `::error::` is a workflow command
#: rather than a string.
RUN_ONCE_LITERAL = re.compile(r"""runOnce\(\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')""")


@dataclass
class Project:
    name: str
    #: `testMatch` values as written; empty when the project declares none, which in
    #: Playwright means it matches every spec.
    matchers: list[str]

    def matches(self, path: Path) -> bool:
        if not self.matchers:
            return True
        posix = path.as_posix()
        return any(needle in posix for needle in self.matchers)


@dataclass
class Finding:
    workspace: str
    file: Path
    line: int
    key: str
    projects: list[str]


def parse_matcher(value: str) -> list[str]:
    """The path fragments a `testMatch` value would match on.

    Three forms appear in this repo and all reduce to the same thing — a fragment of the
    spec's path: a bare string (`"bulk-import.spec.ts"`), a glob
    (`"**/tests/specs/x.spec.ts"`), and a regex literal (`/tests\\/specs\\/x\\.spec\\.ts/`).
    Globs and regex escapes are stripped rather than interpreted: the question here is
    only whether two projects can reach the same file, and every matcher in this repo
    names its spec literally. A matcher this cannot read yields nothing, which makes the
    project match everything — the cautious direction, since the cost is a finding to
    read rather than a collision that ships.
    """
    fragments = re.findall(r"""["']([^"']+)["']|/((?:[^/\\]|\\.)+)/""", value)
    out = []
    for quoted, regex in fragments:
        raw = quoted or regex.replace("\\", "")
        out.append(raw.replace("**/", "").replace("*", "").strip("/"))
    return [f for f in out if f]


def projects_in(config: Path) -> list[Project]:
    """Every Playwright project the config declares, with what it matches on."""
    text = config.read_text(encoding="utf-8")
    projects: list[Project] = []
    for entry in PROJECT_ENTRY.finditer(text):
        body = entry.group(1)
        name = PROJECT_NAME.search(body)
        if not name:
            continue
        matcher = TEST_MATCH_VALUE.search(body)
        projects.append(
            Project(
                name=name.group(1),
                matchers=parse_matcher(matcher.group(1)) if matcher else [],
            )
        )
    return projects


def find(repo_root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for config in sorted(repo_root.glob("workspaces/*/e2e-tests/playwright.config.ts")):
        e2e_root = config.parent
        projects = projects_in(config)
        if len(projects) < 2:
            continue
        for source in sorted(e2e_root.rglob("*.ts")):
            if "node_modules" in source.parts:
                continue
            # Per file, not per workspace. bulk-import runs three projects, but only two
            # of them reach bulk-import.spec.ts — a key in the orchestrator spec is not
            # shared with anything, and reporting it would be noise that costs the check
            # its credibility.
            relative = source.relative_to(e2e_root)
            reaching = [p.name for p in projects if p.matches(relative)]
            if len(reaching) < 2:
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
                        key=match.group(1) or match.group(2),
                        projects=reaching,
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
