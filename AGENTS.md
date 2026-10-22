# Agents

If `FULLSEND_OUTPUT_DIR` is set, read and follow `.fullsend/AGENTS.md` before doing any work.

## Agent-facing material

All agent-facing material lives in four places: this file (pointers and prohibitions), `CONTEXT.md` (orientation), `docs/agents/` (knowledge and tracker config), `.agents/skills/` (skills, symlinked into `.fullsend/skills/`). Bring a new harness in by pointing it at these files.

## Repository knowledge

`CONTEXT.md` holds high-level orientation — what this repo is, its two metadata layers, branching, support tiers — and an index into `docs/agents/knowledge/`. Read the knowledge doc for each area a change touches.

## Issue tracker

Work is tracked in GitHub Issues on this repository; fullsend triage and nightly jobs file issues here. Read `docs/agents/issue-tracker.md` before creating, searching, or updating one.

## Triage labels

Triage and the fix agents speak in terms of a fixed label and `fix_category` vocabulary. Read `docs/agents/triage-labels.md` before applying a label or acting on one.

## Reviewing

`REVIEW.md` is the reviewer contract: what failure looks like in this repo, what evidence a finding needs, and what always needs a human.

## Rules for E2E fixes

When fixing E2E test failures from `[fullsend] E2E:` issues:

**Allowed modifications**

- `workspaces/<workspace>/e2e-tests/` — any file under the e2e-tests directory
- `workspaces/<workspace>/metadata/` — only for `metadata_config` fixes

**Prohibited modifications**

- Plugin source code (`workspaces/*/plugins/`)
- CI configuration (`.github/`)
- Repository config (`AGENTS.md`, `CODEOWNERS`, `.fullsend/`)

The triage agent sets `fix_category` in the issue body, and it decides what you may change:

| Category | Root cause | Action |
|----------|-----------|--------|
| `test_fix` | Bug in the test code itself | Fix the test code |
| `metadata_config` | Incorrect workspace metadata or repo-local config | Fix the metadata/config, or flag for human review |
| `product_bug` | Upstream plugin code defect you cannot fix | Add `test.skip` |

For `product_bug`, skip with the condition that matches the failure scope:

```typescript
test.skip(!!process.env.E2E_NIGHTLY_MODE, "<root cause summary>");  // nightly only
test.skip(true, "<root cause summary> (release-X.Y)");             // branch-wide
```

Do not add `test.skip` for `metadata_config`. The full procedure — systemic workspace failures, out-of-scope causes, mode-dependent `configure()` options, skip-scope review, and verification commands — is in `docs/agents/knowledge/e2e-fix-workflow.md`.

## Adding guidance

New detailed knowledge goes in its own file under `docs/agents/knowledge/`, indexed from `CONTEXT.md`. `AGENTS.md` holds pointers and prohibitions only; do not add topic sections here.
