# Fullsend AI Pilot

## What is fullsend?

[Fullsend](https://github.com/fullsend-ai/fullsend) is an agentic SDLC platform that provides AI-powered agents for triage, code review, code generation, and retrospectives. It runs as a GitHub Actions pipeline, triggered by GitHub events, and uses Vertex AI (Anthropic Claude) for inference.

## Pilot scope

### Enabled agents

| Agent | Trigger | How to use |
|-------|---------|------------|
| Triage | `/fs-triage` slash command, or `ready-to-code` label | Post on any issue |
| Coder | `/fs-code` slash command, or `ready-to-code` label | Post on a triaged issue |
| Review | Auto-triggers on PR open/update | Automatic for `workspaces/backstage-plugins-for-aws/` PRs |
| Fix | `/fs-fix` slash command, or `changes_requested` review | Post on a PR, or request changes on a fullsend PR |

### Auto-trigger vs. manual trigger

| Agent | What actually happens | How to trigger manually |
|-------|----------------------|------------------------|
| Triage | **Does not auto-trigger on issue open.** The workflow only listens for `issues/labeled` to prevent external users from burning inference tokens on a public repo. | `/fs-triage` on an issue (auth-gated) |
| Coder | Does not auto-trigger from triage. Triage labels `triaged`, not `ready-to-code`. | `/fs-code` on a triaged issue, or manually add `ready-to-code` label |
| Review | **Auto-triggers on `workspaces/backstage-plugins-for-aws/` PRs.** Scoped via `paths` filter. | `/fs-review` on any PR (auth-gated) |
| Fix | Only auto-fires from bot reviews, not from human reviews. | `/fs-fix` on a PR, `/fs-fix-stop` to disable |

### Scope details

The `paths` filter (`workspaces/backstage-plugins-for-aws/**`) only applies to the `pull_request_target` event. Other triggers are repo-wide:

- **`issues`** — fires only on `labeled` events (not `opened/edited`, to prevent external token burning)
- **`issue_comment`** — fires for all comments (auth-gated to OWNER/MEMBER/COLLABORATOR)
- **`pull_request_review`** — fires for all PR reviews. Fix is transitively scoped: it only auto-fires from bot reviews, and the review bot only auto-reviews backstage-plugins-for-aws PRs.

### What does NOT run

| Agent | Why |
|-------|-----|
| Retro | Out of scope for initial pilot |
| Prioritize | Out of scope for initial pilot |

## Slash commands

Slash commands are **restricted to org members and collaborators** via an `author_association` check in the workflow shim. This prevents external users from burning Vertex AI tokens on this public repo.

| Command | What it does |
|---------|-------------|
| `/fs-triage` | Run triage on an issue |
| `/fs-code` | Generate code for a triaged issue |
| `/fs-review` | Run review on a PR |
| `/fs-fix` | Fix issues flagged in a review |
| `/fs-fix-stop` | Disable fix agent for a PR (adds `fullsend-no-fix` label) |

## How to expand review to more workspaces

Add paths to the `paths` filter in `.github/workflows/fullsend.yaml`:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, closed]
    paths:
      - "workspaces/backstage-plugins-for-aws/**"
      - "workspaces/your-new-workspace/**"  # add here
```

To enable review for ALL workspaces, remove the `paths` filter entirely.

## Customization

This install uses **standard upstream agents** with one custom script. The `.fullsend/customized/` scaffold directories are present as stubs for future customizations.

Note: unlike rhdh-plugins, this repo is not a yarn monorepo — workspaces contain overlay metadata (source.json, plugins-list.yaml, metadata/*.yaml), not npm packages. Yarn/corepack customizations are not needed here.

### Current customizations

| File | What it does |
|------|-------------|
| `scripts/pre-fix-rebase.sh` | Auto-rebases PR branch onto target before fix agent runs |

### Review agent architecture (v0.13.0+)

The review agent is an **orchestrator** that dispatches specialized sub-agents in parallel:

| Sub-agent | Model | What it evaluates |
|-----------|-------|------------------|
| `correctness` | opus | Logic errors, edge cases, test adequacy |
| `security` | opus | Auth, data exposure, injection defense |
| `intent-coherence` | sonnet | Scope, authorization, architectural fit |
| `style-conventions` | sonnet | Naming, idioms, code organization |
| `docs-currency` | sonnet | Documentation staleness |
| `cross-repo-contracts` | sonnet | API/schema backward compatibility (conditional) |

Sub-agent definitions live in `skills/pr-review/sub-agents/` as markdown files with frontmatter. The orchestrator reads and dispatches all of them in parallel.

### Customization layers (least to most invasive)

| Layer | Path | Drift risk |
|-------|------|-----------|
| **Add sub-agent** | `.fullsend/customized/skills/pr-review/sub-agents/{name}.md` | None — additive, no upstream to drift from |
| **Add skill** | `.fullsend/customized/skills/{name}/SKILL.md` | None — additive |
| **Override agent prompt** | `.fullsend/customized/agents/review.md` | High — full replacement, must sync on upstream releases |
| **Override harness** | `.fullsend/customized/harness/review.yaml` | High — full replacement |

### Adding a custom review dimension

To add a repo-specific review dimension (e.g., workspace metadata validation), create a sub-agent file:

```bash
mkdir -p .fullsend/customized/skills/pr-review/sub-agents
cat > .fullsend/customized/skills/pr-review/sub-agents/workspace-catalog.md << 'EOF'
---
name: review-workspace-catalog
description: Validates workspace structure, metadata consistency, and catalog entity correctness.
model: sonnet
---

# Workspace & Catalog

You are a metadata integrity reviewer for the rhdh-plugin-export-overlays repository.

**Own:** source.json structure (pinned refs, required fields), plugins-list.yaml
consistency with metadata, Package entity completeness, catalog entity references
(all.yaml index), support tier alignment, branch policy (new workspaces only on main).

**Do not own:** Code logic, security, naming style, documentation staleness.
EOF
```

This is dispatched alongside the standard sub-agents — no agent prompt override needed. Changes take effect on the next review run after merge.

### Reference

For examples of full agent customization (custom prompt + harness override + domain skills), see [rhdh-agentic](https://github.com/redhat-developer/rhdh-agentic/tree/main/.fullsend/customized). Note: full overrides require manual sync on upstream fullsend releases.

## Post-merge setup

GCP infrastructure (WIF provider, mint access) is pre-provisioned on `rhdh-sidekick-167988`. GitHub variables and secrets are already set (see observation doc entry 26).

### Verify prerequisites

```bash
# Check variables
gh variable list --repo redhat-developer/rhdh-plugin-export-overlays

# Check secrets
gh secret list --repo redhat-developer/rhdh-plugin-export-overlays

# Expected:
#   Variables: FULLSEND_MINT_URL, FULLSEND_GCP_REGION
#   Secrets:   FULLSEND_GCP_WIF_PROVIDER, FULLSEND_GCP_PROJECT_ID
```

### Grant GitHub App access

Ensure `rhdh-plugin-export-overlays` is in each fullsend app's repository access list:

| App | Settings URL |
|-----|-------------|
| fullsend-ai-triage | https://github.com/organizations/redhat-developer/settings/installations/133997292 |
| fullsend-ai-coder | https://github.com/organizations/redhat-developer/settings/installations/133995246 |
| fullsend-ai-review | https://github.com/organizations/redhat-developer/settings/installations/133995557 |

### Test

After merge, create a PR touching `workspaces/backstage-plugins-for-aws/` — the review agent should auto-trigger.

## Authorization model

### Slash command auth gate

The dispatch job checks `author_association` on `issue_comment` events. Only `OWNER`, `MEMBER`, and `COLLABORATOR` can trigger agents via slash commands. External contributors are silently ignored.

### CODEOWNERS protection

The `.fullsend/` directory and `.github/workflows/fullsend.yaml` are protected via CODEOWNERS, requiring `@redhat-developer/rhdh-cope @durandom @subhashkhileri` approval.

### Inference authentication

Fullsend uses GCP Workload Identity Federation (WIF) to authenticate GitHub Actions runs against Vertex AI. The WIF provider (`gh-rhdeveloper-plugin-export`) is scoped to this specific repo on `rhdh-sidekick-167988`. Credentials are stored as GitHub secrets.

## Configuration files

| Path | Purpose |
|------|---------|
| `.fullsend/config.yaml` | Declares enabled roles (triage, coder, review, fix) |
| `.fullsend/customized/` | Scaffold stubs for future agent/harness/policy/skill customizations |
| `.fullsend/customized/scripts/pre-fix-rebase.sh` | Auto-rebase before fix agent runs |
| `.github/workflows/fullsend.yaml` | Event shim with auth gate on slash commands |

## Debugging

### Layer 1: Workflow logs

```bash
gh run list --workflow=fullsend.yaml --repo redhat-developer/rhdh-plugin-export-overlays
gh run view <run-id> --repo redhat-developer/rhdh-plugin-export-overlays --log
```

### Layer 2: Agent transcripts

```bash
gh run download <run-id> --repo redhat-developer/rhdh-plugin-export-overlays -n transcript
```

### Common issues

| Symptom | Likely cause |
|---------|-------------|
| Slash command ignored | Commenter is not OWNER/MEMBER/COLLABORATOR |
| Review doesn't trigger | PR doesn't touch files in `workspaces/backstage-plugins-for-aws/` |
| 403 from mint | Repo not in mint's `ALLOWED_ORGS` — contact fullsend team |
| `aiplatform.endpoints.predict` denied | WIF IAM binding missing on GCP project |
| Agent produces no output | Check transcript artifact for agent errors |

## Reference

For a comprehensive deep-dive into fullsend agents, customization, and debugging, see [fullsend-agents.md](https://github.com/redhat-developer/rhdh-agentic/blob/main/docs/fullsend-agents.md) in rhdh-agentic.
