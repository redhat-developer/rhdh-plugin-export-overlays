#!/usr/bin/env python3
"""Regenerate catalog-entities/extensions/{plugins,packages}/all.yaml Location
files so their targets match the individual entity YAML files on disk.
"""
import argparse
import sys
from pathlib import Path

from generateCatalogIndex import regenerate_all_yaml_files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '-d', '--overlays-dir',
        type=str,
        default='.',
        metavar='PATH',
        help='Path to overlays directory containing catalog-entities/ (default: .)',
    )
    args = parser.parse_args()

    overlays_dir = Path(args.overlays_dir)
    extensions_dir = overlays_dir / "catalog-entities" / "extensions"
    if not extensions_dir.exists():
        print(f"Error: {extensions_dir} not found", file=sys.stderr)
        sys.exit(1)

    regenerate_all_yaml_files(overlays_dir)


if __name__ == "__main__":
    main()
