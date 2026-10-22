# E2E Test Fix Workflow

Reference for working a `[fullsend] E2E:` issue: how to judge whether a workspace is systemically broken, which `fix_category` allows what change, when to skip instead of fix, and what to verify before declaring a fix done. The framework, configuration, and runtime details are in [e2e-testing.md](./e2e-testing.md); writing and reviewing the tests themselves is [playwright-test-authoring.md](./playwright-test-authoring.md).

## Fix scope

When fixing E2E test failures from `[fullsend] E2E:` issues:

**Allowed modifications**

- `workspaces/<workspace>/e2e-tests/` — any file under the e2e-tests directory
- `workspaces/<workspace>/metadata/` — only for `metadata_config` fixes

**Prohibited modifications**

- Plugin source code (`workspaces/*/plugins/`)
- CI configuration (`.github/`)
- Repository config (`AGENTS.md`, `CODEOWNERS`, `.fullsend/`)

## Before anything else: is the workspace systemically broken?

Before classifying individual failures, measure the workspace-level failure ratio. When most tests in a workspace fail, the cause is usually systemic — infrastructure misconfiguration, a dependency incompatibility, a deployment failure — not several independent test bugs.

1. After the initial analysis pass, count failed versus passed tests per workspace.
2. If a workspace has 4 or more tests and at least 75% failed, classify it a **systemic workspace failure**.
3. For a systemic failure, either:
   - **(a)** file one workspace-level issue describing the pattern and listing every affected test, with `fix_category: product_bug` and the title `[fullsend] E2E: <workspace> — systemic workspace failure (<failed>/<total> tests)`; or
   - **(b)** file individual issues but label them `blocked-by-workspace-failure` and set `fix_category: product_bug`.

Option (a) is preferred — it avoids dispatching several code-agent runs at one systemic problem.

The reasoning: fixing a single assertion is pointless when the test cannot reach that assertion. Individual fixes in a broken workspace burn agent compute and reviewer time, and the PRs are routinely closed without merging once a human addresses the root cause. This check has to happen before per-test `fix_category` classification, because it overrides it for the whole workspace.

## Fix categories

The triage agent sets `fix_category` in the issue body. The category decides what the code agent may change and how it should respond.

| Category | Root cause | Code agent action |
| --- | --- | --- |
| `test_fix` | Bug in the test code itself | Fix the test code |
| `metadata_config` | Incorrect workspace metadata or repo-local config | Fix the metadata/config, or flag for human review |
| `product_bug` | Upstream plugin code defect the code agent cannot fix | Add `test.skip` |

### `metadata_config` versus `product_bug`

Classify as **`metadata_config`** when the root cause is in files that live in this repo and can be corrected without touching upstream:

- wrong `spec.dynamicArtifact` paths — a local filesystem path instead of `oci://ghcr.io/...`
- missing or incorrect `spec.appConfigExamples`
- wrong `spec.version` or `spec.backstage.role`
- incorrect `source.json` fields (`repo-ref`, `repo-backstage-version`)
- missing or malformed `plugins-list.yaml` entries
- incorrect E2E config files under `tests/config/`

Classify as **`product_bug`** only when the failure comes from a defect in the upstream plugin source — code in the repo referenced by `source.json`, not here.

### Working a `metadata_config` issue

Do not add `test.skip`.

1. **For unambiguous corrections** — a `spec.dynamicArtifact` pointing at `./dynamic-plugins/dist/...` instead of an OCI reference, for instance — make the metadata fix directly in `workspaces/<workspace>/metadata/`.
2. **For corrections needing domain knowledge** — choosing the right OCI tag, published version, or registry structure, such as deciding between `bs_1.52.0__0.19.1` and `bs_1.54.0__0.20.0` — flag the issue for human attention rather than guessing. Leave the test enabled so nightly runs keep surfacing the failure until someone resolves it.

### Working a `test_fix` issue

Update the assertions to correct values instead of skipping. Skipping reduces coverage and defers the real fix.

- When assertions reference stale catalog data — wrong plugin names, missing support tiers, wrong authors — read the correct values from the deployed catalog or the workspace metadata and update them.
- Use `test.skip` only as a last resort, when the correct replacement value cannot be determined from available data.

This applies both to the remediation steps written into the triage issue and to the code agent implementing the fix.

## Deployment mode validation

Before implementing any fix that uses `rhdh.configure()` options or framework features, confirm they take effect in nightly mode.

Options that modify auto-generated plugin configuration — `disablePlugins` most obviously — only apply in PR mode (when `GIT_PR_NUMBER` is set) and are silently ignored in nightly and local dev. A fix built on a PR-only feature will not resolve a nightly failure. Cross-check the remediation against the mode tables below before writing it.

### `disablePlugins`

Removes named plugins from the auto-generated dynamic plugins configuration. It takes effect only in **PR mode** and **local dev**, because auto-generation only runs there. In nightly mode plugins come from fixed OCI refs in `spec.dynamicArtifact` and generation is skipped entirely, so the option is silently ignored.

| Mode | Auto-generation runs? | `disablePlugins` effect |
| --- | --- | --- |
| **PR** (`GIT_PR_NUMBER` set) | Yes | Removes named plugins from generated config |
| **Local dev** (neither set) | Yes | Removes named plugins from generated config |
| **Nightly** (`E2E_NIGHTLY_MODE`) | No | **No effect** — silently ignored |

**Do not add mode guards around `disablePlugins`.** It is already a no-op in nightly, so `isNightlyMode ? {} : { disablePlugins: [...] }` is complexity with no purpose. Pass it unconditionally:

```typescript
// Correct — harmless in nightly mode
await rhdh.configure({
  auth: "keycloak",
  disablePlugins: ["@scope/plugin-foo"],
});

// Unnecessary — do not do this
const isNightly = !!process.env.E2E_NIGHTLY_MODE;
await rhdh.configure({
  auth: "keycloak",
  ...(!isNightly && { disablePlugins: ["@scope/plugin-foo"] }),
});
```

### `dynamicPlugins`

Overrides the auto-generated plugin configuration with a custom `dynamic-plugins.yaml`. Unlike `disablePlugins`, this one **does** have mode-dependent side effects that need conditional handling: in nightly mode, passing any `dynamicPlugins` option makes the framework generate `disabled: true` entries for baked-in plugins from `dynamic-plugins.default.yaml`, breaking tests that depend on them.

| Mode | `dynamicPlugins` behaviour |
| --- | --- |
| **PR** (`GIT_PR_NUMBER` set) | Overrides generated config; use `plugins: []` to avoid duplicate keys against baked-in plugins |
| **Local dev** (neither set) | Overrides generated config; baked-in plugins load from defaults |
| **Nightly** (`E2E_NIGHTLY_MODE`) | **Generates `disabled: true` for baked-in plugins** — pass only when you need to override nightly config |

For workspaces using baked-in plugins, guard it:

```typescript
const isNightly = !!process.env.E2E_NIGHTLY_MODE;
await rhdh.configure({
  auth: "keycloak",
  ...(!isNightly && { dynamicPlugins: "tests/config/dynamic-plugins.yaml" }),
});
```

### Reviewing `configure()` calls

- **Unnecessary mode guards around `disablePlugins`** — flag as complexity; the option is already inert in nightly.
- **Missing mode guards around `dynamicPlugins`** in workspaces with baked-in plugins — flag, since it disables them in nightly.
- **Untested mode interactions** — when a change alters plugin loading, verify all three modes, not just the one under test.

## What is out of scope for an E2E fix

Some failures have root causes above the test layer. Recognise them before dispatching work.

### Platform-layer causes

Root causes outside both test logic and workspace metadata:

- a previously bundled plugin removed from the RHDH image, such as the guest auth provider
- a default dynamic plugin configuration changed between RHDH versions
- a new plugin dependency not yet onboarded in `default.packages.yaml`

Fixing these means changing `default.packages.yaml` or workspace metadata, which is outside the E2E fix scope. When the cause is platform-layer:

- do not classify it `fix_category: test_fix`
- note in the issue that the fix needs `default.packages.yaml` or metadata changes
- flag for human triage rather than dispatching the code agent under E2E constraints

A per-workspace workaround — adding OCI entries to one workspace's `dynamic-plugins.yaml` — can be technically correct and still be wrong: it bypasses auto-generation, drifts from platform defaults, and is superseded the moment the plugin is properly onboarded.

### Fixes that belong upstream

When the remediation points at `@red-hat-developer-hub/e2e-test-utils` or another external dependency:

1. Do not create per-workspace workaround PRs, such as entries in `dynamic-plugins.yaml` the framework should be generating.
2. Comment on the issue explaining that the fix is outside the code agent's scope, naming the upstream package that needs it.
3. If the issue already describes the upstream fix clearly, include that description in the comment so a human can act on it.

Signals: the remediation names e2e-test-utils, the fix modifies framework-managed config such as auth profiles or deployment defaults, or the same change would have to be repeated in every workspace.

## Verifying the fix actually fixed it

When the fix agent decides no code change is needed, it must check CI before declaring success. Use `gh pr checks` or `gh run list` against the target test or workspace.

- If CI shows a deterministic failure in the same test or workspace, investigate the actual output rather than trusting the triage analysis.
- Do not report success on the original commit SHA while the test you were asked to fix is still failing. Either attempt a fix or state plainly that you cannot resolve it, and why.
- When triage says "no changes needed" and CI disagrees, CI wins. Triage evaluates the approach; CI evaluates the implementation.

After changes, run from the workspace's `e2e-tests` directory:

```bash
npx tsc --noEmit
npx eslint <changed-files>
npx prettier --check <changed-files>
```

## When to skip a test

### Choose the skip condition from the failure scope

**Mode-specific** — the failure occurs only in nightly, for example a plugin present in PR-built images but absent from released OCI refs. Compare against the plugin metadata resolution table: PR mode uses PR-built OCI images while nightly uses the released refs in `spec.dynamicArtifact`, so a plugin can exist in one and not the other.

```typescript
test.skip(!!process.env.E2E_NIGHTLY_MODE, "<root cause summary>");
```

**Branch-wide** — the failure occurs on a release branch regardless of mode, for example a plugin or support type absent from that branch's catalog index image, which nightly and PR modes share. If the branch never contained the feature, the failure is not mode-dependent, so skip unconditionally:

```typescript
test.skip(true, "<root cause summary> (release-X.Y)");
```

Do not add `test.skip` for `metadata_config`.

### Make the reason specific

The root cause summary should name the broken component, not a category. Preserve the specificity of the triage issue's failure message.

- Bad: `"Theme selector button not rendered"` — which theme button?
- Good: `"QE theme selector buttons not rendered in NFS/app-next mode"` — names the plugin and component.
- Bad: `"API call fails"` — which API?
- Good: `"Catalog refresh API returns 503 when TechDocs backend is unavailable"` — names the endpoint and condition.

Specific reasons let reviewers judge whether sibling tests are affected without reading the whole failure log.

### Reviewing a `test.skip` addition

When a PR skips one test, ask whether sibling tests calling the same helper also need skipping. Do not flag a sibling on shared method usage alone — verify at the argument level.

1. **Check the actual failure signature** from the triage issue: which selector, element, or assertion failed? `button[title="Select RHDH Plugins QE Light"]` names one DOM element, not all theme buttons.
2. **Examine argument values, not method names.** A parameterised helper like `setTheme(themeName)` produces different selectors per argument — `"Select Light"` versus `"Select RHDH Plugins QE Light"` target entirely different UI.
3. **Trace the sibling's arguments through to the selector.** Only flag it if its arguments hit the same broken path.
4. **Cross-reference execution order.** If the failing test iterates values and failed on a later one, the earlier values are confirmed working. A sibling using only those is unaffected.

Do not flag a missing `test.skip` without establishing that the sibling's arguments produce the same broken behaviour.
