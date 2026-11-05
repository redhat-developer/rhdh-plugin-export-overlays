# generate-dynamic-plugin-tables

Generates AsciiDoc plugin reference pages and CSV inventories from a resolved
catalog index. Supported output also reads the index's default package list for
enabled and disabled status. No registry requests are made.

## Usage

```bash
vp exec generate-dynamic-plugin-tables --tier supported --index-dir ../catalog-index/supported
vp exec generate-dynamic-plugin-tables --tier community --index-dir ../catalog-index/community
```

Run with `--help` for `--output-dir`, `--default-packages-file`, and `--debug`.
