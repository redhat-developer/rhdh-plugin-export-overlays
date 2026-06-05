#!/usr/bin/env python3
#
# Copyright (c) Red Hat, Inc.
#
# Render build-report.json files into a markdown status page.
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
import os
import sys
from datetime import datetime, timezone

import requests
from pathlib import Path


STAGE_LABELS = {
    "bootstrap": "Plugin Builds Bootstrap",
    "image-metadata-fetch": "Image Metadata Fetch",
    "dpdy": "DPDY Generation",
    "catalog-index": "Catalog Index Generation",
}

REASON_ANCHORS = {
    "Backstage version mismatch": "backstage-version-mismatch",
    "Image not found in registry": "image-not-found-in-registry",
}


def reason_to_link(reason: str, troubleshooting_content: str) -> str:
    """Convert a failure reason to an in-page troubleshooting anchor link if it matches a known prefix.
    Only links if troubleshooting content is embedded in the page."""
    if not troubleshooting_content:
        return reason
    for prefix, anchor in REASON_ANCHORS.items():
        if reason.startswith(prefix):
            return f"[{reason}](#{anchor})"
    return reason


def load_report(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        print(f"Warning: Report file not found: {path}", file=sys.stderr)
        return {}
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def parse_ghcr_ref(oci_ref: str) -> tuple[str, str, str] | None:
    """Parse a GHCR OCI ref into (org, package_path, tag).
    Returns None if not a valid GHCR ref with a tag."""
    ref = oci_ref.replace("oci://", "")
    if not ref.startswith("ghcr.io/"):
        return None
    rest = ref[len("ghcr.io/"):]
    if ":" not in rest:
        return None
    path_part, tag = rest.split(":", 1)
    tag = tag.split("@", 1)[0]
    if not tag:
        return None
    segments = path_part.split("/", 1)
    if len(segments) < 2:
        return None
    return segments[0], segments[1], tag


def collect_ghcr_refs(*reports: dict) -> list[str]:
    """Collect all unique GHCR OCI references from reports."""
    refs = set()
    for report in reports:
        if not report:
            continue
        meta = report.get("metadata", {})
        image = meta.get("catalog-index-image", "")
        if image and "ghcr.io" in image:
            refs.add(image)
        for plugin in report.get("plugins", {}).values():
            if plugin.get("overall") == "pass":
                oci_ref = plugin.get("stages", {}).get("bootstrap", {}).get("oci_ref", "")
                if oci_ref and "ghcr.io" in oci_ref:
                    refs.add(oci_ref)
    return list(refs)


def resolve_ghcr_version_ids(oci_refs: list[str]) -> dict[str, int]:
    """Resolve GHCR OCI refs to GitHub Package version IDs via the API.
    Returns a map of original OCI ref string -> version ID.
    Falls back to empty dict if requests is unavailable or GITHUB_TOKEN is not set."""
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("Note: GITHUB_TOKEN not set, GHCR links will use fallback format", file=sys.stderr)
        return {}

    package_tags: dict[tuple[str, str], set[str]] = {}
    ref_parsed: dict[str, tuple[str, str, str]] = {}

    for ref in oci_refs:
        parsed = parse_ghcr_ref(ref)
        if not parsed:
            continue
        org, pkg, tag = parsed
        package_tags.setdefault((org, pkg), set()).add(tag)
        ref_parsed[ref] = parsed

    tag_to_vid: dict[tuple[str, str, str], int] = {}
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    for (owner, pkg), tags in package_tags.items():
        encoded_pkg = pkg.replace("/", "%2F")
        base_url = f"https://api.github.com/{{owner_type}}/{owner}/packages/container/{encoded_pkg}/versions?per_page=100"
        versions = None
        for owner_type in ("orgs", "users"):
            url = base_url.format(owner_type=owner_type)
            try:
                resp = requests.get(url, headers=headers, timeout=15)
                if resp.status_code == 404 and owner_type == "orgs":
                    continue
                resp.raise_for_status()
                versions = resp.json()
                break
            except Exception as e:
                print(f"Warning: Failed to resolve GHCR versions for {owner}/{pkg}: {e}", file=sys.stderr)
        if versions:
            for version in versions:
                v_tags = version.get("metadata", {}).get("container", {}).get("tags", [])
                v_id = version.get("id")
                if v_id:
                    for t in v_tags:
                        if t in tags:
                            tag_to_vid[(owner, pkg, t)] = v_id

    result = {}
    for ref, (org, pkg, tag) in ref_parsed.items():
        vid = tag_to_vid.get((org, pkg, tag))
        if vid:
            result[ref] = vid
    return result


def oci_ref_to_link(oci_ref: str, ghcr_version_ids: dict[str, int] | None = None) -> str:
    """Convert an OCI reference to a clickable registry link."""
    if not oci_ref:
        return ""
    ref = oci_ref.replace("oci://", "")
    if ref.startswith("quay.io/"):
        tag_ref = ref.split("@", 1)[0]
        return f"[{ref}](https://{tag_ref})"
    if ref.startswith("ghcr.io/"):
        parsed = parse_ghcr_ref(oci_ref)
        if not parsed:
            return f"`{ref}`"
        org, pkg, tag = parsed
        repo = pkg.split("/")[0]
        encoded_pkg = pkg.replace("/", "%2F")
        version_id = (ghcr_version_ids or {}).get(oci_ref)
        if version_id:
            url = f"https://github.com/{org}/{repo}/pkgs/container/{encoded_pkg}/{version_id}?tag={tag}"
        else:
            url = f"https://github.com/{org}/{repo}/pkgs/container/{encoded_pkg}"
        return f"[{ref}]({url})"
    return f"`{ref}`"


def plugin_metadata_link(source_repo: str, branch: str, workspace: str, name: str) -> str:
    """Link a plugin name to its metadata YAML in the repo."""
    return f"[{name}]({source_repo}/blob/{branch}/workspaces/{workspace}/metadata/{name}.yaml)"


def workspace_link(source_repo: str, branch: str, workspace: str) -> str:
    """Link to the workspace directory."""
    return f"[{workspace}]({source_repo}/tree/{branch}/workspaces/{workspace})"


def first_failed_stage(stages: dict) -> tuple[str, str]:
    """Return (stage_label, reason) for the first failed stage."""
    for stage_key in ["bootstrap", "image-metadata-fetch", "dpdy", "catalog-index"]:
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
    troubleshooting_content: str = "",
    ghcr_version_ids: dict[str, int] | None = None,
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
    outdated = {k: v for k, v in plugins.items() if v.get("overall") == "outdated"}
    all_passed = {k: v for k, v in plugins.items() if v.get("overall") == "pass"}
    fallback = {k: v for k, v in all_passed.items()
                if v.get("stages", {}).get("image-metadata-fetch", {}).get("fallback")}
    passed = {k: v for k, v in all_passed.items() if k not in fallback}

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
            reason_link = reason_to_link(reason, troubleshooting_content)
            lines.append(f"| {name_link} | `{pkg}` | {ver} | {stage_label} | {reason_link} |")
        lines.append("")

    if outdated:
        lines.append(f"### ⚠️ Backstage Version Mismatch ({len(outdated)})")
        lines.append("")
        lines.append("> These plugins were excluded because their workspace targets an older Backstage minor version.")
        lines.append("> To resolve, try running `/update-commit` on their workspace PR (if it exists) or add a `backstage.json` override if no commit exists that updates the version.")
        lines.append("")
        lines.append("| Plugin | Package | Workspace | Expected | Found |")
        lines.append("|--------|---------|-----------|----------|-------|")
        for name in sorted(outdated):
            p = outdated[name]
            ws = p.get("workspace", "")
            pkg = p.get("package", "")
            bootstrap = p.get("stages", {}).get("bootstrap", {})
            expected = bootstrap.get("expected_version", "")
            found = bootstrap.get("found_version", "")
            name_link = plugin_metadata_link(source_repo, branch, ws, name) if ws else f"`{name}`"
            ws_link = workspace_link(source_repo, branch, ws) if ws else f"`{ws}`"
            lines.append(f"| {name_link} | `{pkg}` | {ws_link} | {expected} | {found} |")
        lines.append("")

    if fallback:
        lines.append(f"### ⚠️ Outdated ({len(fallback)})")
        lines.append("")
        lines.append("> These plugins are using an older published tag because the requested version was not found in the registry.")
        lines.append("")
        lines.append("| Plugin | Package | Requested Tag | Resolved Tag | OCI Reference |")
        lines.append("|--------|---------|---------------|--------------|---------------|")
        for name in sorted(fallback):
            p = fallback[name]
            ws = p.get("workspace", "")
            pkg = p.get("package", "")
            stages = p.get("stages", {})
            enrich = stages.get("image-metadata-fetch", {})
            requested = enrich.get("requestedTag", "")
            resolved = enrich.get("resolvedTag", "")
            oci_ref = stages.get("bootstrap", {}).get("oci_ref", "")
            name_link = plugin_metadata_link(source_repo, branch, ws, name) if ws else f"`{name}`"
            oci_link = oci_ref_to_link(oci_ref, ghcr_version_ids)
            lines.append(f"| {name_link} | `{pkg}` | `{requested}` | `{resolved}` | {oci_link} |")
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
            oci_link = oci_ref_to_link(oci_ref, ghcr_version_ids)
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


def count_fallbacks(report: dict) -> int:
    """Count plugins using fallback tags in a report."""
    return sum(
        1 for p in report.get("plugins", {}).values()
        if p.get("overall") == "pass"
        and p.get("stages", {}).get("image-metadata-fetch", {}).get("fallback")
    )


def count_outdated(report: dict) -> int:
    """Count plugins excluded due to backstage version mismatch."""
    return sum(
        1 for p in report.get("plugins", {}).values()
        if p.get("overall") == "outdated"
    )


def render_last_publish(report: dict, source_repo: str) -> str:
    """Render the last successful publish commit for a tier."""
    meta = report.get("metadata", {})
    last_ok = meta.get("last-successful-publish", "")
    if last_ok:
        return commit_link(last_ok, source_repo)
    return "—"


def render_catalog_image(report: dict, ghcr_version_ids: dict[str, int] | None = None) -> str:
    """Render a link to the catalog index OCI image.
    Only shows the image if the catalog has been successfully published."""
    meta = report.get("metadata", {})
    if not meta.get("last-successful-publish"):
        return "—"
    image = meta.get("catalog-index-image", "")
    if image:
        return oci_ref_to_link(image, ghcr_version_ids)
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
    target_branch: str = "",
    troubleshooting_content: str = "",
) -> str:
    """Render the complete status page markdown."""
    ghcr_refs = collect_ghcr_refs(supported_report, community_report)
    ghcr_version_ids = resolve_ghcr_version_ids(ghcr_refs) if ghcr_refs else {}

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
    if target_branch and source_repo:
        target_link = f"[{target_branch}]({source_repo}/tree/{target_branch})"
        lines.append(f"**Catalog index branch:** {target_link}  ")
    if run_link:
        lines.append(f"**Workflow run:** {run_link}  ")

    lines.append("")

    # Summary table
    sup_summary = supported_report.get("summary", {})
    com_summary = community_report.get("summary", {})

    lines.append("## Summary")
    lines.append("")
    lines.append("| Tier | Total | Passed | Outdated | Excluded | Failed | Latest Catalog Index Image | Last Successful Publish |")
    lines.append("|------|-------|--------|----------|----------|--------|----------------------------|-------------------------|")
    if supported_report:
        sup_img = render_catalog_image(supported_report, ghcr_version_ids)
        sup_pub = render_last_publish(supported_report, source_repo)
        sup_fallback = count_fallbacks(supported_report)
        sup_excluded = count_outdated(supported_report)
        lines.append(f"| Supported | {sup_summary.get('total', 0)} | {sup_summary.get('succeeded', 0)} | {sup_fallback} | {sup_excluded} | {sup_summary.get('failed', 0)} | {sup_img} | {sup_pub} |")
    if community_report:
        com_img = render_catalog_image(community_report, ghcr_version_ids)
        com_pub = render_last_publish(community_report, source_repo)
        com_fallback = count_fallbacks(community_report)
        com_excluded = count_outdated(community_report)
        lines.append(f"| Community | {com_summary.get('total', 0)} | {com_summary.get('succeeded', 0)} | {com_fallback} | {com_excluded} | {com_summary.get('failed', 0)} | {com_img} | {com_pub} |")
    lines.append("")

    # Tier details
    if supported_report:
        lines.extend(render_tier("Supported", supported_report, source_repo, source_branch, troubleshooting_content, ghcr_version_ids))
    if community_report:
        lines.extend(render_tier("Community", community_report, source_repo, source_branch, troubleshooting_content, ghcr_version_ids))

    if troubleshooting_content:
        lines.append("")
        lines.append(troubleshooting_content.rstrip())
        lines.append("")

    lines.append("---")
    if workflow_run_url:
        lines.append(f"*Auto-generated by the [catalog index generation pipeline]({workflow_run_url})*")
    else:
        lines.append("*Auto-generated by the catalog index generation pipeline*")
    lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description='Render build-report.json files into a markdown status page.',
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
        '--target-branch',
        type=str,
        default='',
        help='Target branch where catalog index artifacts are stored',
    )
    parser.add_argument(
        '--workflow-run-url',
        type=str,
        default='',
        help='URL of the workflow run',
    )
    parser.add_argument(
        '--troubleshooting-content',
        type=str,
        metavar='PATH',
        help='Path to troubleshooting markdown file to embed in the status page',
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

    troubleshooting_content = ""
    if args.troubleshooting_content:
        ts_path = Path(args.troubleshooting_content)
        if ts_path.exists():
            troubleshooting_content = ts_path.read_text(encoding='utf-8')
        else:
            print(f"Warning: Troubleshooting file not found: {args.troubleshooting_content}", file=sys.stderr)

    markdown = render_status_page(
        supported_report=supported_report,
        community_report=community_report,
        source_repo=args.source_repo,
        source_branch=args.source_branch,
        source_commit=args.source_commit,
        backstage_version=args.backstage_version,
        rhdh_version=args.rhdh_version,
        workflow_run_url=args.workflow_run_url,
        target_branch=args.target_branch,
        troubleshooting_content=troubleshooting_content,
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
