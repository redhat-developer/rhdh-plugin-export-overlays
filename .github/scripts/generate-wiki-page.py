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
import requests
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timezone


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


def get_plugin_details(repo_url: str, commit_sha: str, plugin_path: str) -> str:
    """
    Fetch package.json to get plugin name and version.
    Returns 'name@version' or just the path if fetch fails.
    """
    if not repo_url.startswith("https://github.com/"):
        return plugin_path

    repo_name = repo_url.replace("https://github.com/", "")
    
    # Use GitHub API to get raw content
    api_url = f"https://api.github.com/repos/{repo_name}/contents/{plugin_path}/package.json"
    headers = {
        "Accept": "application/vnd.github.v3.raw",
        "Authorization": f"token {os.getenv('GH_TOKEN', '')}"
    }
    
    try:
        response = requests.get(api_url, headers=headers, params={"ref": commit_sha}, timeout=10)
        if response.status_code == 200:
            data = response.json()
            name = data.get('name', 'unknown')
            version = data.get('version', 'unknown')
            return f"{name}@{version}"
    except Exception as e:
        print(f"Error fetching package.json for {plugin_path}: {e}", file=sys.stderr)
    
    return plugin_path


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


def check_pending_prs(workspace_name: str, repo_name: str, target_branch: str) -> Tuple[bool, List[str]]:
    """
    Check if there are any open PRs that modify this workspace.
    Filters by:
    - Base branch (target_branch)
    - Files touching the workspace path
    - Labels: workspace_addition or workspace_update
    Returns (has_pending, [pr_numbers])
    """
    workspace_path = f"workspaces/{workspace_name}"
    
    # Use gh CLI to search for open PRs
    # Filter by base branch, workspace path, and labels
    cmd = [
        "gh", "pr", "list",
        "--repo", repo_name,
        "--base", target_branch,
        "--state", "open",
        "--limit", "100",
        "--json", "number,files,labels",
        "--jq", f'.[] | select(any(.files[]; .path | startswith("{workspace_path}")) and (any(.labels[]; .name == "workspace_addition" or .name == "workspace_update"))) | .number'
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


def get_source_backstage_version(repo_url: str, commit_sha: str) -> Optional[str]:
    """Fetch backstage.json from the source repo to determine its version."""
    if not repo_url or not commit_sha or not repo_url.startswith("https://github.com/"):
        return None

    repo_name = repo_url.replace("https://github.com/", "").rstrip('/')
    api_url = f"https://api.github.com/repos/{repo_name}/contents/backstage.json"
    headers = {
        "Accept": "application/vnd.github.v3.raw",
        "Authorization": f"token {os.getenv('GH_TOKEN', '')}"
    }

    try:
        response = requests.get(api_url, headers=headers, params={"ref": commit_sha}, timeout=10)
        if response.status_code == 200:
            data = response.json()
            return data.get("version")
    except Exception as e:
        print(f"Error fetching upstream backstage.json for {repo_url}: {e}", file=sys.stderr)

    return None


def load_plugin_lists() -> Tuple[List[str], List[str]]:
    """Load the list of supported and community plugins."""
    supported_plugins = []
    community_plugins = []
    
    try:
        if Path("rhdh-supported-plugins.txt").exists():
            with open("rhdh-supported-plugins.txt", 'r') as f:
                supported_plugins = [line.strip() for line in f if line.strip() and not line.startswith('#')]
        
        if Path("rhdh-community-plugins.txt").exists():
            with open("rhdh-community-plugins.txt", 'r') as f:
                community_plugins = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    except Exception as e:
        print(f"Error loading plugin lists: {e}", file=sys.stderr)
        
    return supported_plugins, community_plugins


def check_support_status(plugin_path: str, workspace_name: str, supported_list: List[str], community_list: List[str]) -> str:
    """
    Check support status for a plugin.
    Returns 'Supported', 'Community', or 'Unknown'
    The path in the text files is typically <workspace-folder>/<plugin-path-from-workspace-root>
    """
    # Construct the full path as expected in the text files
    # workspace_name is like "acr"
    # plugin_path is like "plugins/acr" (relative to workspace root)
    # Full path in text file: "acr/plugins/acr"
    
    # Handle potential leading slash or ./ in plugin_path
    clean_plugin_path = plugin_path.lstrip('./').lstrip('/')
    full_path = f"{workspace_name}/{clean_plugin_path}"
    
    if full_path in supported_list:
        return "Supported"
    if full_path in community_list:
        return "Community"
    
    # Try without workspace prefix just in case
    if clean_plugin_path in supported_list:
        return "Supported"
    if clean_plugin_path in community_list:
        return "Community"
        
    return "Unknown"


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
    md.append(f"**Last Updated:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    md.append("")
    md.append(f"**Total Workspaces:** {len(workspaces_data)}")
    md.append("")
    md.append("---")
    md.append("")
    
    # Workspace Table
    md.append("## Workspace Overview")
    md.append("")
    md.append("| Type | Workspace | Source | Commit Date | Backstage Version | Plugins |")
    md.append("|:----:|-----------|--------|-------------|------------------|---------|")

    for ws in workspaces_data:
        # Repo Structure Icon & Link
        # 🌳 for Monorepo (workspace-based), 📄 for Flat (root-level plugins)
        source_json_url = f"https://github.com/{os.getenv('REPO_NAME')}/blob/{branch_name}/workspaces/{ws['name']}/source.json"
        if ws['repo_flat']:
            struct_icon = "📄"
            struct_tooltip = "Flat (root-level plugins)"
        else:
            struct_icon = "🌳"
            struct_tooltip = "Monorepo (workspace-based)"
        
        # Build Type column with all status icons
        structure_badges = []
        
        # 1. Repository structure icon (linked to source.json)
        structure_badges.append(f"[{struct_icon}]({source_json_url} \"{struct_tooltip}\")")
        
        # 2. Patches indicator
        has_patches = ws['additional_files']['patches'] > 0
        if has_patches:
            structure_badges.append('<span title="Has patches">🩹</span>')
        
        # 3. Overlays indicator
        has_overlays = ws['additional_files']['plugins'] > 0
        if has_overlays:
            structure_badges.append('<span title="Has overlays">🔄</span>')
        
        # 4. Metadata status
        has_metadata = ws['additional_files']['metadata'] > 0
        if has_metadata:
            structure_badges.append('<span title="Metadata available">🟢</span>')
        else:
            structure_badges.append('<span title="Metadata missing">🔴</span>')
        
        # 5. Pending PR indicator (red icon linking to PR)
        has_prs = ws['has_pending_prs']
        if has_prs:
            # Link the red icon to the first PR (usually only 1 expected)
            pr_num = ws['pr_numbers'][0]
            pr_url = f"https://github.com/{os.getenv('REPO_NAME')}/pull/{pr_num}"
            pr_tooltip = f"Pending update PR #{pr_num}"
            structure_badges.append(f'[<span title="{pr_tooltip}">🔴</span>]({pr_url})')
            
        structure = "<br>".join(structure_badges)

        # Workspace name - link to workspace in overlay repo
        overlay_repo_url = f"https://github.com/{os.getenv('REPO_NAME')}/tree/{branch_name}/workspaces/{ws['name']}"
        workspace_name = f"[{ws['name']}]({overlay_repo_url})"

        # Source - repo@commit linking to source workspace
        if ws['repo_url'] and ws['commit_sha']:
            repo_name = ws['repo_url'].replace('https://github.com/', '')
            if ws['repo_flat']:
                # Flat repos - link to repo root at commit
                source_url = f"{ws['repo_url']}/tree/{ws['commit_sha']}"
                source = f"[{repo_name}@{ws['commit_short']}]({source_url})"
            else:
                # Workspace-based repos - link to specific workspace folder
                workspace_path = f"workspaces/{ws['name']}"
                source_url = f"{ws['repo_url']}/tree/{ws['commit_sha']}/{workspace_path}"
                source = f"[{repo_name}@{ws['commit_short']}]({source_url})"
        else:
            source = "N/A"

        # Commit Date
        commit_date = ws['commit_date'].split(' ')[0] if ws['commit_date'] != "N/A" else ""

        # Backstage Version (show source repo version, highlight overrides with color)
        overlay_version = ws.get('overlay_backstage_version')
        source_version = ws.get('source_backstage_version')
        display_version = source_version or overlay_version
        
        if display_version:
            # Check if there's an override
            if overlay_version and source_version and overlay_version != source_version:
                # Override detected - show in orange/red with tooltip
                tooltip = f"Overlay overrides upstream version {source_version} to {overlay_version}".replace('"', '&quot;')
                backstage_version = f'<span style="color: #ff6b35;" title="{tooltip}">`{display_version}`</span>'
            else:
                # No override - normal display
                backstage_version = f"`{display_version}`"
        else:
            backstage_version = "N/A"

        # Plugins List
        # Format: <plugin packageName>@<plugin version> [Support Status]
        if ws['plugins']:
            plugins_list_items = []
            for p in ws['plugins']:
                # p is now a dict with details, path, status
                name_ver = p['details']
                status = p['status']

                status_icon = ""
                if status == "Supported":
                    status_icon = "✅ Supported"
                elif status == "Community":
                    status_icon = "🤝 Community"

                plugins_list_items.append(f"`{name_ver}`{status_icon}")

            # Use line breaks with bullet points for better visibility
            plugins_list = "<br>🔸 ".join([""] + plugins_list_items)
        else:
            plugins_list = "No plugins"

        # Add table row
        md.append(f"| {structure} | {workspace_name} | {source} | {commit_date} | {backstage_version} | {plugins_list} |")

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
    
    # Load support lists
    supported_plugins, community_plugins = load_plugin_lists()
    print(f"Loaded {len(supported_plugins)} supported and {len(community_plugins)} community plugins")
    
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
        source_backstage_version = get_source_backstage_version(repo_url, commit_sha)
        
        # Enhance plugin list with versions from package.json
        enhanced_plugins = []
        if repo_url and commit_sha:
            print(f"  Fetching plugin details for {len(plugins)} plugins...")
            for plugin_path in plugins:
                details = get_plugin_details(repo_url, commit_sha, plugin_path)
                
                # Check support status
                support_status = check_support_status(plugin_path, ws_name, supported_plugins, community_plugins)
                
                enhanced_plugins.append({
                    'details': details,
                    'path': plugin_path,
                    'status': support_status
                })
        else:
            # If fetch fails or no repo info, create basic objects
            for plugin_path in plugins:
                support_status = check_support_status(plugin_path, ws_name, supported_plugins, community_plugins)
                enhanced_plugins.append({
                    'details': plugin_path,
                    'path': plugin_path,
                    'status': support_status
                })

        # Count additional files
        additional_files = count_additional_files(ws_path)
        
        # Check for pending PRs
        has_pending_prs, pr_numbers = check_pending_prs(ws_name, repo_name, branch_name)
        
        workspaces_data.append({
            'name': ws_name,
            'repo_url': repo_url,
            'commit_sha': commit_sha,
            'commit_short': commit_short,
            'commit_message': commit_message,
            'commit_date': commit_date,
            'repo_flat': repo_flat,
            'overlay_backstage_version': backstage_version,
            'source_backstage_version': source_backstage_version,
            'plugins': enhanced_plugins,
            'additional_files': additional_files,
            'has_pending_prs': has_pending_prs,
            'pr_numbers': pr_numbers
        })
    
    # Generate Markdown
    print("Generating Markdown content...")
    markdown_content = generate_markdown(branch_name, workspaces_data)
    
    # Write to file (sanitize branch name for filename)
    safe_branch_name = branch_name.replace('/', '-')
    output_file = f"{safe_branch_name}.md"
    with open(output_file, 'w') as f:
        f.write(markdown_content)
    
    print(f"Wiki page generated: {output_file}")
    print(f"Total workspaces documented: {len(workspaces_data)}")


if __name__ == '__main__':
    main()


