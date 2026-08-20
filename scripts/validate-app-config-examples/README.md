# validate-app-config-examples

Validates the `appConfigExamples` carried by Package metadata under
`workspaces/*/metadata/*.yaml`.

Three independent layers:

| Layer           | What it checks                                                                                                       | Jira        |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| Structural      | every Package has a non-empty first `appConfigExamples[].content`, or opts out via `spec.appConfigNotRequired: true` | RHIDP-12590 |
| Semantic        | each example's content satisfies the plugin's own config schema                                                      | RHIDP-13509 |
| Undeclared keys | within the subtrees a plugin's schema owns, every key is one it declares                                             | RHIDP-15902 |

The structural layer runs always and fails the run. The semantic layer is opt-in
via `--check-schemas` and fails unless `--warn-only`. The undeclared-key layer is
opt-in via `--check-undeclared-keys` and only ever reports.

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

# the full-tree sweep CI runs weekly and on workflow_dispatch
yarn node dist/validate.mjs --check-schemas --check-undeclared-keys
```

The full-tree sweep reports `mismatched: 0` as of RHIDP-15903, so it fails on a
mismatch rather than warning — the weekly schedule is what gives that verdict
somewhere to land, since a PR only ever sees the metadata it touched.
`--warn-only` remains for surveying a tree you have not cleaned up yet — a
release branch, say.

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
`spec.packageName` and `spec.version` the metadata already pins. That avoids
resolving upstream repo SHAs.

The published tarball is not quite what RHDH installs, though: this repo exports
a _patched_ build, and `workspaces/<ws>/patches/*.patch` can rewrite the plugin's
own `config.d.ts`. So the resolver replays those config schema patches onto the
extracted tarball before loading it. `workspaces/dynatrace-dql` is the case that
forced this — its patch fixes a union-precedence bug, and without replaying it
the validator reports a mismatch against a schema the overlay already corrected.
A patch that no longer applies makes the package `unavailable` rather than
falling back to the unpatched schema, since that fallback would resurrect
exactly the mismatch the patch exists to fix — and, unlike every other
`unavailable` reason, it **fails the run**. A package missing from the registry
is nobody's defect; a patch that has stopped applying is this repo's, and it
silently removes a package from validation. Failing is the only way the weekly
sweep can surface it, because an `unavailable` row otherwise stays `PASS`.

If a workspace patch rewrites the same-named config schema for two plugins of
one upstream monorepo, the package reports `unavailable` too: the directory that
would say which plugin a hunk belongs to is exactly what the strip level
discards, and validating against a sibling's schema is worse than not
validating.

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
- **undeclared keys outside the plugin's own subtrees.** See
  [Undeclared keys](#undeclared-keys) — inside them they are reported, but
  advisory.
- **anything behind an environment placeholder.** See below.
- **packages whose `config.d.ts` imports from their dependencies.** `npm pack`
  fetches the package alone with no `node_modules`, and config-loader compiles
  with `skipLibCheck: false`, so those fail to compile and report as
  `unavailable`. On a 29-package sample, 6 were affected. Installing each
  package's dependency tree would fix it at a cost this check cannot justify.

Three outcomes are reported as notes rather than failures, because none is a
defect in the metadata: the package declares no `configSchema`, it is not on the
registry, or its schema could not be compiled. **Every run that checks schemas
prints a tally** of validated / mismatched / no-schema / unavailable, and says so
explicitly when nothing was validated — otherwise an offline runner reports
`PASS: 180  FAIL: 0` having checked nothing, and the gate looks green because it
is inert.

### Environment placeholders

Examples write values the deployer supplies as `${SEGMENT_TEST_MODE}`, and
Backstage substitutes those **before** it validates anything. Checking the
literal `${...}` text against a declared boolean would therefore reject a value
that never reaches a schema in that form — which is exactly what happened to
`analytics-provider-segment` (RHIDP-15903).

Substitution yields a _string_ when the variable is set, and **removes the key**
when it is not — verified against config-loader's own `createSubstitutionTransform`
and `applyConfigTransforms`. This validator models only the set case, so an
example is accepted when some string assignment to its placeholders satisfies the
schema; a required property behind a placeholder is accepted here and would still
fail at startup with the variable unset. Modelling absence too would mask genuine
missing-required-property findings, which is why it is left out. Concretely the
validator retries with every placeholder set to `placeholder`, `true`, `false`,
and `0` in turn, and accepts if any of those validates. The errors it reports
are always the ones from the untouched document, so paths and values match what
is on disk.

This deliberately does not weaken structural checks: a placeholder where an
object or an array is declared is still reported, because no string can satisfy
that however the variable is set.

The leniency is candidate-based rather than schema-directed, so it reaches only
as far as those four values. Four kinds of field still report even though some
real environment value would satisfy them:

| field                                    | why the candidates miss it                                          |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `enum: [fast, slow]`                     | no candidate is a member                                            |
| `type: number, minimum: 1`               | `"0"` falls outside the bound                                       |
| `pattern`                                | the substituted text need not match                                 |
| placeholders on differently-typed fields | substitution is uniform per attempt, not a search over combinations |

None of these occurs in the catalogue today. The failure direction is a visible
false positive naming the exact path, never a silent pass — and closing them
means seeding the candidates from the failing path's own schema.

## Undeclared keys

Enabled with `--check-undeclared-keys` (which implies `--check-schemas`).
Reported, never failed (RHIDP-15902).

config-loader has a `noUndeclaredProperties` option, and neither half of it
works here.

**It is too broad about documents.** It rejects _every_ undeclared top-level
key, and examples legitimately carry keys belonging to no plugin schema — the
`dynamicPlugins` wrapper that 72 of 180 files use, and core Backstage blocks
like `catalog`, `backend` and `proxy`. So the example is first projected onto
the top-level keys the plugin's own schema declares; whatever remains is that
plugin's territory, and a key it does not declare there is a typo.

**It is too broad about schemas.** It closes every subschema stating
`type: "object"`, whether or not that subschema lists any properties. Given
`oneOf: [{required: [a]}, {required: [b]}]` with the properties declared on the
parent, closing the branches makes each reject the other's key — so the strict
run reports valid documents as carrying undeclared properties. This package
therefore builds its own strict variant (`rejectUndeclaredKeys`), closing only
nodes that actually enumerate properties, and leaving union branches alone.

Findings are the undeclared-property errors the strict run reports and the
lenient one did not. Restricting to that one error class keeps the label honest;
differencing against the lenient run stops a violation the plugin's own schema
already declares from being counted twice. A test pins config-loader's wording
for that error class, so a format change fails loudly rather than quietly
emptying this layer.

### The backlog, measured

A full-tree sweep today:

```
Undeclared keys — plugin-owned subtrees: 32  with findings: 7
```

32 of the 54 files with a resolvable schema set a top-level key their plugin
declares; the other 22 give this layer nothing to look at. Eight findings across
seven files, and they are not all typos:

- **Real.** `gitlab.host` / `gitlab.token` — neither the `@immobiliarelabs`
  gitlab frontend nor its backend declares either; GitLab credentials belong
  under `integrations.gitlab`.
- **Artefacts of validating one package in isolation.** `app.sidebar` under
  `global-header` and `events.http` under `events-backend-module-github` are
  core keys, declared by RHDH and by `@backstage/plugin-events-backend`
  respectively. A plugin that declares part of a shared top-level key does not
  own its siblings, and this layer cannot currently tell the difference.

That is why the layer is advisory. Blocking on it would mean fixing the
artefacts first — either by resolving sibling packages' schemas, or by narrowing
ownership below the top level.

Strictness closes only nodes that enumerate their properties, and only through
`properties`, `patternProperties`, `definitions`, `$defs`, `items`,
`additionalProperties` and the `anyOf`/`oneOf`/`allOf` lists. Nodes reached
through `not`, `if`/`then`/`else`, `contains`, `propertyNames`,
`dependentSchemas` or `prefixItems` are left open — `not` because tightening
inside a negation loosens it, the rest because under-reporting is the safe
direction for an advisory check.

Two things `plugin-owned subtrees` deliberately does not claim. It counts files
where the plugin declares a key the example sets — not files where a typo would
have been caught, since strictness only closes nodes that enumerate their
properties, and a schema describing a free-form object or leaning on `$ref` owns
a subtree in which nothing can be found. And a schema declaring its top-level
keys through `allOf`/`$ref` rather than a literal `properties` map yields no
declared keys at all, so its files are skipped silently.

## Layout

| Path              | Role                                                 |
| ----------------- | ---------------------------------------------------- |
| `src/json.ts`     | the shared mapping guard and error-property reader   |
| `src/metadata.ts` | YAML reading and the structural verdicts             |
| `src/schema.ts`   | package download, schema loading, example validation |
| `src/validate.ts` | CLI, reporting, exit codes                           |
| `src/*.test.ts`   | the unit tests                                       |

`yarn check` runs the type check and the unit tests. The tests never touch the
network: the semantic layer is exercised through `loadConfigSchema({ serialized })`,
which builds a real Backstage schema in memory, so the suite stays fast and
deterministic while still testing the actual validator.
