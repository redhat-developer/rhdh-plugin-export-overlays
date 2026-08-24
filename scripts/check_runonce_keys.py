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

**It fails loudly rather than quietly.** Parsing TypeScript with regexes is only ever
approximate, and the entire value of this check is that it does not pass in silence. So
every place the parse is uncertain — a project entry it cannot read, a ``testMatch`` it
cannot interpret, a key that is not a literal — is reported or raised, never skipped. A
finding to read costs a minute; a collision that ships costs a deployment that never
happened.

Three shapes count as shared:

* a spec matched by two or more projects;
* any file **no** project's ``testMatch`` names — a shared helper is imported by specs
  from every project, so its keys are shared by all of them;
* the same key in two workspaces, because ``run-e2e.sh`` runs every workspace in one
  Playwright process and therefore one flag directory.

A literal key is not wrong in itself: setup that is genuinely shared — an operator
installed once into a fixed namespace every project then uses — *should* have one. That
is why a finding prints its reason rather than the check forbidding literals outright,
and why ``--allow`` and ``scripts/runonce-shared-keys.txt`` record the decision.

Usage::

    scripts/check_runonce_keys.py [--repo-root .] [--allow KEY ...]

Exits 1 when a shared key is found that is not allowed, 2 when the tree cannot be read.
"""

from __future__ import annotations

import argparse
import collections
import re
import sys
from dataclasses import dataclass
from pathlib import Path

#: `name: "<project>"`, either quote style. Accepting only one is how a whole workspace
#: disappears from the scan without a word.
PROJECT_NAME = re.compile(r"""name:\s*["']([^"']+)["']""")

#: The value of a `testMatch:`, to the end of the line.
TEST_MATCH_VALUE = re.compile(r"testMatch\s*:\s*(.+)")

#: A `runOnce(` call and whatever its first argument is — not only a literal. Extracting
#: the key to a `const` is the natural refactor and must not become a way past this.
RUN_ONCE_CALL = re.compile(r"runOnce\(([^,]*),", re.DOTALL)

#: A quoted key, either style, on one line. A TypeScript string literal cannot contain a
#: raw newline, so a multi-line match is a parse artefact rather than a key — and
#: printing one would put a pull request's own text at the start of a line in CI output,
#: where `::error::` is a workflow command and not a string.
QUOTED_KEY = re.compile(r"""^["']([^"'\r\n]+)["']$""")

#: What makes a template literal vary by project. `deploy()` keys on the namespace, and
#: the namespace *is* the project name, so either reads as per-project.
VARIES_BY_PROJECT = re.compile(r"namespace|project\.name", re.IGNORECASE)

#: A local alias for the namespace: `const ns = rhdh.deploymentConfig.namespace`. Real
#: specs do this and then interpolate the short name, so matching only the literal word
#: "namespace" rejects a key that is perfectly per-project — intelligent-assistant#3324
#: is exactly that, and calling it a collision would block a correct PR.
NAMESPACE_ALIAS = re.compile(
    r"(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*(?:namespace|project\.name)", re.IGNORECASE
)

#: Glob and regex metacharacters. A matcher still carrying one after the literal parts
#: are taken was not understood, and pretending otherwise yields a fragment that matches
#: nothing — which silently removes the project from every file.
METACHARACTER = re.compile(r"[*?+()|\[\]]")

#: Optional companion to `--allow`, so a deliberately shared key is recorded next to the
#: code rather than in the workflow that runs this.
ALLOW_FILE = Path("scripts/runonce-shared-keys.txt")


class ParseError(Exception):
    """The tree could not be read well enough to answer. Never a silent skip."""


@dataclass
class Project:
    name: str
    #: `testMatch` fragments; empty when the project declares none or when its matcher
    #: could not be read — both mean "assume it matches everything".
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
    reason: str


def parse_matcher(value: str) -> list[str]:
    """The path fragments a `testMatch` value would match on.

    Three forms appear in this repo and all reduce to a fragment of the spec's path: a
    bare string, a glob, and a regex literal. They are compared as text rather than
    interpreted, which answers the only question here — whether two projects can reach
    the same file.

    A value this cannot reduce to a plain fragment yields nothing, which makes the
    project match everything. That is the cautious direction and it has to be reached
    deliberately: stripping `*` out of `**/specs/*.spec.ts` leaves `specs/.spec.ts`,
    which matches no real path and would quietly drop the project from every file.
    """
    fragments = re.findall(r"""["']([^"']+)["']|/((?:[^/\\]|\\.)+)/""", value)
    out = []
    for quoted, regex in fragments:
        raw = (quoted or regex.replace("\\", "")).replace("**/", "").strip("/")
        if METACHARACTER.search(raw):
            return []
        out.append(raw)
    return [f for f in out if f]


def projects_array_start(text: str) -> int:
    """Index of the `[` opening the `projects` array, or -1."""
    at = text.find("projects")
    return text.find("[", at) if at >= 0 else -1


def project_entries(text: str) -> tuple[list[str], str]:
    """Each top-level `{ ... }` body in the `projects` array, and the array itself.

    Brace counting rather than a regex. A regex that stops at the first `}` drops an
    entry carrying `use: { ... }`; one that spans a nested pair instead swallows the
    whole `defineConfig({ ... })` object and reads every project as one. Both fail
    toward silence, which is the outcome this file exists to avoid.
    """
    start = projects_array_start(text)
    if start < 0:
        return [], ""

    entries: list[str] = []
    depth = 0
    begin = 0
    end = len(text)
    for index in range(start + 1, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
            if depth == 1:
                begin = index + 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                entries.append(text[begin:index])
        elif char == "]" and depth == 0:
            end = index
            break
        if depth < 0:
            end = index
            break
    return entries, text[start:end]


def projects_in(config: Path) -> list[Project]:
    """Every Playwright project the config declares, with what it matches on.

    Raises when fewer projects come out than the file plainly declares. A nested object
    the entry regex cannot span would otherwise drop a project, and a dropped project is
    a workspace that quietly stops being checked.
    """
    text = config.read_text(encoding="utf-8")
    projects: list[Project] = []
    entries, region = project_entries(text)
    for entry in entries:
        name = PROJECT_NAME.search(entry)
        if not name:
            continue
        matcher = TEST_MATCH_VALUE.search(entry)
        projects.append(
            Project(
                name=name.group(1),
                matchers=parse_matcher(matcher.group(1)) if matcher else [],
            )
        )

    # Counted inside the projects array, not the whole file: a `name:` elsewhere is
    # not a project and must not make this raise.
    declared = len(PROJECT_NAME.findall(region))
    if len(projects) < declared:
        raise ParseError(
            f"{config}: read {len(projects)} project(s) but the file names {declared}. "
            "An entry this could not parse would silently drop out of the check."
        )
    return projects


def classify(argument: str, aliases: frozenset[str] = frozenset()) -> tuple[str, str] | None:
    """The key and why it risks colliding, or ``None`` when it is safe.

    A quoted key is the same string in every project. A template is safe only if
    something in it varies by project — `` `${WORKSPACE}-setup` `` is a template and is
    just as shared as a literal. Anything else is a name this cannot follow, and unknown
    is reported rather than assumed safe.
    """
    quoted = QUOTED_KEY.match(argument)
    if quoted:
        return quoted.group(1), "the key is the same string in every project"
    if argument.startswith("`"):
        interpolated = set(re.findall(r"\$\{\s*(\w+)", argument))
        if VARIES_BY_PROJECT.search(argument) or interpolated & aliases:
            return None
        return (
            " ".join(argument.split()),
            "the key is a template that does not vary by project or namespace",
        )
    return (
        " ".join(argument.split()),
        "the key is not a literal, so this cannot tell whether it varies by project",
    )


def keys_in(
    source: Path, e2e_root: Path, projects: list[Project]
) -> list[tuple[str, str | None, int, bool]]:
    """Every runOnce key in one file: `(key, reason-or-None, line, is-quoted)`.

    `reason` is `None` when only one project reaches the file, which makes the key
    uninteresting here — but it is still returned, because a quoted key participates in
    the cross-workspace comparison whatever its own workspace looks like.
    """
    relative = source.relative_to(e2e_root)
    reaching = [p.name for p in projects if p.matches(relative)]
    # A file no project's testMatch names is not a spec — it is a helper, imported by
    # specs from every project. backstage gives all 13 of its projects a testMatch, so
    # without this a literal key in its shared helpers would be invisible.
    if not reaching:
        reaching = [p.name for p in projects]

    text = source.read_text(encoding="utf-8")
    aliases = frozenset(NAMESPACE_ALIAS.findall(text))
    out = []
    for match in RUN_ONCE_CALL.finditer(text):
        argument = match.group(1).strip()
        classified = classify(argument, aliases)
        if not classified:
            continue
        key, reason = classified
        shared = f"{', '.join(reaching)} all run this file, and {reason}"
        out.append(
            (
                key,
                shared if len(reaching) >= 2 else None,
                text.count("\n", 0, match.start()) + 1,
                bool(QUOTED_KEY.match(argument)),
            )
        )
    return out


def resolved_root(repo_root: Path) -> Path:
    """The scan root, resolved and confirmed to be a directory.

    A typo'd `--repo-root` would otherwise glob nothing and read as a clean tree, which
    is exactly the silence this check exists to remove.
    """
    root = repo_root.resolve()
    if not root.is_dir():
        raise ParseError(f"not a directory: {repo_root}")
    return root


def find(repo_root: Path) -> list[Finding]:
    root = resolved_root(repo_root)
    configs = sorted(root.glob("workspaces/*/e2e-tests/playwright.config.ts"))
    if not configs:
        raise ParseError(
            f"no workspaces/*/e2e-tests/playwright.config.ts under {root}. "
            "Nothing was scanned, which is not the same as nothing being wrong."
        )

    findings: list[Finding] = []
    keys_by_workspace: dict[str, set[str]] = collections.defaultdict(set)

    for config in configs:
        found, quoted = scan_workspace(config, root)
        findings.extend(found)
        for key in quoted:
            # Only a quoted key is a stable string to compare across workspaces; a
            # template or an identifier is reported on its own line anyway.
            keys_by_workspace[key].add(config.parent.parent.name)

    return findings + cross_workspace(keys_by_workspace, {f.key for f in findings})


def scan_workspace(config: Path, root: Path) -> tuple[list[Finding], set[str]]:
    """One workspace's findings, and every quoted key it uses.

    The quoted keys come back even when the workspace has nothing wrong on its own: they
    are what the cross-workspace comparison needs, and a single-project workspace still
    contributes to it.
    """
    e2e_root = config.parent
    workspace = e2e_root.parent.name
    projects = projects_in(config)

    findings: list[Finding] = []
    quoted_keys: set[str] = set()
    for source in sorted(e2e_root.rglob("*.ts")):
        if "node_modules" in source.parts:
            continue
        for key, reason, line, quoted in keys_in(source, e2e_root, projects):
            if quoted:
                quoted_keys.add(key)
            if reason is not None:
                findings.append(
                    Finding(
                        workspace=workspace,
                        file=source.relative_to(root),
                        line=line,
                        key=key,
                        reason=reason,
                    )
                )
    return findings, quoted_keys


def cross_workspace(
    keys_by_workspace: dict[str, set[str]], already_reported: set[str]
) -> list[Finding]:
    """Keys used in more than one workspace.

    `run-e2e.sh` runs every workspace in one Playwright process, so one flag directory
    covers all of them and two single-project workspaces collide there. A key already
    reported against its own file is skipped — a second entry for it is noise.
    """
    return [
        Finding(
            workspace=", ".join(sorted(workspaces)),
            file=Path("(across workspaces)"),
            line=0,
            key=key,
            reason=(
                f"{', '.join(sorted(workspaces))} all use this key, and run-e2e.sh "
                "runs them in one Playwright process with one flag directory"
            ),
        )
        for key, workspaces in sorted(keys_by_workspace.items())
        if len(workspaces) >= 2 and key not in already_reported
    ]


def render(findings: list[Finding]) -> str:
    lines = []
    for f in findings:
        where = f"{f.file}:{f.line}" if f.line else f"{f.file}"
        lines.append(f'{where}  runOnce("{f.key}")')
        lines.append(f"    {f.reason}.")
        lines.append(
            "    If the setup belongs to one project, end the key with "
            "`-${rhdh.deploymentConfig.namespace}`, as deploy() does. If it is genuinely "
            "shared, record it with --allow or in scripts/runonce-shared-keys.txt."
        )
        lines.append("")
    return "\n".join(lines)


def allowed_keys(root: Path, from_flags: list[str]) -> set[str]:
    """Keys recorded as deliberately shared, from the flags and the companion file.

    `root` is the already-resolved directory `find` validated. The file name is a
    constant, and the join is checked against the root anyway rather than trusted —
    the root is the one part that came from a command line.
    """
    allow = set(from_flags)
    listed = (root / ALLOW_FILE).resolve()
    if not listed.is_relative_to(root):
        raise ParseError(f"allow list must sit inside {root}: {listed}")
    if listed.is_file():
        for line in listed.read_text(encoding="utf-8").splitlines():
            entry = line.split("#", 1)[0].strip()
            if entry:
                allow.add(entry)
    return allow


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", default=".")
    parser.add_argument(
        "--allow",
        action="append",
        default=[],
        metavar="KEY",
        help="a key deliberately shared by every project; repeatable",
    )
    args = parser.parse_args(argv)
    repo_root = Path(args.repo_root)

    try:
        root = resolved_root(repo_root)
        found = find(root)
        allow = allowed_keys(root, args.allow)
    except ParseError as err:
        print(err, file=sys.stderr)
        return 2

    findings = [f for f in found if f.key not in allow]
    if not findings:
        print("no runOnce key is shared between projects that run the same specs")
        return 0

    print(render(findings), end="")
    print(
        f"{len(findings)} runOnce key(s) would be shared. The second project skips the "
        "setup and reports nothing."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
