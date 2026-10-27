# generate-dynamic-plugin-tables

Generates AsciiDoc reference pages and CSV inventories from a resolved plugin
catalog index. It uses `index.json` for membership and OCI references, and the
matching Package entities for titles, versions, roles, and configuration
variables. Supported output also uses `default.packages.yaml` for enabled and
disabled status. No registry requests are made.

From `scripts/`, after `vp install`:

```bash
vp exec generate-dynamic-plugin-tables --tier supported --index-dir ../catalog-index/supported
vp exec generate-dynamic-plugin-tables --tier community --index-dir ../catalog-index/community
```

Node 24 runs the TypeScript source directly. After installing workspace
dependencies, the entry point can also be called from another checkout:

```bash
node /path/to/overlays/scripts/generate-dynamic-plugin-tables/src/cli.ts \
  --tier supported --index-dir /path/to/productized/catalog-index
```

By default, output goes to `<index-dir>/extend_dynamic-plugins-reference/`.
Use `--output-dir` to write elsewhere and `--default-packages-file` when
productized defaults live outside the index. CLI paths must resolve inside the
directory from which the command is run, including through symlinks. Run it
from a directory containing the index, output, and any external defaults.
Pass `--debug` to print each added row with its destination page, package,
version, support level, OCI path, tag, and CSV inclusion. The catalog index
workflow enables this for build logs.

Supported mode generates GA, Technology Preview, Deprecated, and Preinstalled
pages plus `rhdh-supported-plugins.csv`.
Community mode generates `ref-community-supported-plugins.adoc` and
`rhdh-community-plugins.csv`. Both CSVs use the same columns; the community
CSV sets `Default` to `N/A` because that index has no default package config.

Rows are alphabetized for stable documentation updates. Community rows use the
Package entity title. Supported rows use the displayed plugin name; packages
with the same name appear frontend, backend, then scaffolder. The supported CSV
uses that same order within its GA, Technology Preview, and Deprecated sections.
Required variables and the preinstalled package list use alphabetical order.
