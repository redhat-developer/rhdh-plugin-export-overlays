# Codecov coverage anchors (auto-generated — do not edit)

One empty, static file per deployed plugin, named after its scalprum name.
Codecov only keeps coverage for paths that exist in this repo's git tree, and
the plugins' real sources live in the upstream repo — so
`scripts/remap-coverage.cjs` concatenates each plugin's E2E coverage onto its
anchor (line ranges shifted; the aggregated percentage is preserved exactly).
Only the path's existence matters; content and length are never validated.

These files never change with plugin versions. Re-run the generator only when
a new plugin gains a metadata Package entity:

```bash
./scripts/generate-coverage-anchors.sh global-header
```
