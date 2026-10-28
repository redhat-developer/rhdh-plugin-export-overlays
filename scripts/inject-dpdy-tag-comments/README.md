# inject-dpdy-tag-comments

Inserts `# Tag: …, Build date: …` comments into `dynamic-plugins.default.yaml`
from `plugin_builds/` JSON. Comments are added only before active
`- package: oci://…` lines that do not already have a nearby Tag comment.

## Usage

```bash
vp exec inject-dpdy-tag-comments path/to/dynamic-plugins.default.yaml path/to/plugin_builds
```
