# Review Guide

Tells the reviewer what matters in this repo. Read `AGENTS.md` first; load the knowledge doc for each area the diff touches (index in `CONTEXT.md`).

## What failure looks like here

- **A PR that spans workspaces**: `/publish` and the `publish` status require exactly one workspace (`docs/agents/knowledge/pr-workflow.md`). Ask for one PR per workspace instead of reviewing around the constraint.
- **Version values that disagree**: `source.json` `repo-ref`, `backstage.json`, `versions.json`, and metadata `spec.version` / `spec.backstage.role` drifting apart in one diff (`docs/agents/knowledge/workspace-maintenance.md`).
- **Metadata that points at nothing**: a `spec.dynamicArtifact` holding a local path or an unpublished tag, an `appConfigExamples` entry no config emits, or a `kind: Plugin` YAML missing from `catalog-entities/extensions/plugins/all.yaml` (`docs/agents/knowledge/metadata-and-catalog.md`).
- **Patches that drift**: a CVE patch with no entry in the workspace's `cve-backports.yaml`, a `yarn.lock` hunk that does not fix the resolution it claims, or a fork substitution with no traceable source (`docs/agents/knowledge/patches-and-lockfiles.md`).
- **Config that bypasses generation**: hand-written OCI entries in a workspace `dynamic-plugins.yaml` standing in for what metadata `appConfigExamples` should generate (`docs/agents/knowledge/dynamic-plugins.md`).
- **E2E tests that cannot fail**: assertions satisfied by a pre-condition or an error state, `.or()` branches that mask the primary path, an assertion timeout equal to the test timeout, or `beforeAll` work with no `test.runOnce` guard (`docs/agents/knowledge/playwright-test-authoring.md`, `docs/agents/knowledge/e2e-testing.md`).
- **Skips that hide coverage**: a `test.skip` whose reason is a category rather than the broken component, a `product_bug` skip whose cause is metadata in this repo, or a missing sibling skip flagged without checking the sibling's arguments (`docs/agents/knowledge/e2e-fix-workflow.md`).
- **CI that leaks**: unpinned actions, `pull_request_target` with a PR checkout, secrets routed through `GITHUB_ENV`, untrusted input interpolated into a shell (`docs/agents/knowledge/scripts-and-ci.md`).
- **Docs that lie**: README, `user-guide/`, or knowledge-doc lines the diff makes stale — flag them, do not paraphrase around them. A troubleshooting anchor changed without a matching `REASON_ANCHORS` update breaks the generated status page.

## Evidence and output

- Every finding cites a file and line from the diff; a guess from a name is not a finding.
- Summary starts with a count: "N findings: X important, Y nit, Z pre-existing." When nothing needs fixing, say so plainly.
- Tag each finding Important / Nit / Pre-existing.
- Flag the class of bug with every occurrence, so the author fixes the pattern, not one line.
- A docs-only or `.fullsend/`-only PR needs `/publish` for the `publish` status; its absence is not a defect (`docs/agents/knowledge/pr-workflow.md`).

## Nits

- Style and formatting belong to lint — post none.
- Cap: three nits per review, each tied to a future bug it prevents.

## Paths to skip

Generated output only: `dist-dynamic/`, `dist-scalprum/`, `**/dist/`, `node_modules/`, `workspaces/*/e2e-tests/test-results/`, `playwright-report/`, `**/*.tgz`

## Convergence

- Round cap: after three rounds, ask the author to reconsider the approach.
- After the first pass, re-review only the new diff; never repost a finding.
- Every finding gets answered: fixed, or resolved with a reason.

## Always needs a human

CI workflow files, `.fullsend/` harness and policy configuration, `release-*` branch changes, new workspaces, `CODEOWNERS`, support-level promotion, and `default.packages.yaml`. Flag changes that contradict a recorded decision or a `user-guide/` procedure.
