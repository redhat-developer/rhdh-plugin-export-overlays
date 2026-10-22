# Triage Labels

The agents speak in terms of dispatch roles and a failure taxonomy. This file maps those roles to the label strings used on this repository.

## Dispatch labels

| Role | Label | Effect |
|---|---|---|
| Triage dispatch | `ready-for-triage` | Triggers triage agent dispatch |
| Triage complete | `triaged` | Marks the issue as triaged |
| Code dispatch | `ready-to-code` | Triggers code agent dispatch |
| Review dispatch | `ready-for-review` | Triggers review agent dispatch |
| Ready to merge | `ready-for-merge` | All reviewers approved |
| E2E triage | `e2e-triage` | Triggers the fullsend e2e-triage agent |
| E2E fix | `e2e-fix-agent` | Triggers the fullsend e2e-fix agent |
| CI diagnosis | `ci-diagnose` | Triggers the fullsend ci-diagnose agent |
| Fix agent off | `fullsend-no-fix` | Skip bot-triggered fix agent runs |
| Needs information | `needs-info` | Blocks triage until the reporter answers |
| Blocked | `blocked` | Held outside the agent queues |

## PR scope labels

Applied by automation from the change scope: `workspace-update`, `workspace-addition`, `non-workspace-changes`, `release-branch-patch`, and `mandatory-workspace`. The scope decides which verification path applies, because `/publish` requires exactly one workspace ([knowledge/pr-workflow.md](knowledge/pr-workflow.md)).

## Mechanical labels

`needs-rebase`, `needs-commit-update`, `needs-ok-to-test`, and the `do-not-merge/*` family (`work-in-progress`, `hold`, `pending`) are applied by automation or by maintainers. Never apply a `do-not-merge/*` label to force a queue position.

## Risk labels

`risk/low`, `risk/moderate`, `risk/elevated` are set on pull requests. `risk/elevated` is a signal to a human, not a gate an agent may wave through.

## `fix_category` is not a label

It is a value in the E2E issue body — `test_fix`, `metadata_config`, or `product_bug` — and it decides what the fix agent may change. See [knowledge/e2e-fix-workflow.md](knowledge/e2e-fix-workflow.md).

## Gap

`knowledge/e2e-fix-workflow.md` describes labelling individual issues `blocked-by-workspace-failure` when a workspace is systemically broken but the issues are filed per test. That label does not exist on this repository yet; create it before using option (b).
