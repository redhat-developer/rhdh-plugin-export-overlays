# Issue Tracker

Work in this repo is tracked in GitHub Issues on `redhat-developer/rhdh-plugin-export-overlays`. There is no external tracker. Fullsend (https://github.com/fullsend-ai/fullsend) drives the agentic SDLC — its agents triage, implement, review, and fix GitHub pull requests — and it files issues here itself.

## Where issues live

GitHub Issues on this repository. Fullsend may also file into `fullsend-ai/fullsend`; `.fullsend/config.yaml` `create_issues.allow_targets` is the allowlist.

## How issues arrive

- **Nightly E2E failures** — the nightly pipeline opens an issue labeled `e2e-triage` whose body carries a `PROW_URL: <url>` line. The triage agent groups failures by root cause across workspaces and the post-script files one issue per cause, or one workspace-level issue for a systemic workspace failure.
- **CI check failures** — an issue labeled `ci-diagnose` dispatches the diagnosis agent.
- **Humans** — free-form issue, then add a dispatch label.

## Working with issues

- **Triage**: `ready-for-triage` dispatches the triage agent, which reports severity, root cause, and a proposed fix.
- **Code**: `ready-to-code` dispatches the code agent on a triaged issue.
- **E2E fixes**: `e2e-triage` and `e2e-fix-agent` dispatch the E2E agents; those issues also carry a `fix_category` in the body.
- **PR review**: `/fs-review`, `/fs-fix`, `/fs-diagnose` on the PR.
- **Label meanings**: `docs/agents/triage-labels.md`.

## What triage writes

Every E2E issue states a `fix_category` — `test_fix`, `metadata_config`, or `product_bug`. That value, not the issue title, decides what the code agent may change. See [knowledge/e2e-fix-workflow.md](knowledge/e2e-fix-workflow.md).

## PRs

A PR names the issue that motivated it in its body. The issue remains the record of the failure until the PR merges and the nightly run goes green — closing the PR alone does not resolve it.
