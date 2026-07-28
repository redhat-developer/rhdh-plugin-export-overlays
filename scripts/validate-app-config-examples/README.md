# validate-app-config-examples

Validates the `appConfigExamples` carried by Package metadata under
`workspaces/*/metadata/*.yaml`.

Two independent layers:

| Layer | What it checks | Jira |
|---|---|---|
| Structural | every Package has a non-empty first `appConfigExamples[].content`, or opts out via `spec.appConfigNotRequired: true` | RHIDP-12590 |
| Semantic | each example's content satisfies the plugin's own config schema | RHIDP-13509 |

The structural layer runs always. The semantic layer is opt-in via
`--check-schemas`.

## Usage

```bash
yarn build

# structural only — the whole tree
yarn node dist/validate.mjs

# structural only — just what a PR touched
yarn node dist/validate.mjs --since "$BASE_SHA"

# add schema validation, failing on mismatch
yarn node dist/validate.mjs --since "$BASE_SHA" --check-schemas

# add schema validation, reporting without failing
yarn node dist/validate.mjs --check-schemas --warn-only
```

Exit codes match the Python script this replaced: `0` clean, `1` validation
failed, `2` the tool itself failed.

## Why this is TypeScript and not Python

The previous implementation was `scripts/validate-app-config-examples.py`. It
only checked that example content existed, which needs nothing more than a YAML
parser.

Validating that content *against the plugin's schema* is a different problem. A
plugin declares its schema through `configSchema` in `package.json`, and across
this catalogue that field points at one of two things:

- `config.schema.json` — a compiled JSON schema, usable as-is
- `config.d.ts` — a raw TypeScript declaration, which has to be compiled first

The second form is the majority, so a validator has to run the TypeScript
compiler. `@backstage/config-loader` already does that, and applies Backstage's
`@visibility` conventions on the way — reusing it means the CI gate enforces the
same semantics Backstage enforces at runtime, rather than an approximation of
them.

Schemas are read from the **published package**, resolved from the
`spec.packageName` and `spec.version` the metadata already pins. That is the
artifact users actually install, and it avoids resolving upstream repo SHAs.

## What the semantic check does and does not catch

It **does** catch wrong types, wrong nesting, and malformed values on any key
the plugin's schema declares — for example a `maxBufferSize` given as a string
where the schema declares a number.

It **does not** flag unknown keys. Examples legitimately carry RHDH wiring that
is not part of any plugin's schema — 72 of 178 metadata files include a
`dynamicPlugins` block, and 65 of them contain nothing else. Turning on
`noUndeclaredProperties` would fail all of those, so undeclared keys are
tolerated. The trade-off is that a typo in a key name passes silently.

Three outcomes are reported as notes rather than failures, because none of them
is a defect in the metadata:

- the package declares no `configSchema`, so there is nothing to validate against
- the package/version is not on the registry
- the schema could not be compiled

## Layout

| Path | Role |
|---|---|
| `src/metadata.ts` | YAML reading and the structural verdicts |
| `src/schema.ts` | package download, schema loading, example validation |
| `src/validate.ts` | CLI, reporting, exit codes |
| `src/metadata.test.ts` | locks in the structural verdicts and their wording |

`yarn check` runs the type check and the unit tests. The tests are pure — they
never touch the network — so the suite stays fast and deterministic; the
schema path is exercised in CI against real packages instead.
