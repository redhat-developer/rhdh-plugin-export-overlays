#!/usr/bin/env python3
"""
Generate a wiki page documenting all workspaces in the current branch.

This script:
1. Scans the workspaces/ directory for all workspace folders
2. Extracts metadata from source.json and plugins-list.yaml
3. Checks for pending PRs that modify each workspace
4. Generates a formatted Markdown page with all workspace details
"""

import os
import sys
import json
import yaml
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from datetime import datetime


def run_command(cmd: List[str], check: bool = True) -> Tuple[int, str, str]:
    """Run a shell command and return exit code, stdout, stderr."""
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False
    )
    if check and result.returncode != 0:
        print(f"Command failed: {' '.join(cmd)}", file=sys.stderr)
        print(f"Exit code: {result.returncode}", file=sys.stderr)
        print(f"Stderr: {result.stderr}", file=sys.stderr)
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def get_workspace_list(workspaces_dir: Path) -> List[str]:
    """Get list of all workspace directories."""
    if not workspaces_dir.exists():
        print(f"Workspaces directory not found: {workspaces_dir}", file=sys.stderr)
        return []
    
    workspaces = []
    for item in sorted(workspaces_dir.iterdir()):
        if item.is_dir() and not item.name.startswith('.'):
            workspaces.append(item.name)
    
    return workspaces


def parse_source_json(workspace_path: Path) -> Optional[Dict]:
    """Parse source.json file from a workspace."""
    source_file = workspace_path / "source.json"
    if not source_file.exists():
        return None
    
    try:
        with open(source_file, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"Error reading {source_file}: {e}", file=sys.stderr)
        return None


def parse_plugins_list(workspace_path: Path) -> List[str]:
    """Parse plugins-list.yaml file from a workspace."""
    plugins_file = workspace_path / "plugins-list.yaml"
    if not plugins_file.exists():
        return []
    
    try:
        with open(plugins_file, 'r') as f:
            content = f.read().strip()
            if not content:
                return []
            
            # Parse YAML - it's a simple list of plugin paths
            data = yaml.safe_load(content)
            if isinstance(data, dict):
                # Keys are plugin paths
                return list(data.keys())
            elif isinstance(data, list):
                return data
            else:
                return []
    except (yaml.YAMLError, IOError) as e:
        print(f"Error reading {plugins_file}: {e}", file=sys.stderr)
        return []


def get_commit_details(repo_url: str, commit_sha: str) -> Tuple[str, str, str]:
    """
    Get commit details including short SHA, commit message, and date.
    Returns (short_sha, message, date)
    """
    # Extract owner/repo from URL
    if not repo_url.startswith("https://github.com/"):
        return commit_sha[:7], "N/A", "N/A"
    
    repo_path = repo_url.replace("https://github.com/", "").rstrip('/')
    
    # Try to get commit details using gh CLI
    cmd = [
        "gh", "api",
        f"/repos/{repo_path}/commits/{commit_sha}",
        "--jq", ".sha, .commit.message, .commit.author.date"
    ]
    
    exit_code, stdout, stderr = run_command(cmd, check=False)
    
    if exit_code == 0 and stdout:
        lines = stdout.split('\n')
        if len(lines) >= 3:
            full_sha = lines[0]
            message = lines[1].split('\n')[0]  # First line of commit message
            date = lines[2]
            
            # Format date
            try:
                dt = datetime.fromisoformat(date.replace('Z', '+00:00'))
                formatted_date = dt.strftime('%Y-%m-%d %H:%M UTC')
            except:
                formatted_date = date
            
            return full_sha[:7], message, formatted_date
    
    # Fallback
    return commit_sha[:7], "N/A", "N/A"


def check_pending_prs(workspace_name: str, repo_name: str) -> Tuple[bool, List[str]]:
    """
    Check if there are any open PRs that modify this workspace.
    Returns (has_pending, [pr_numbers])
    """
    workspace_path = f"workspaces/{workspace_name}"
    
    # Use gh CLI to search for open PRs
    cmd = [
        "gh", "pr", "list",
        "--repo", repo_name,
        "--state", "open",
        "--json", "number,files",
        "--jq", f'.[] | select(.files[].path | startswith("{workspace_path}")) | .number'
    ]
    
    exit_code, stdout, stderr = run_command(cmd, check=False)
    
    if exit_code == 0 and stdout:
        pr_numbers = [line.strip() for line in stdout.split('\n') if line.strip()]
        return len(pr_numbers) > 0, pr_numbers
    
    return False, []


def get_backstage_version(workspace_path: Path) -> Optional[str]:
    """Get Backstage version from backstage.json or source.json."""
    # Check backstage.json first
    backstage_file = workspace_path / "backstage.json"
    if backstage_file.exists():
        try:
            with open(backstage_file, 'r') as f:
                data = json.load(f)
                if 'version' in data:
                    return data['version']
        except (json.JSONDecodeError, IOError):
            pass
    
    # Fall back to source.json
    source_data = parse_source_json(workspace_path)
    if source_data and 'repo-backstage-version' in source_data:
        return source_data['repo-backstage-version']
    
    return None


def count_additional_files(workspace_path: Path) -> Dict[str, int]:
    """Count additional configuration files in the workspace."""
    counts = {
        'metadata': 0,
        'plugins': 0,
        'patches': 0,
        'tests': 0
    }
    
    for key in counts.keys():
        dir_path = workspace_path / key
        if dir_path.exists() and dir_path.is_dir():
            # Count all files recursively
            counts[key] = sum(1 for _ in dir_path.rglob('*') if _.is_file())
    
    return counts


def generate_markdown(branch_name: str, workspaces_data: List[Dict]) -> str:
    """Generate the Markdown content for the wiki page."""
    md = []
    
    # Header
    md.append(f"# Workspace Status: `{branch_name}`")
    md.append("")
    md.append(f"**Last Updated:** {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
    md.append("")
    md.append(f"**Total Workspaces:** {len(workspaces_data)}")
    md.append("")
    md.append("---")
    md.append("")
    
    # Table of Contents
    md.append("## Table of Contents")
    md.append("")
    for ws in workspaces_data:
        anchor = ws['name'].lower().replace('_', '-').replace(' ', '-')
        md.append(f"- [{ws['name']}](#{anchor})")
    md.append("")
    md.append("---")
    md.append("")
    
    # Workspace Details
    for ws in workspaces_data:
        md.append(f"## {ws['name']}")
        md.append("")
        
        # Source Repository
        if ws['repo_url']:
            repo_name = ws['repo_url'].replace('https://github.com/', '')
            md.append(f"**Source Repository:** [{repo_name}]({ws['repo_url']})")
        else:
            md.append("**Source Repository:** N/A")
        
        # Commit Information
        if ws['commit_sha']:
            commit_link = f"{ws['repo_url']}/commit/{ws['commit_sha']}"
            md.append(f"**Pinned Commit:** [{ws['commit_short']}]({commit_link})")
            if ws['commit_message'] != "N/A":
                md.append(f"**Commit Message:** {ws['commit_message']}")
            if ws['commit_date'] != "N/A":
                md.append(f"**Commit Date:** {ws['commit_date']}")
        else:
            md.append("**Pinned Commit:** N/A")
        
        # Backstage Version
        if ws['backstage_version']:
            md.append(f"**Backstage Version:** `{ws['backstage_version']}`")
        
        # Workspace Type
        workspace_type = "Monorepo (workspace-based)" if not ws['repo_flat'] else "Flat (root-level plugins)"
        md.append(f"**Repository Structure:** {workspace_type}")
        
        md.append("")
        
        # Plugins
        md.append(f"**Plugins ({len(ws['plugins'])}):**")
        md.append("")
        if ws['plugins']:
            for plugin in ws['plugins']:
                md.append(f"- `{plugin}`")
        else:
            md.append("- *No plugins listed*")
        md.append("")
        
        # Additional Files
        additional = ws['additional_files']
        if any(additional.values()):
            md.append("**Additional Configuration:**")
            md.append("")
            if additional['metadata'] > 0:
                md.append(f"- Metadata files: {additional['metadata']}")
            if additional['plugins'] > 0:
                md.append(f"- Plugin overlays: {additional['plugins']}")
            if additional['patches'] > 0:
                md.append(f"- Patches: {additional['patches']}")
            if additional['tests'] > 0:
                md.append(f"- Test files: {additional['tests']}")
            md.append("")
        
        # Pending PRs
        if ws['has_pending_prs']:
            pr_links = []
            for pr_num in ws['pr_numbers']:
                pr_url = f"https://github.com/{os.getenv('REPO_NAME')}/pull/{pr_num}"
                pr_links.append(f"[#{pr_num}]({pr_url})")
            
            md.append(f"**Pending Updates:** ⚠️ Yes - {', '.join(pr_links)}")
        else:
            md.append("**Pending Updates:** ✅ No")
        
        md.append("")
        md.append("---")
        md.append("")
    
    return '\n'.join(md)


def main():
    """Main entry point."""
    # Get environment variables
    branch_name = os.getenv('BRANCH_NAME', 'main')
    repo_name = os.getenv('REPO_NAME', 'unknown/unknown')
    
    print(f"Generating wiki page for branch: {branch_name}")
    print(f"Repository: {repo_name}")
    
    # Get workspace directory
    workspaces_dir = Path('workspaces')
    
    # Get list of workspaces
    workspace_names = get_workspace_list(workspaces_dir)
    print(f"Found {len(workspace_names)} workspaces")
    
    # Collect data for each workspace
    workspaces_data = []
    
    for ws_name in workspace_names:
        print(f"Processing workspace: {ws_name}")
        ws_path = workspaces_dir / ws_name
        
        # Parse source.json
        source_data = parse_source_json(ws_path)
        
        # Parse plugins-list.yaml
        plugins = parse_plugins_list(ws_path)
        
        # Get commit details
        commit_sha = None
        commit_short = None
        commit_message = "N/A"
        commit_date = "N/A"
        repo_url = None
        repo_flat = False
        
        if source_data:
            repo_url = source_data.get('repo', '')
            commit_sha = source_data.get('repo-ref', '')
            repo_flat = source_data.get('repo-flat', False)
            
            if repo_url and commit_sha:
                commit_short, commit_message, commit_date = get_commit_details(repo_url, commit_sha)
        
        # Get Backstage version
        backstage_version = get_backstage_version(ws_path)
        
        # Count additional files
        additional_files = count_additional_files(ws_path)
        
        # Check for pending PRs
        has_pending_prs, pr_numbers = check_pending_prs(ws_name, repo_name)
        
        workspaces_data.append({
            'name': ws_name,
            'repo_url': repo_url,
            'commit_sha': commit_sha,
            'commit_short': commit_short,
            'commit_message': commit_message,
            'commit_date': commit_date,
            'repo_flat': repo_flat,
            'backstage_version': backstage_version,
            'plugins': plugins,
            'additional_files': additional_files,
            'has_pending_prs': has_pending_prs,
            'pr_numbers': pr_numbers
        })
    
    # Generate Markdown
    print("Generating Markdown content...")
    markdown_content = generate_markdown(branch_name, workspaces_data)
    
    # Write to file
    output_file = f"{branch_name}.md"
    with open(output_file, 'w') as f:
        f.write(markdown_content)
    
    print(f"Wiki page generated: {output_file}")
    print(f"Total workspaces documented: {len(workspaces_data)}")


if __name__ == '__main__':
    main()


