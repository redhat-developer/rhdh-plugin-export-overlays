# PR Workflow

How work gets scoped into PRs, what `/publish` does when a PR does not touch a workspace, how to prove a fix covers every affected workspace, and what belongs in which documentation. The update PR types the automation generates are in [workspace-maintenance.md](./workspace-maintenance.md); the CI gates a PR must clear are in [scripts-and-ci.md](./scripts-and-ci.md).

## PR commands

Comment on a PR to drive the automation:

- `/publish` — Build and publish test OCI images (tagged `pr_<number>__<version>`)
- `/smoketest` — Run smoke tests against last published artifacts (requires prior `/publish`)
- `/override-backstage` — Override workspace Backstage compatibility version (creates `backstage.json` and rewrites metadata OCI tags)
- `/update-versions` — Copy `versions.json` from the PR base branch onto the PR branch (release-line alignment)
- `/update-commit` — Re-run automatic plugin repo ref discovery for the single touched workspace and update the PR
- `/test` or `/test e2e-tests` — Run e2e tests. Only relevant for PRs that modify workspaces containing an `e2e-tests/` directory (e.g., the `backstage` workspace)

Fullsend's AI commands (`/fs-review`, `/fs-fix`, `/fs-diagnose`, `/fs-triage`, `/fs-code`) and the workflow reference are in [scripts-and-ci.md](./scripts-and-ci.md#fullsend-agent-commands).

## The single-workspace constraint

`/publish` and the workspace-scoped E2E verification behind `/test e2e-tests` require a PR to touch **exactly one** workspace. A PR spanning multiple `workspaces/*/` directories is rejected with `PR doesn't touch only 1 workspace` and cannot be verified through the standard flow.

**When work genuinely spans workspaces, file one issue and one PR per workspace.** Each single-workspace PR can then be verified independently with `/publish` and `/smoketest`, which is the whole point of the constraint — verification follows the workspace.

**When a cross-workspace PR is unavoidable**, say so in the description, and use `/test e2e-ocp-helm-nightly` as the verification path instead. It runs every workspace against released OCI images. When reading the results, focus on net-new failures corresponding to the PR's changes; pre-existing failures in other workspaces are expected noise, not evidence.

### `/publish` on a PR that touches no workspace

`main`'s ruleset requires one status check, `publish`. A PR touching no workspace never receives it from `auto-publish-pr.yaml`: the `prepare` job detects the change scope and returns early before creating the pending status, and every downstream job is gated on a workspace being present. The log line is:

```
PR #<n> does not touch exactly 1 workspace — skipping publish
```

The way through is `/publish` itself. `pr-actions.yaml` has an `add_no_workspace_comment` job that runs when the detected workspace is empty and posts `context: publish`, `state: success` — a deliberate no-op for exactly this case.

```bash
gh pr comment <n> --body '/publish'          # creates publish = success (no-op path)
gh pr view <n> --json statusCheckRollup      # confirm publish is SUCCESS before merging
```

Docs-only and `.fullsend/`-only PRs use this path. Precedent: [#3985](https://github.com/redhat-developer/rhdh-plugin-export-overlays/pull/3985) touched no workspace files and merged with `publish SUCCESS`. No admin bypass should be needed; keep `--admin` in reserve for when the status genuinely fails to appear, and record why in the merge comment.

## Covering every affected workspace in a fix

When an E2E failure issue names specific affected workspaces or projects:

1. **Enumerate** every workspace the issue body and any triage recurrence comments list as affected.
2. **Cross-reference** each against the changes you are proposing.
3. **Document exclusions** — for any affected workspace your fix does not cover, say why in the commit message or PR body. "Relies on auto-generation from metadata; the framework-level fix in e2e-test-utils handles this" and "uses guest auth, not affected by the OIDC issue" are the shape of a useful exclusion.
4. **Verify completeness before committing.** `grep -r` the pattern you are adding or changing across all workspace `e2e-tests` directories to confirm you have not missed existing configs that need the same change.

A fix that covers the workspace named in the issue title and silently drops the second one fails the same way the original failure did, a day later, under a new issue number.

## Documentation scope

`user-guide/` targets plugin developers already cleared to contribute to this repo. Each document has a technical scope:

- `01-getting-started.md` — technical setup: CLI installation, `source.json` configuration, workspace creation. Assumes business approvals are complete.
- `03-plugin-owner-responsibilities.md` — ongoing technical maintenance: metadata sync, version bumps, deprecation.
- `04-metadata-synchronization.md` — the Package metadata YAML format and sync workflow.
- `07-plugin-catalog-index.md` — the catalog index pipeline: how indexes are built, published, and consumed.

When reviewing a PR that modifies `user-guide/`, flag additions of business-process requirements — approvals, JIRA workflows, stakeholder agreements — to these technically scoped documents, and raise them for human discussion. They usually belong in a separate onboarding or governance document rather than inside a technical procedure.
