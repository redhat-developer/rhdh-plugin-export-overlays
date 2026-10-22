# Scripts and CI

How to review changes to `scripts/`, `smoke-tests-native/`, `.fullsend/`, and the workflows that gate merges — including which security findings are real here and which are calibrated for a threat model this repo does not have. What a mergeable PR looks like is in [pr-workflow.md](./pr-workflow.md); the tests these gates run are in [e2e-testing.md](./e2e-testing.md).

## GitHub workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `update-plugins-repo-refs.yaml` | Twice daily (12:00 and 19:00 UTC) + manual | Auto-generates PRs for plugin version updates |
| `publish-workspace-plugins.yaml` | Push to `main` / release branches | Publishes final OCI images, then smoke tests each workspace it just published against its new `bs_*` tag |
| `pr-actions.yaml` | PR comments | Handles `/publish`, `/smoketest`, `/override-backstage`, `/update-versions`, and `/update-commit` commands |
| `run-workspace-smoke-tests.yaml` | `workflow_call`, from `workspace-tests.yaml` | Verifies plugins load in an RHDH container. Runs on the PR's `pr_*` images, NOT on what was published — the published tag is covered by `publish-workspace-plugins.yaml` and the nightly sweep |
| `community-plugin-sweep.yaml` | Nightly per tier + manual | Load-tests every published package with the Docker-free `smoke-tests-native/` harness — one `spec.support` tier per nightly cron, largest tier first; the workflow's own `SUPPORT` block is the mapping |
| `catalog-index-sanity.yaml` | Daily + manual | Installs and boots every package the published plugin-catalog-index declares (same harness, catalog-index mode) |
| `check-backstage-compatibility.yaml` | Push to `main` + manual | Gates release branch creation on compatibility |
| `e2e-code-quality.yaml` | PRs touching `workspaces/*/e2e-tests/` | ESLint, Prettier, and TypeScript on changed E2E workspaces. Failures are merge-blocking |
| `sync-user-guide-to-wiki.yaml` | Weekly + manual | Syncs `user-guide/` to GitHub Wiki with placeholder injection |

### Triggering workflows manually

```bash
# Update plugin refs (e.g., for RBAC plugins on main)
gh workflow run update-plugins-repo-refs.yaml -f regexps="@backstage-community/plugin-rbac" -f single-branch=main

# Sync docs to wiki (dry run)
gh workflow run sync-user-guide-to-wiki.yaml -f dry_run=true
```

## Fullsend agent commands

AI agents run via [fullsend](https://github.com/fullsend-ai/fullsend). Slash commands are restricted to org members and collaborators.

On a PR:

- `/fs-review` — AI code review of the PR diff (findings, approve/comment verdict)
- `/fs-fix` — AI fix for review-requested changes (not available on fork PRs)
- `/fs-fix-stop` — Disable the fix agent for this PR (adds `fullsend-no-fix` label)
- `/fs-diagnose` — AI diagnosis of failed CI checks (E2E failures, build errors); also triggered automatically when CI fails via the `ci-diagnose` label

On an issue:

- `/fs-triage` — AI triage (severity, root cause, proposed fix)
- `/fs-code` — AI code generation for a triaged issue (requires the `ready-to-code` label)

For agent architecture and debugging, see [`docs/fullsend.md`](../../../docs/fullsend.md).

## The `scripts/` directory

`scripts/` holds **developer-facing CLI tools** and **CI pipeline scripts**. Nothing in it is deployed application code; nothing is packaged into an OCI image; nothing runs inside a user-facing service.

### Execution context and threat model

Both contexts are trusted:

1. **Local developer workstations** — CLI tools run by engineers on their own checkouts, including `npx`-invoked TypeScript tools for generating patches.
2. **CI pipelines** — automation run by GitHub Actions in a controlled environment with predefined inputs.

In both, the operator is a trusted user supplying intentional input: filesystem paths, git refs, workspace names. These scripts are **not** exposed to untrusted network input, user-submitted data, or adversarial callers.

### What lives there

| Category | Examples | Purpose |
| --- | --- | --- |
| Build infrastructure | `generateCatalogIndex.py`, `generatePluginBuildInfo.py`, `generateDynamicPluginsDefaultYaml.sh` | OCI resolution, metadata sync, DPDY generation |
| Coverage tooling | `upload-coverage.sh`, `seed-main-coverage.sh`, `refresh-coverage-snapshot.sh`, `remap-coverage.cjs` | E2E plugin coverage collection and reporting |
| Developer CLI tools | `scripts/yarnlock-backport/`, `scripts/validate-app-config-examples/` | Local-only `npx` tools for specific dev tasks |
| CI helpers | `e2e-code-quality.sh`, `update-index.sh`, `bootstrapPluginBuilds.py` | Workflow support |

### Calibrating security findings

Evaluate security findings against the trusted-local and trusted-CI context above, not against server-side heuristics built for untrusted input surfaces.

**Downgrade or skip:**

- **Path injection and traversal** on CLI tools that take filesystem paths as operator input. These tools accept absolute paths (`--overlay-workspace`, `--plugins-repo`) by design. Guards like `pathUnderBase` are correctness checks, not adversarial defences.
- **Command injection** on scripts that build shell commands from operator-supplied arguments — workspace names, git refs. The caller is an engineer or a CI pipeline, not an attacker.
- **TOCTOU races** on local file operations. These run single-user on local checkouts; concurrent adversarial modification is not a realistic threat.

**Keep:**

- **Correctness bugs** — does the tool produce correct output? Are regex capture groups consistent? Did a refactor change an execution condition?
- **Data integrity** — could a bug silently produce wrong patches, corrupt `yarn.lock`, or generate incorrect metadata?
- **CI reliability** — could a failure mode cause a silent pass or mask a real problem?
- **Genuine secret exposure** — hardcoded credentials, tokens, or API keys, as opposed to path-handling patterns.

## Identifying plugins consistently in build scripts

Three identifier derivations exist in the build pipeline, and they produce different strings for the same plugin:

1. **`yaml_file.stem`** — the metadata filename without extension, `cost-management` from `cost-management.yaml`.
2. **`metadata.get('name', yaml_file.stem)`** — the `metadata.name` field from the Package entity, falling back to the stem.
3. **`package_name_to_image_name(package_name)`** — the npm package name with the scope stripped and `/` replaced by `-`: `@red-hat-developer-hub/plugin-cost-management` becomes `red-hat-developer-hub-plugin-cost-management`.

For most plugins these diverge. `cost-management.yaml` has the stem `cost-management`, while `package_name_to_image_name()` yields `red-hat-developer-hub-plugin-cost-management`.

**Review check — one key derivation per plugin in `BuildReport` interactions.** When a change touches `bootstrapPluginBuilds.py` or `plugin_utils.py` around `add_plugin`, `set_stage`, or `remove_stale_plugins`, verify every code path — error handlers included — derives the key the same way. Inconsistent keys between success and error paths make `remove_stale_plugins()` prune valid entries or miss stale ones after a transient build failure.

Specifically:

- The key added to `expected_plugins` in the error path must match what the success path would have added for that plugin.
- The key passed to `report.set_stage()` in an exception handler must match the one `report.add_plugin()` uses in the normal flow.
- `yaml_file.stem` belongs only as a fallback when the parsed metadata name or package name is not yet available — before YAML parsing succeeds — not as a general-purpose key.

## Scripts that gate on structured pipeline data

Some scripts consume structured data from internal pipelines — the NFS readiness report, the catalog index, smoke test results — and gate CI on a classification. When reviewing one, verify the blocking logic can actually fire against real data, not just that the code is internally coherent.

1. **Verify value reachability.** When a script classifies items by specific values and exits non-zero on certain ones, check whether the upstream source produces all the values the gate depends on. A gate keyed on values the pipeline never emits is inert, and it gives false confidence that a check is running.
2. **Separate forward-compatibility from blocking logic.** Handling an unreachable value defensively is fine. Making it the only path to a blocking verdict is not — that is CI overhead with no signal.
3. **Test against current data.** If a gate produces zero blocking verdicts across all current data, flag it as a correctness concern. An inert gate is worse than no gate: it looks like validation. Ask whether it would catch the condition today if the condition existed.
4. **Read the pipeline, not only the schema.** The values a tool actually produces can be narrower than its output schema allows. Review how the upstream populates fields, not just what the schema permits.

**The NFS readiness example.** `scripts/nfs-readiness-report.sh` classifies frontend plugins by their `backstage.features` content, and the domain constraint matters:

- `rhdh-cli` populates `backstage.features` from the module-federation entry points it detects during `export-dynamic-plugin`. A plugin with no NFS entry points ends up with an **empty** field and is classified `no-features` — not `mixed` or `legacy-only`. Those two require a non-empty field containing non-NFS types, which the CLI does not produce.
- Reachable statuses are therefore `nfs-ready`, `no-features`, `unknown`, and `backend-only`. `mixed` and `legacy-only` are structurally unreachable, as the report's own "Reading the counts" note says.
- Before accepting that a gate here can fire, check the status distribution in the latest readiness report from the `nfs-readiness-report.yaml` workflow. A gate blocking on `mixed` or `legacy-only` alone never fires.

`rhdh-cli` changes, such as adding `nfsFeaturesExposed` under RHIDP-16463, may widen the reachable set. Re-evaluate the gates when that lands.

## Reviewing `smoke-tests-native` changes

The `smoke-tests-native/` harness validates published OCI plugin artifacts without running RHDH. It processes untrusted JSON from published bundles, so the constraints below apply.

### Untrusted input handling

Every field read from an artifact's `package.json`, `plugin-manifest.json`, or `.config-schema.json` is untrusted.

- **Filesystem APIs must not crash on adversarial input.** `statSync` throws on NUL-byte paths (`ERR_INVALID_ARG_VALUE`) and overlong names (`ENAMETOOLONG`); `throwIfNoEntry: false` only suppresses `ENOENT`. Wrap in try/catch or use a safe helper.
- **Empty strings and empty arrays are valid JSON.** An empty-string entry in `loadScripts` can resolve to the parent directory. Guard against empty and whitespace-only strings before touching the filesystem.
- **`typeof x === "object"` does not exclude arrays.** When validating JSON Schema objects such as `properties`, add `!Array.isArray(x)`.
- **One artifact's failure must not crash the sweep.** Isolate each plugin's validation so a malformed artifact produces a per-plugin error, not a workspace-level crash.

### Verify the consumer path

The harness validates artifacts RHDH will consume at runtime. When a check targets a specific file such as `configSchema.json`, confirm it reads the path the **runtime** reads, not the one `export-dynamic-plugin` writes. RHDH overrides default paths in several places — the schema locator in `packages/backend/src/index.ts` uses `dist-scalprum/configSchema.json` for frontend plugins, not the CLI default `dist/.config-schema.json`.

### Propagate errors distinctly

When a file cannot be read, the error must be distinguishable from "not declared" or "not found". Swallowing an I/O error as "undeclared" hides real problems. Follow the existing `nfsFeaturesError` pattern.

## Reviewing `.fullsend/` configuration

`.fullsend/` holds harness definitions, agent configs, policies, scripts, and environment files that control how fullsend dispatches and runs agent sandboxes. Reviewing a change there means knowing fullsend's architecture — not only whether the YAML parses, but whether the approach matches current platform conventions.

### Scaffold-managed versus repo-local

Files under `.fullsend/env/` split in two:

- **Scaffold-managed** — created and maintained by the fullsend CLI (`fullsend init`, `fullsend update`). These may be added, modified, or removed by version upgrades. Do not commit new env files there, and do not restore files upstream fullsend removed. A missing scaffold file means an intentional migration, not a bug.
- **Repo-local** — files under `.fullsend/rhdh/env/`, the repo-specific namespace. These belong to this repository and are safe to create and modify.

fullsend v0.33 removed `.fullsend/env/gcp-vertex.env` while migrating environment delivery to `env.sandbox` (ADR 0055). [#3523](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/3523) restored it by mistake; [#3527](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/3527) fixed it properly by passing Vertex environment variables through `env.sandbox` in the harness YAML.

### `env.sandbox` for variables, `host_files` for files

Custom harnesses such as `ci-diagnose` and `e2e-triage` should deliver environment variables through the `env.sandbox` section (ADR 0055), not through `host_files` pointing at scaffold env files.

```yaml
# Correct — variables delivered via env.sandbox
env:
  sandbox:
    MY_VAR: "${MY_VAR}"

# Incorrect — depends on a scaffold-managed env file
host_files:
  - src: env/some-scaffold-file.env      # may be removed by a fullsend upgrade
    dest: /sandbox/workspace/.env.d/file.env
    expand: true
```

`host_files` is still right for things that must exist as **files** in the sandbox: credential JSON, toolchain env files under `rhdh/env/`. The distinction is variables via `env.sandbox`, files via `host_files`.

### Review checklist

1. **Do `host_files` entries reference scaffold paths?** A `src:` not prefixed with the repo namespace — `env/...` rather than `rhdh/env/...` — is scaffold-managed and may vanish in an upgrade. Flag it and suggest `env.sandbox`.
2. **Is a deleted scaffold file being restored?** A new file under `.fullsend/env/` (not `.fullsend/rhdh/env/`) needs checking against the fullsend changelog.
3. **Does variable delivery follow ADR 0055?** Prefer `env.sandbox` over `host_files` with `expand: true`; the former survives scaffold upgrades and makes the flow explicit.
4. **Is the path repo-namespaced or scaffold?** `.fullsend/rhdh/` is repo-owned and safe. `.fullsend/env/`, `.fullsend/config.yaml`, and other top-level paths may be scaffold-managed and deserve extra scrutiny.

## The E2E code quality gate

The `E2E Code Quality` workflow (`e2e-code-quality.yaml`) runs on every PR touching `workspaces/*/e2e-tests/`. It enforces ESLint, Prettier, and TypeScript (`tsc --noEmit`) on the affected workspaces, and it is **merge-blocking**.

A Prettier formatting violation — a missing trailing newline is enough — fails CI even when it looks cosmetic in review. Treat any Prettier, ESLint, or TypeScript finding in these files as a CI-blocking defect, not a style suggestion.

The same script runs as a pre-commit hook once `git config core.hooksPath .githooks` is set, so a clean local run usually means a clean gate.
