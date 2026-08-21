#!/usr/bin/env python3
"""Cross-check the ``-app-next`` e2e lanes against what the artifacts actually expose.

An ``-app-next`` Playwright project claims a whole OpenShift namespace to prove that a
workspace's plugins work under the new frontend system. If none of that workspace's
published frontend artifacts exposes an NFS entry point, there is nothing for the new
frontend system to mount and the lane cannot prove anything — but it does not fail
either. A plugin that contributes nothing still boots cleanly, so the suite either
passes against an empty page or fails much later on a missing element, in a repository
away from the code that would have to change.

Two lane attempts have already been spent discovering that by hand (RHIDP-16463). The
readiness data answers it before a ticket is opened.

Three verdicts, and the third matters as much as the other two:

``ready``
    At least one frontend package in the workspace is ``nfs-ready``.
``blocked``
    Every frontend package was classified, and none is ``nfs-ready``. The lane cannot
    work yet. This is the only verdict that fails the check.
``unknown``
    The classification could not be established — typically the report was generated
    without ``--oci``, so nothing was pulled and no artifact was read. Reported
    separately and never as ``blocked``: "we did not look" and "we looked and found
    nothing" send whoever is reading to opposite places, and collapsing them would let
    a report generated the cheap way condemn every lane in the repo.

Usage::

    scripts/nfs-readiness-report.sh --json --oci > readiness.json
    scripts/check_app_next_lanes.py --readiness readiness.json [--repo-root .]

Exits 1 when any lane is ``blocked``, 0 otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

#: A Playwright project whose name ends in this runs the workspace under app-next.
APP_NEXT_SUFFIX = "-app-next"

#: Matches `name: "<project>"` in a playwright.config.ts.
PROJECT_NAME = re.compile(r'name:\s*"([^"]+)"')

READY = "ready"
BLOCKED = "blocked"
UNKNOWN = "unknown"


@dataclass
class LaneVerdict:
    workspace: str
    lanes: list[str]
    verdict: str
    reason: str
    packages: list[str] = field(default_factory=list)


def app_next_workspaces(repo_root: Path) -> dict[str, list[str]]:
    """Workspaces declaring at least one ``-app-next`` Playwright project.

    Read from the config rather than from a hand-kept list because the config is what
    CI actually runs, and a list would drift the moment someone adds a lane.
    """
    found: dict[str, list[str]] = {}
    for config in sorted(repo_root.glob("workspaces/*/e2e-tests/playwright.config.ts")):
        workspace = config.parent.parent.name
        lanes = [
            name
            for name in PROJECT_NAME.findall(config.read_text(encoding="utf-8"))
            if name.endswith(APP_NEXT_SUFFIX)
        ]
        if lanes:
            found[workspace] = lanes
    return found


def judge(workspace: str, lanes: list[str], rows: list[dict]) -> LaneVerdict:
    """Decide whether this workspace's artifacts can serve an app-next lane."""
    frontend = [r for r in rows if r.get("workspace") == workspace and r.get("frontend")]

    if not frontend:
        # Backend-only workspaces legitimately run an app-next lane: it proves the
        # backend modules still work under an NFS *shell*, which is a different claim
        # from the packages themselves being NFS. Not a blocker.
        return LaneVerdict(
            workspace,
            lanes,
            READY,
            "no frontend packages — the lane exercises the app-next shell, not the packages",
        )

    ready = [r["packageName"] for r in frontend if r.get("status") == "nfs-ready"]
    if ready:
        return LaneVerdict(
            workspace, lanes, READY, f"{len(ready)} nfs-ready package(s)", sorted(ready)
        )

    unknown = [r["packageName"] for r in frontend if r.get("status") == UNKNOWN]
    if unknown:
        return LaneVerdict(
            workspace,
            lanes,
            UNKNOWN,
            f"{len(unknown)} of {len(frontend)} frontend package(s) unclassified — "
            "run the readiness report with --oci to judge this lane",
            sorted(unknown),
        )

    return LaneVerdict(
        workspace,
        lanes,
        BLOCKED,
        f"none of {len(frontend)} frontend package(s) exposes an NFS entry point",
        sorted(r["packageName"] for r in frontend),
    )


def evaluate(repo_root: Path, rows: list[dict]) -> list[LaneVerdict]:
    return [
        judge(workspace, lanes, rows)
        for workspace, lanes in sorted(app_next_workspaces(repo_root).items())
    ]


def render(verdicts: list[LaneVerdict]) -> str:
    order = {BLOCKED: 0, UNKNOWN: 1, READY: 2}
    mark = {BLOCKED: "BLOCKED", UNKNOWN: "unknown", READY: "ok"}
    lines = []
    for v in sorted(verdicts, key=lambda v: (order[v.verdict], v.workspace)):
        lines.append(f"{mark[v.verdict]:>8}  {v.workspace:<28} {v.reason}")
        if v.verdict != READY and v.packages:
            for pkg in v.packages:
                lines.append(f"{'':>10}  - {pkg}")
    blocked = [v for v in verdicts if v.verdict == BLOCKED]
    if blocked:
        lines.append("")
        lines.append(
            f"{len(blocked)} app-next lane(s) claim a namespace to prove something their "
            "artifacts cannot demonstrate. Remove the lane, or publish an NFS entry point "
            "first — see RHIDP-16463."
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--readiness",
        required=True,
        help="JSON from scripts/nfs-readiness-report.sh, or - for stdin",
    )
    parser.add_argument("--repo-root", default=".")
    args = parser.parse_args(argv)

    raw = sys.stdin.read() if args.readiness == "-" else Path(args.readiness).read_text()
    rows = json.loads(raw)
    if not isinstance(rows, list):
        print("readiness input must be the JSON array the report emits", file=sys.stderr)
        return 2

    verdicts = evaluate(Path(args.repo_root), rows)
    if not verdicts:
        print("no -app-next lanes found")
        return 0

    print(render(verdicts))
    return 1 if any(v.verdict == BLOCKED for v in verdicts) else 0


if __name__ == "__main__":
    raise SystemExit(main())
