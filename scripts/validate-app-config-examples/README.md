# validate-app-config-examples

Validates the `appConfigExamples` carried by Package metadata under
`workspaces/*/metadata/*.yaml`.

Two independent layers:

| Layer      | What it checks                                                                                                       | Jira        |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| Structural | every Package has a non-empty first `appConfigExamples[].content`, or opts out via `spec.appConfigNotRequired: true` | RHIDP-12590 |
| Semantic   | each example's content satisfies the plugin's own config schema                                                      | RHIDP-13509 |

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

# the full-tree sweep CI runs on workflow_dispatch
yarn node dist/validate.mjs --check-schemas
```

The full-tree sweep reports `mismatched: 0` as of RHIDP-15903, so it fails on a
mismatch rather than warning. `--warn-only` remains for surveying a tree you have
not cleaned up yet — a release branch, say.

Exit codes match the Python script this replaced: `0` clean, `1` validation
failed, `2` the tool itself failed.

## Why this is TypeScript and not Python

The previous implementation was `scripts/validate-app-config-examples.py`. It
only checked that example content existed, which needs nothing more than a YAML
parser.

Validating that content _against the plugin's schema_ is a different problem. A
plugin declares its schema through `configSchema` in `package.json`, and across
this catalogue that field points at one of two things:

- `config.schema.json` — a compiled JSON schema, usable as-is
- `config.d.ts` — a raw TypeScript declaration, which has to be compiled first

The second form is the more common, so a validator has to run the TypeScript
compiler. `@backstage/config-loader` already does that, and applies Backstage's
`@visibility` conventions on the way — reusing it means the CI gate enforces the
same semantics Backstage enforces at runtime, rather than an approximation of
them.

Schemas are read from the **published package**, resolved from the
`spec.packageName` and `spec.version` the metadata already pins. That is the
artifact users actually install, and it avoids resolving upstream repo SHAs.

## What the semantic check catches — and what it does not

Verified against the real compiler, not assumed.

**Caught:**

- a scalar that cannot be coerced to the declared type (`retries: "many"` where a
  number is declared)
- wrong nesting — a scalar where an object or array is declared
- a value outside a declared enum
- a missing required property

**Not caught:**

- **coercible scalars.** `@backstage/config-loader` builds Ajv with
  `coerceTypes: true`, so `port: "8080"` against a declared number passes. This
  is one of the more common real app-config mistakes, and this check does not
  see it.
- **undeclared keys.** Examples legitimately carry RHDH wiring that belongs to
  no plugin schema — 72 of 180 metadata files include a `dynamicPlugins` block
  and 65 contain nothing else. Rejecting undeclared keys would fail all of them,
  so a typo'd key name passes silently.
- **anything behind an environment placeholder.** See below.
- **packages whose `config.d.ts` imports from their dependencies.** `npm pack`
  fetches the package alone with no `node_modules`, and config-loader compiles
  with `skipLibCheck: false`, so those fail to compile and report as
  `unavailable`. On a 29-package sample, 6 were affected. Installing each
  package's dependency tree would fix it at a cost this check cannot justify.

### Environment placeholders

Examples write values the deployer supplies as `${SEGMENT_TEST_MODE}`, and
Backstage substitutes those **before** it validates anything. Checking the
literal `${...}` text against a declared boolean would therefore reject a value
that never reaches a schema in that form — which is exactly what happened to
`analytics-provider-segment` (RHIDP-15903).

Substitution can only ever produce a _string_, so an example is accepted when
some string assignment to its placeholders satisfies the schema. Concretely the
validator retries with every placeholder set to `placeholder`, `true`, `false`,
and `0` in turn, and accepts if any of those validates. The errors it reports
are always the ones from the untouched document, so paths and values match what
is on disk.

This deliberately does not weaken structural checks: a placeholder where an
object or an array is declared is still reported, because no string can satisfy
that however the variable is set.

One limit: placeholders are substituted uniformly, one candidate at a time,
rather than searching every combination. An example whose placeholders sit on
fields of _different_ declared types — one boolean, one number — can still be
reported. No example in this catalogue does that, and the message names the
exact path, so the failure direction is a visible false positive rather than a
silent pass.

Three outcomes are reported as notes rather than failures, because none is a
defect in the metadata: the package declares no `configSchema`, it is not on the
registry, or its schema could not be compiled. **Every run that checks schemas
prints a tally** of validated / mismatched / no-schema / unavailable, and says so
explicitly when nothing was validated — otherwise an offline runner reports
`PASS: 180  FAIL: 0` having checked nothing, and the gate looks green because it
is inert.

## Layout

| Path              | Role                                                 |
| ----------------- | ---------------------------------------------------- |
| `src/json.ts`     | the shared mapping guard and error-property reader   |
| `src/metadata.ts` | YAML reading and the structural verdicts             |
| `src/schema.ts`   | package download, schema loading, example validation |
| `src/validate.ts` | CLI, reporting, exit codes                           |
| `src/*.test.ts`   | 77 tests                                             |

`yarn check` runs the type check and the unit tests. The tests never touch the
network: the semantic layer is exercised through `loadConfigSchema({ serialized })`,
which builds a real Backstage schema in memory, so the suite stays fast and
deterministic while still testing the actual validator.
