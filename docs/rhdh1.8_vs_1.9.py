#!/usr/bin/env python3
import os
import yaml
from pathlib import Path

def extract_support_tag(file_path):
    """Extract the support tag from a YAML metadata file."""
    try:
        with open(file_path, 'r') as f:
            data = yaml.safe_load(f)
            return data.get('spec', {}).get('support', 'N/A')
    except Exception as e:
        return f"ERROR: {str(e)}"

def get_plugin_name(file_path):
    """Extract plugin name from file path."""
    basename = os.path.basename(file_path)
    return os.path.splitext(basename)[0]

def style_support_level(support_level):
    """Style support level labels with colors."""
    if support_level == 'production':
        return '[.green]#production#'
    elif support_level == 'tech-preview':
        return '[.blue]#tech-preview#'
    elif support_level == 'generally-available':
        return '[.green]#generally-available#'
    else:
        return support_level

# Directories
workspaces_dir = Path('/home/nboldt/RHDH/DH/1/1-overlays_alt/workspaces')
old_dir = Path('/home/nboldt/1/1-rhdh_alt/catalog-entities/marketplace/packages')

# Find all metadata files in workspaces
metadata_files = []
for metadata_file in workspaces_dir.rglob('metadata/*.yaml'):
    metadata_files.append(metadata_file)

# Sort by filename for consistent output
metadata_files.sort(key=lambda x: x.name)

# Collect comparison data
found_entries = []
not_found_entries = []

for new_file in metadata_files:
    plugin_name = get_plugin_name(new_file)
    new_support = extract_support_tag(new_file)
    
    # Find corresponding file in old directory
    old_file = old_dir / new_file.name
    
    if old_file.exists():
        old_support = extract_support_tag(old_file)
    else:
        old_support = "NOT FOUND"
    
    # Only include entries where support tag has changed
    if old_support != new_support:
        if old_support == 'NOT FOUND':
            not_found_entries.append((plugin_name, old_support, new_support))
        else:
            found_entries.append((plugin_name, old_support, new_support))

# Generate two tables
output = []

# First table: Found entries
output.append('')
output.append('== Plugins Whose Support Level Has Changed Between RHDH 1.8 and 1.9')
output.append('')
output.append('[cols="3,1,1"]')
output.append('|===')
output.append('|Plugin Name |RHDH 1.8 Support Level |RHDH 1.9 Support Level')
output.append('')

for plugin_name, old_support, new_support in found_entries:
    styled_old = style_support_level(old_support)
    styled_new = style_support_level(new_support)
    output.append(f'|{plugin_name} |{styled_old} |{styled_new}')

output.append('|===')
output.append('')
output.append('== New Plugin Packages in RHDH 1.9')
output.append('')
output.append('[cols="3,1"]')
output.append('|===')
output.append('|Plugin Name |RHDH 1.9 Support Level')
output.append('')

for plugin_name, old_support, new_support in not_found_entries:
    styled_support = style_support_level(new_support)
    output.append(f'|{plugin_name} |{styled_support}')

output.append('|===')

# Write to file
with open('support_tags_comparison.adoc', 'w') as f:
    f.write('\n'.join(output))

print(f"Created two tables:")
print(f"  - Found entries: {len(found_entries)}")
print(f"  - New entries: {len(not_found_entries)}")
