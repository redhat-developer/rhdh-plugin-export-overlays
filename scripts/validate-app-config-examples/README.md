# validate-app-config-examples

Validates that every Package under `workspaces/*/metadata/*.yaml` carries a
non-empty first `appConfigExamples[].content`, or opts out explicitly via
`spec.appConfigNotRequired: true` (RHIDP-12590).

## Usage

```bash
yarn build

# the whole tree
node dist/validate.mjs

# just what a PR touched
node dist/validate.mjs --since "$BASE_SHA"
```

Exit codes match the Python script this replaced: `0` clean, `1` validation
failed, `2` the tool itself failed.

## Layout

| Path | Role |
|---|---|
| `src/metadata.ts` | YAML reading and the verdicts |
| `src/validate.ts` | CLI, reporting, exit codes |
| `src/metadata.test.ts` | locks in the verdicts and their wording |

`yarn check` runs the type check and the unit tests. The tests are pure — no
network, no fixtures on disk — so the suite stays fast and deterministic.
