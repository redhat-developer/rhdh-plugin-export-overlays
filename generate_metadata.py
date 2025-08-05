import os
import re

# --- Configuration ---
downstream_plugins_file = 'downstream-plugins'
overlay_repo_root = 'workspaces'
repo_base_url = 'https://github.com/redhat-developer/rhdh-plugin-export-overlays'
# --- End Configuration ---

metadata_template = """apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: rhdh-plugin-{plugin_name_sanitized}
  title: '@redhat/backstage-plugin-{plugin_name_sanitized}'
  annotations:
    janus-idp.io/lifecycle: production
    janus-idp.io/support: supported
    backstage.io/view-url: {repo_base_url}/tree/main/workspaces/{final_path_for_url}
    backstage.io/edit-url: {repo_base_url}/edit/main/workspaces/{final_path_for_url}/metadata.yaml
spec:
  type: {plugin_type}
  owner: group:default/rhdh-maintainers
  lifecycle: production
"""

print("Starting metadata generation with exception logic for 'backstage' workspace...")

try:
    with open(downstream_plugins_file, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue

            source_plugin_path = line.removesuffix('/.')
            
            # --- HYBRID LOGIC ---
            if source_plugin_path.startswith('backstage/'):
                # EXCEPTION RULE for 'backstage' workspace (deeper paths)
                # 'backstage/plugins/kubernetes' -> 'backstage/kubernetes'
                final_path = re.sub(r'/(plugins|packages)/', '/', source_plugin_path)
            else:
                # GENERAL RULE for all other workspaces (shallow paths)
                # '3scale/plugins/3scale-backend' -> '3scale'
                final_path = source_plugin_path.split('/')[0]
            # --- END HYBRID LOGIC ---

            plugin_name = os.path.basename(source_plugin_path)
            plugin_name_sanitized = plugin_name.replace('backstage-plugin-', '')

            if 'backend-module' in plugin_name or 'actions' in plugin_name or 'processor' in plugin_name:
                plugin_type = 'backstage-backend-plugin-module'
            elif 'backend' in plugin_name:
                plugin_type = 'backstage-backend-plugin'
            else:
                plugin_type = 'backstage-plugin'

            output_dir = os.path.join(overlay_repo_root, final_path)
            os.makedirs(output_dir, exist_ok=True)
            output_file = os.path.join(output_dir, 'metadata.yaml')

            content = metadata_template.format(
                plugin_name_sanitized=plugin_name_sanitized,
                final_path_for_url=final_path,
                plugin_type=plugin_type,
                repo_base_url=repo_base_url
            ).strip()

            with open(output_file, 'w') as out:
                out.write(content + '\n')

            print(f"  [SUCCESS] Generated: {output_file}")

except FileNotFoundError:
    print(f"[ERROR] The input file '{downstream_plugins_file}' was not found in this directory.")
    exit(1)

print("\nMetadata generation complete.")