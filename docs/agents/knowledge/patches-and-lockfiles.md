# Patches and Lockfiles

How to review and write changes under `patches/` — CVE backports, `yarn.lock` surgery, fork substitutions, and the manifests that record them. The version bump that usually accompanies a patch change is in [workspace-maintenance.md](./workspace-maintenance.md); what a reviewable PR looks like is in [pr-workflow.md](./pr-workflow.md).

## Which dependencies actually ship

This repo packages upstream plugins as dynamic plugin OCI images. Only the dependency subtrees of plugins listed in a workspace's `plugins-list.yaml` reach those images.

- **Shipped** — transitive dependencies of the exported plugins. These run in production.
- **Scaffold / dev-only** — dependencies used only by packages that are never exported: `app`, `app-legacy`, dev tooling such as `@graphiql/react`, documentation generators, test harnesses. They exist in the upstream `yarn.lock` and are never packaged.

The distinction decides whether a CVE patch is necessary at all. A package present in the upstream root `yarn.lock` is **not** automatically shipped — that lockfile covers the whole upstream workspace.

## Reviewing CVE and dependency patches

When a PR adds or modifies `patches/` files to address a CVE, or changes dependency versions for security reasons:

1. **Identify the vulnerable package** from the patch or the PR description.
2. **Verify reachability.** Confirm the package is in the shipped tree, not merely in the upstream `yarn.lock`.
3. **Do not approve without resolving reachability.** If the dependency is scaffold-only, say so. If reachability cannot be determined, request human verification rather than approving by default.

To check reachability:

1. Read `workspaces/<name>/plugins-list.yaml` to see which plugins are exported.
2. In the upstream source repo, inspect each exported plugin's `package.json` for the vulnerable package as a direct or transitive dependency.
3. If it appears only under non-exported packages — `packages/app`, `packages/app-legacy`, dev-only tooling — it is scaffold-only.
4. Remember that root `yarn.lock` membership proves nothing about shipping.

## Enumerating every version change

A `patches/*.patch` that touches `yarn.lock` usually changes more packages than its title admits. Regenerating a patch re-resolves incidental dependencies, and one of those incidental bumps can cross a major version without appearing in the title or the advisory.

1. **Parse the whole diff**, not the named package. Find every resolution entry whose version differs between the `-` and `+` sides.
2. **List every change** as `package old → new` in the review summary.
3. **Classify each** as major, minor, or patch. For `0.x` packages a minor bump carries major-level risk, because `^0.y.z` does not cross a minor boundary.
4. **Cross-reference the PR title.** Say which changes are named and which are incidental side effects of regeneration.
5. **Apply the major-version criteria below to every major change found**, not just the one in the title.

The review output must include the complete list even when everything is minor or patch-level. That is the evidence you examined the diff instead of the title.

## Major version crossings

When a patch bumps a dependency across a major version — including through an intermediate dependency — the risk is higher than for a minor or patch bump. Major versions carry documented breaking API changes, and this repo's patches bypass the upstream test suite, so nothing upstream catches the breakage for you.

1. **Detect it.** Compare old and new versions: a rising first numeric component (`2.2.1` → `3.0.8`) is a major bump.
2. **Read the changelog or migration guide.** Look for removed or renamed functions, changed return types, removed configuration options, altered default behaviour.
3. **Check whether exported plugins use the affected APIs.** Use `repo` and `repo-ref` from `source.json` to browse the upstream source at the pinned ref and search for imports of the changed APIs. If the dependency is scaffold-only the risk is lower — but still flag it when the patch forces the version across the entire `yarn.lock`.
4. **Flag for human verification** when breaking changes exist and the dependency is shipped. Do not approve on generic version-consistency checks alone.
5. **Check wrapper and type packages.** Major bumps drag companions with them: `@types/*` packages, and wrappers such as `react-use` that declare peer ranges. Confirm everything in the patch is mutually compatible.

A patch that builds does not prove runtime compatibility — plugin code that was never exercised during the build may still call the old API.

## Keeping lockfile patches minimal

Use [`yarn-lockfile-surgeon`](https://github.com/redhat-developer/rhdh/tree/main/scripts/yarn-lockfile-surgeon) to move one dependency to a specific version without re-resolving unrelated transitive entries. It lives in `redhat-developer/rhdh`; run `yarn-lockfile-surgeon <pkg>@<version>` against the workspace's `yarn.lock`, then `yarn install --mode=update-lockfile`.

A broad `yarn install` or parent-package bump resolves the whole tree and drags unrelated changes into the patch. That is unnecessary churn in a file whose only job is a security fix, and it makes the patch harder to review.

**Signals that surgeon was skipped:**

1. **Unrelated transitive bumps** — a patch fixing `js-yaml` should not also bump `@microsoft/api-documenter` and its tree.
2. **A parent package used as a proxy** — bumping `@backstage/backend-defaults` to pull in a transitive fix, rather than targeting the vulnerable package.
3. **Disproportionate scope** — far more changed packages than a targeted fix needs.

Running `yarn install --mode=update-lockfile` after surgeon can still move a few second-order entries to their latest resolution, so a handful of extra packages is not proof on its own. Look for the other two signals as well.

When flagging one, be specific:

> This patch bumps packages beyond the CVE-affected dependency (`<package>`). Consider using [`yarn-lockfile-surgeon`](https://github.com/redhat-developer/rhdh/tree/main/scripts/yarn-lockfile-surgeon) to bump only `<package>` to `<version>` (run `yarn-lockfile-surgeon <package>@<version>`, then `yarn install --mode=update-lockfile`), rather than bumping `<broader-package>`, which pulls in unrelated transitive dependency updates.

And when it is clean, say so — a targeted patch is worth acknowledging:

> The patch scope looks targeted — only `<package>` and its direct resolution chain are affected. This is consistent with `yarn-lockfile-surgeon` usage.

## Lockfile entry keys versus `package.json` specifiers

A lockfile patch can change an entry's **descriptor** — `"monaco-editor@npm:^0.55.0"` becoming `"monaco-editor@npm:0.56.0"` — independently of the resolved version. If the new key does not satisfy the specifier in the upstream `package.json`, `/publish` fails deterministically.

During `/publish`, Yarn runs with `--immutable`. When the lockfile key contradicts the `package.json` specifier, Yarn resolves to a different version than the patch declares and aborts with `YN0028: The lockfile would have been modified by this install, which is explicitly forbidden`. Retrying `/publish` will never clear it.

1. **Spot descriptor changes.** In the patch diff, look at the quoted key lines, not only the `version:` lines. Range-to-pinned (`^0.55.0` → `0.56.0`) is the common shape, but any specifier change needs checking.
2. **Verify the new version satisfies the original specifier.** Find the specifier in the upstream `package.json` at the `repo`/`repo-ref` in `source.json`. Watch **`0.x` caret ranges**, which are stricter than most people expect: `^0.55.0` means `>=0.55.0 <0.56.0`, so `0.56.0` is out of range, unlike `^1.y.z` which allows anything under `2.0.0`.
3. **Treat a violation as blocking.** It is a guaranteed `/publish` failure. The fixes are: keep the original range as the key and move only the resolved version within it; regenerate the patch against a ref whose `package.json` accepts the new version; or, rarely, have the patch also change the `package.json` specifier.

This check is independent of the major-version review. A patch can survive the API analysis and still fail here, so run both on every `yarn.lock` patch.

## Fork and scope substitutions

A patch can replace a package with a fork from a different scope:

```yaml
es5-ext: "npm:@unes/es5-ext@0.10.64-1"
```

That is not a version bump. The package identity and the publisher change, so the trust chain does. A version bump is governed by semver conventions and the original maintainer's release process; a fork offers no such contract, may diverge beyond its stated purpose, may not receive the original's security patches, and may be abandoned without notice.

1. **Detect the substitution.** A `npm:<other-scope>/<name>@<version>` resolving to a different package is a fork, not a bump.
2. **Assess provenance.** Who publishes it, why it exists, whether it is maintained. Look for a linked upstream issue, PR, or advisory explaining the divergence, and check the npm page for publisher, downloads, and last publish.
3. **Verify the fork's changes.** Compare it against the original at the equivalent version. Confirm it is limited to the stated purpose — no extra modifications, added dependencies, or altered behaviour.
4. **Check for an upstream alternative.** If the original shipped a fix, the fork is unnecessary. An upstream fix always beats a third-party fork.
5. **Assess maintenance risk.** A fork that does not track the original's CVEs becomes a liability later.
6. **Recommend CI verification** (below). Passing tests do not make the fork trustworthy — that judgement is manual.

Do not approve a fork substitution on build success alone. Acknowledge the substitution explicitly and either assess the supply-chain risk or request human review.

## `cve-backports.yaml` completeness

No workspace currently carries CVE patches — the existing `patches/*.patch` files are build fixes, so no `cve-backports.yaml` exists yet. This section is the policy for the first one: every workspace applying CVE patches through `0-cve-yarn-lock.patch` needs a `cve-backports.yaml` in the same `patches/` directory. Auditors read it to understand what was remediated and why; a missing entry means the remediation is invisible.

For every package whose version changes in the patch, require an entry with `cve_ids`, `package`, and `patch_version`. A missing entry is **medium severity** — do not downgrade it to informational, and do not approve or apply `ready-for-merge` while entries are missing.

1. Parse the lockfile patch and extract every package whose `version:` changes between the `-` and `+` sides.
2. For each, confirm a `backports` entry with a matching `package` and a `patch_version` covering the new version(s).
3. Flag anything in the patch with no manifest counterpart.

**Partial fixes still need an entry.** When a package is bumped but other resolution lines remain inside the affected range, list every resolved version in `patch_version` and record the residual exposure in `notes`, with the dependency spine showing who pulls in the vulnerable copy:

```yaml
- cve_ids:
    - CVE-2026-59873
    - CVE-2026-59874
  package: tar
  patch_version: 6.2.1, 7.5.22
  notes: |-
    [auto] tar@6.2.1 is still in CVE affected range; verify dev-only
    └─┬ @internal/lightspeed@1.0.0
      └─┬ @backstage/cli-defaults@0.1.0
        └─┬ keytar@7.9.0
          └─┬ node-gyp@10.2.0
            └── tar@6.2.1
```

**Entry removals need a reason.** An entry may legitimately go when the CVE was fixed upstream through a `source.json` `repo-ref` bump and the patch no longer touches that package. Verify that is the case; an unintentional removal erodes the audit trail.

## Source ref changes when patches exist

When a PR advances `repo-ref` in a workspace that carries `patches/*.patch`, the patches were authored against the previous commit. Context lines and offsets may no longer match, and `/publish` fails on the hunk. CVE patches are the usual casualty: once the new ref absorbs the fix, the patch is both redundant and incompatible.

1. **Check whether the same PR removes or updates the patches.** If it does, compatibility is already handled.
2. **If the patches are untouched, flag the risk.** The further the ref advances, the likelier the hunk fails.
3. **Check whether the new ref already contains the fixes.** If it does, ask for the patches to be removed in the same PR. Compare patch names against the upstream changelog between the two refs.
4. **Grade the severity.** Medium when patches are unchanged and the ref is more than a few commits ahead; low for a single-commit advance or when the PR description addresses compatibility.
5. **Ask for `/publish`** even when the patch looks compatible. Subtle context mismatches are invisible to inspection.

A ref change that leaves stale patches passes review and fails at publish, costing an extra cycle and a follow-up commit.

## Verifying with CI

Any PR that changes `patches/*.patch` in a way that touches `yarn.lock` — major, minor, or patch — must be verified in CI before merge. The patches bypass the upstream test suite, so these commands are the main mechanism for catching breakage.

| Command | What it confirms | When |
| --- | --- | --- |
| `/publish` | The patch applies cleanly and the OCI images build | Always — the minimum |
| `/smoketest` | All workspace plugins load and initialise in RHDH | Always, after `/publish` completes |
| `/test e2e-ocp-helm` | Plugins pass their runtime acceptance tests | When the workspace has `e2e-tests/` |

Do not approve a `yarn.lock` patch without at least `/publish` and `/smoketest`. These do not replace reading the patch — they catch the failure modes that reading it cannot: conflicts, missing dependencies, plugins that no longer load.

For major bumps and fork substitutions, add `/test e2e-ocp-helm` where it exists, since runtime behaviour is exactly what the API analysis is guessing about. Neither test replaces reading the dependency's changelog.
