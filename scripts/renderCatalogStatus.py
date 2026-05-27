#!/usr/bin/env python3
#
# Copyright (c) Red Hat, Inc.
#
# Render build-report.json files into a GitHub Wiki markdown status page.
#
# Usage:
#   python3 renderCatalogStatus.py \
#     --supported catalog-index/supported/build-report.json \
#     --community catalog-index/community/build-report.json \
#     --source-repo https://github.com/redhat-developer/rhdh-plugin-export-overlays \
#     --source-branch main \
#     --source-commit abc1234 \
#     --workflow-run-url https://github.com/.../actions/runs/12345 \
#     --output status-page.md

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


STAGE_LABELS = {
    "bootstrap": "Bootstrap",
    "registry-enrich": "Registry Enrich",
    "dpdy": "DPDY",
    "catalog-index": "Catalog Index",
}


def load_report(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        print(f"Warning: Report file not found: {path}", file=sys.stderr)
        return {}
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def oci_ref_to_link(oci_ref: str) -> str:
    """Convert an OCI reference to a clickable registry link."""
    if not oci_ref:
        return ""
    ref = oci_ref.replace("oci://", "")
    if ref.startswith("quay.io/"):
        tag_ref = ref.split("@", 1)[0]
        return f"[{ref}](https://{tag_ref})"
    if ref.startswith("ghcr.io/"):
        base = ref.split(":", 1)[0].split("@", 1)[0]
        tag = ""
        if ":" in ref:
            tag = ref.split(":", 1)[1].split("@", 1)[0]
        url = f"https://{base}" + (f"?tag={tag}" if tag else "")
        return f"[{ref}](https://{url})"
    return f"`{ref}`"


def plugin_metadata_link(source_repo: str, branch: str, workspace: str, name: str) -> str:
    """Link a plugin name to its metadata YAML in the repo."""
    return f"[{name}]({source_repo}/blob/{branch}/workspaces/{workspace}/metadata/{name}.yaml)"


def workspace_link(source_repo: str, branch: str, workspace: str) -> str:
    """Link to the workspace directory."""
    return f"[{workspace}]({source_repo}/tree/{branch}/workspaces/{workspace})"


def first_failed_stage(stages: dict) -> tuple[str, str]:
    """Return (stage_label, reason) for the first failed stage."""
    for stage_key in ["bootstrap", "registry-enrich", "dpdy", "catalog-index"]:
        stage = stages.get(stage_key, {})
        if stage.get("status") == "fail":
            label = STAGE_LABELS.get(stage_key, stage_key)
            reason = stage.get("reason", "Unknown error")
            return label, reason
    return "Unknown", "Unknown error"


def render_tier(
    tier_name: str,
    report: dict,
    source_repo: str,
    branch: str,
    workflow_run_url: str,
) -> list[str]:
    """Render a single tier section."""
    lines = []
    plugins = report.get("plugins", {})
    status = report.get("status", "unknown")

    if status == "initial":
        lines.append(f"## {tier_name} Catalog")
        lines.append("")
        lines.append("> **Initial build** — No plugins have been published for this branch yet.")
        lines.append("> This is expected for newly created release branches.")
        lines.append("")
        return lines

    failed = {k: v for k, v in plugins.items() if v.get("overall") == "fail"}
    passed = {k: v for k, v in plugins.items() if v.get("overall") == "pass"}

    lines.append(f"## {tier_name} Catalog")
    lines.append("")

    if failed:
        lines.append(f"### Failed ({len(failed)})")
        lines.append("")
        lines.append("| Plugin | Package | Version | Failed Stage | Reason |")
        lines.append("|--------|---------|---------|--------------|--------|")
        for name in sorted(failed):
            p = failed[name]
            ws = p.get("workspace", "")
            pkg = p.get("package", "")
            ver = p.get("version", "")
            stage_label, reason = first_failed_stage(p.get("stages", {}))
            name_link = plugin_metadata_link(source_repo, branch, ws, name) if ws else f"`{name}`"
            reason_link = f"[{reason}]({workflow_run_url})" if workflow_run_url else reason
            lines.append(f"| {name_link} | `{pkg}` | {ver} | {stage_label} | {reason_link} |")
        lines.append("")

    if passed:
        lines.append(f"### Passed ({len(passed)})")
        lines.append("")
        lines.append("| Plugin | Package | Version | OCI Reference |")
        lines.append("|--------|---------|---------|---------------|")
        for name in sorted(passed):
            p = passed[name]
            ws = p.get("workspace", "")
            pkg = p.get("package", "")
            ver = p.get("version", "")
            stages = p.get("stages", {})
            oci_ref = stages.get("bootstrap", {}).get("oci_ref", "")
            name_link = plugin_metadata_link(source_repo, branch, ws, name) if ws else f"`{name}`"
            oci_link = oci_ref_to_link(oci_ref)
            lines.append(f"| {name_link} | `{pkg}` | {ver} | {oci_link} |")
        lines.append("")

    return lines


def commit_link(sha: str, source_repo: str) -> str:
    if not sha:
        return "—"
    short = sha[:7]
    if source_repo:
        return f"[{short}]({source_repo}/commit/{sha})"
    return short


def render_last_publish(report: dict, source_repo: str) -> str:
    """Render the last successful publish commit for a tier."""
    meta = report.get("metadata", {})
    last_ok = meta.get("last-successful-publish", "")
    if last_ok:
        return commit_link(last_ok, source_repo)
    return "—"


def render_catalog_image(report: dict) -> str:
    """Render a link to the catalog index OCI image.
    Only shows the image if the catalog has been successfully published."""
    meta = report.get("metadata", {})
    if not meta.get("last-successful-publish"):
        return "—"
    image = meta.get("catalog-index-image", "")
    if image:
        return oci_ref_to_link(image)
    return "—"


def render_status_page(
    supported_report: dict,
    community_report: dict,
    source_repo: str,
    source_branch: str,
    source_commit: str,
    backstage_version: str,
    rhdh_version: str,
    workflow_run_url: str,
) -> str:
    """Render the complete status page markdown."""
    lines = []

    lines.append(f"# Plugin Catalog Index Status — {source_branch}")
    lines.append("")

    build_date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    short_sha = source_commit[:7] if source_commit else ""
    commit_link = f"[{source_branch} @ {short_sha}]({source_repo}/tree/{source_branch})" if source_repo else f"{source_branch} @ {short_sha}"
    run_link = f"[View run]({workflow_run_url})" if workflow_run_url else ""

    lines.append(f"**Build date:** {build_date}  ")
    lines.append(f"**Source:** {commit_link}  ")
    if backstage_version or rhdh_version:
        version_parts = []
        if backstage_version:
            version_parts.append(f"**Backstage:** {backstage_version}")
        if rhdh_version:
            version_parts.append(f"**RHDH:** {rhdh_version}")
        lines.append(f"{' | '.join(version_parts)}  ")
    if run_link:
        lines.append(f"**Workflow run:** {run_link}  ")

    lines.append("")

    # Summary table
    sup_summary = supported_report.get("summary", {})
    com_summary = community_report.get("summary", {})

    lines.append("## Summary")
    lines.append("")
    lines.append("| Tier | Total | Passed | Failed | Latest Catalog Index Image | Last Successful Publish |")
    lines.append("|------|-------|--------|--------|----------------------------|-------------------------|")
    if supported_report:
        sup_img = render_catalog_image(supported_report)
        sup_pub = render_last_publish(supported_report, source_repo)
        lines.append(f"| Supported | {sup_summary.get('total', 0)} | {sup_summary.get('succeeded', 0)} | {sup_summary.get('failed', 0)} | {sup_img} | {sup_pub} |")
    if community_report:
        com_img = render_catalog_image(community_report)
        com_pub = render_last_publish(community_report, source_repo)
        lines.append(f"| Community | {com_summary.get('total', 0)} | {com_summary.get('succeeded', 0)} | {com_summary.get('failed', 0)} | {com_img} | {com_pub} |")
    lines.append("")

    # Tier details
    if supported_report:
        lines.extend(render_tier("Supported", supported_report, source_repo, source_branch, workflow_run_url))
    if community_report:
        lines.extend(render_tier("Community", community_report, source_repo, source_branch, workflow_run_url))

    lines.append("---")
    lines.append(f"*Auto-generated by [generate-catalog-index]({source_repo}/blob/{source_branch}/.github/workflows/generate-catalog-index.yaml) workflow*")
    lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description='Render build-report.json files into a GitHub Wiki markdown status page.',
    )
    parser.add_argument(
        '--supported',
        type=str,
        metavar='PATH',
        help='Path to supported tier build-report.json',
    )
    parser.add_argument(
        '--community',
        type=str,
        metavar='PATH',
        help='Path to community tier build-report.json',
    )
    parser.add_argument(
        '--source-repo',
        type=str,
        default='',
        help='Source repository URL (e.g., https://github.com/org/repo)',
    )
    parser.add_argument(
        '--source-branch',
        type=str,
        default='main',
        help='Source branch name',
    )
    parser.add_argument(
        '--source-commit',
        type=str,
        default='',
        help='Source commit SHA',
    )
    parser.add_argument(
        '--backstage-version',
        type=str,
        default='',
        help='Backstage version',
    )
    parser.add_argument(
        '--rhdh-version',
        type=str,
        default='',
        help='RHDH version',
    )
    parser.add_argument(
        '--workflow-run-url',
        type=str,
        default='',
        help='URL of the workflow run',
    )
    parser.add_argument(
        '--output',
        type=str,
        metavar='PATH',
        help='Output file path (default: stdout)',
    )

    args = parser.parse_args()

    supported_report = load_report(args.supported) if args.supported else {}
    community_report = load_report(args.community) if args.community else {}

    if not supported_report and not community_report:
        print("Error: At least one report file must be provided", file=sys.stderr)
        sys.exit(1)

    markdown = render_status_page(
        supported_report=supported_report,
        community_report=community_report,
        source_repo=args.source_repo,
        source_branch=args.source_branch,
        source_commit=args.source_commit,
        backstage_version=args.backstage_version,
        rhdh_version=args.rhdh_version,
        workflow_run_url=args.workflow_run_url,
    )

    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(markdown)
        print(f"Status page written to {args.output}")
    else:
        print(markdown)


if __name__ == "__main__":
    main()
