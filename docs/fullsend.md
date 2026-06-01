# Fullsend AI Pilot

## What is fullsend?

[Fullsend](https://github.com/fullsend-ai/fullsend) is an agentic SDLC platform that provides AI-powered agents for triage, code review, code generation, and retrospectives. It runs as a GitHub Actions pipeline, triggered by GitHub events, and uses Vertex AI (Anthropic Claude) for inference.

## Pilot scope

### Enabled agents

| Agent | Trigger | How to use |
|-------|---------|------------|
| Triage | `/fs-triage` slash command | Post on any issue |
| Coder | `/fs-code` slash command, or `ready-to-code` label | Post on a triaged issue |
| Review | Auto-triggers on PR open/update | Automatic for `workspaces/backstage-plugins-for-aws/` PRs |
| Fix | `/fs-fix` slash command, or `changes_requested` review | Post on a PR, or request changes on a fullsend PR |

### Auto-trigger vs. manual trigger

Fullsend is designed to chain agents automatically (issue -> triage -> code -> review -> fix). In practice, most of that chain requires manual triggering. Here's what actually happens:

| Agent | Designed auto-trigger | What actually happens | How to trigger manually |
|-------|----------------------|----------------------|------------------------|
| Triage | `issues/opened` | **Does not auto-trigger.** The upstream dispatcher only handles `issues/labeled`, not `issues/opened`. | `/fs-triage` on an issue |
| Coder | `ready-to-code` label | **Does not auto-trigger from triage.** Triage labels issues `triaged`, not `ready-to-code`. | `/fs-code` on a triaged issue, or manually add `ready-to-code` label |
| Review | `pull_request_target/opened\|synchronize` | **Auto-triggers on `workspaces/backstage-plugins-for-aws/` PRs.** This is the only agent that reliably auto-triggers. Scoped via `paths` filter. | `/fs-review` on any PR (auth-gated) |
| Fix | `pull_request_review/submitted` with `changes_requested` | **Partially auto-triggers.** Only fires from bot reviews (e.g., fullsend-review requesting changes), not from human reviews. Effectively scoped to backstage-plugins-for-aws PRs because only those PRs get auto-reviewed. | `/fs-fix` on a PR, `/fs-fix-stop` to disable |

The "autonomous pipeline" does not chain automatically. In practice: review auto-triggers on backstage-plugins-for-aws PRs, everything else is slash-command-driven.

### Custom review agent

This repo uses a **customized review agent** with an 8th review dimension: **Workspace & catalog correctness**. This dimension is specific to the overlay/metadata nature of this repository and validates:

- `source.json` structure and pinned refs
- `plugins-list.yaml` consistency with metadata
- Package entity completeness (`metadata/*.yaml`)
- Catalog entity references (`catalog-entities/extensions/`)
- Support tier alignment (`rhdh-supported-packages.txt`, `rhdh-community-packages.txt`)
- Branch policy compliance (new workspaces only on `main`)

The custom `workspace-review` skill implements this dimension. It is only invoked when a PR touches files under `workspaces/` or `catalog-entities/`.

### Scope details

The `paths` filter (`workspaces/backstage-plugins-for-aws/**`) only applies to the `pull_request_target` event. Other triggers are repo-wide:

- **`issues`** — fires for all issues (fine, since auto-triage doesn't work; slash commands are auth-gated)
- **`issue_comment`** — fires for all comments (auth-gated to OWNER/MEMBER/COLLABORATOR)
- **`pull_request_review`** — fires for all PR reviews (no `paths` support for this event type). Fix is transitively scoped: it only auto-fires from bot reviews, and the review bot only auto-reviews backstage-plugins-for-aws PRs.

### What does NOT run

| Agent | Why |
|-------|-----|
| Retro | Out of scope for initial pilot |
| Prioritize | Out of scope for initial pilot |

## Slash commands

Slash commands are **restricted to org members and collaborators** via an `author_association` check in the workflow shim. This prevents external users from burning Vertex AI tokens on this public repo.

Available commands:

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

Note: the `paths` filter only affects the Review agent's auto-trigger. Triage, coder, and fix are already available repo-wide via slash commands.

## Post-merge setup

The fullsend CLI is **not** needed — all files are committed in this repo, and the GCP infrastructure (WIF providers, mint access) was pre-provisioned by the fullsend team for all three RHDH repos. Only GitHub variables/secrets and app access need to be set.

### 1. Set GitHub variables

```bash
gh variable set FULLSEND_MINT_URL --repo redhat-developer/rhdh-plugin-export-overlays \
  --body "https://fullsend-mint-gljhbkcloq-uc.a.run.app"
gh variable set FULLSEND_GCP_REGION --repo redhat-developer/rhdh-plugin-export-overlays \
  --body "global"
```

### 2. Set GitHub secrets

```bash
gh secret set FULLSEND_GCP_WIF_PROVIDER --repo redhat-developer/rhdh-plugin-export-overlays \
  --body "projects/855403973659/locations/global/workloadIdentityPools/fullsend-pool/providers/gh-redhat-developer-rhdh-plugin"
gh secret set FULLSEND_GCP_PROJECT_ID --repo redhat-developer/rhdh-plugin-export-overlays \
  --body "it-gcp-konflux-dev-fullsend"
```

### 3. Grant GitHub App access

The fullsend apps are already installed in the `redhat-developer` org with "selected" repository access. Add `rhdh-plugin-export-overlays` to each app's repository list:

| App | Settings URL |
|-----|-------------|
| fullsend-ai-coder | https://github.com/organizations/redhat-developer/settings/installations/133995246 |
| fullsend-ai-review | https://github.com/organizations/redhat-developer/settings/installations/133995557 |
| fullsend-ai-retro | https://github.com/organizations/redhat-developer/settings/installations/133995811 |
| fullsend-ai-prioritize | https://github.com/organizations/redhat-developer/settings/installations/133997091 |
| fullsend-ai-triage | https://github.com/organizations/redhat-developer/settings/installations/133997292 |

### 4. Test

Create a test PR touching `workspaces/backstage-plugins-for-aws/` — the review agent should auto-trigger.

## Authorization model

### Slash command auth gate

The dispatch job checks `author_association` on `issue_comment` events. Only `OWNER`, `MEMBER`, and `COLLABORATOR` can trigger agents via slash commands. External contributors are silently ignored.

### CODEOWNERS protection

The `.fullsend/` directory and `.github/workflows/fullsend.yaml` are protected via CODEOWNERS, requiring `@redhat-developer/rhdh-cope` approval. This prevents agents from modifying their own configuration.

### Inference authentication

Fullsend uses GCP Workload Identity Federation (WIF) to authenticate GitHub Actions runs against Vertex AI. The WIF provider is scoped to this specific repo. Credentials are stored as GitHub secrets, not in committed files.

## Configuration files

| Path | Purpose |
|------|---------|
| `.fullsend/config.yaml` | Declares enabled roles (triage, coder, review, fix) |
| `.fullsend/customized/agents/review.md` | Custom review agent with workspace & catalog review dimension |
| `.fullsend/customized/harness/review.yaml` | Review harness override (adds workspace-review skill, 20min timeout) |
| `.fullsend/customized/skills/workspace-review/SKILL.md` | Domain skill for validating workspace structure, metadata, and catalog entities |
| `.github/workflows/fullsend.yaml` | Event shim — routes GitHub events to fullsend's reusable workflows, with auth gate on slash commands |

## Custom agent and skills

### How customization works

Fullsend per-repo mode cannot register custom agent **stages** (the upstream `reusable-dispatch.yml` has hardcoded stages). The workaround is extending existing agents with custom **skills**. This repo customizes the `review` agent — triage, coder, and fix use standard upstream behavior.

Three files form the customization layer:

| File | What it does | Upstream equivalent |
|------|-------------|-------------------|
| `.fullsend/customized/agents/review.md` | Agent system prompt — defines identity, review dimensions, skill routing, output format | Built-in `review` agent in `fullsend-ai/fullsend` |
| `.fullsend/customized/harness/review.yaml` | Harness config — wires skills, sets timeout, configures validation loop | Built-in `review` harness |
| `.fullsend/customized/skills/workspace-review/SKILL.md` | Domain skill — encodes this repo's structural validation rules | No upstream equivalent (custom) |

### What the custom review agent changes

The standard fullsend review agent has 7 dimensions (correctness, intent alignment, platform security, content security, injection defense, style/conventions, documentation currency). This repo adds an **8th dimension: Workspace & catalog correctness**.

| Standard (dims 1–7) | Custom (dim 8) |
|---------------------|---------------|
| Provided by built-in `code-review` and `docs-review` skills | Provided by custom `workspace-review` skill |
| Generic — works on any codebase | Repo-specific — encodes this repo's structural invariants |
| Updated automatically when fullsend releases new versions | Must be manually maintained (see drift section) |

The `workspace-review` skill checks:

1. **source.json structure** — required fields, pinned refs (not `main`/`master`), Backstage version alignment
2. **plugins-list.yaml consistency** — entries match metadata files, valid CLI args
3. **Package metadata** — `kind: Package`, required spec fields, OCI ref pattern, valid roles
4. **Catalog entities** — Plugin YAML listed in `all.yaml`, valid references to Package entities
5. **Support tier alignment** — packages in the correct tier file, no duplicates
6. **Overlay/patch validity** — reasonable file types, valid unified diff format
7. **Branch policy** — new workspaces only on `main`, not on `release-*` branches
8. **Cross-references** — version bumps in `source.json` reflected in metadata updates
9. **Default packages** — new workspaces checked against `default.packages.yaml`

### How to update the custom skill

When this repo's conventions change (new metadata fields, new workspace structure, new branching rules), update the `workspace-review` skill:

```bash
$EDITOR .fullsend/customized/skills/workspace-review/SKILL.md
```

The skill is a markdown file that the review agent reads as instructions. Update the evaluation procedure, severity mappings, or common findings sections as needed. No fullsend CLI or restart is required — changes take effect on the next review run after merge.

To update the agent prompt itself (e.g., adding a 9th review dimension):

```bash
$EDITOR .fullsend/customized/agents/review.md
```

### Drift from upstream fullsend agents

The custom agent prompt and harness override are **full file replacements** — they do not inherit from upstream. When fullsend releases a new version with changes to the built-in review agent, those changes are **not automatically picked up** by the custom files.

**What drifts:**

| Component | Drift risk | Why |
|-----------|-----------|-----|
| Agent prompt (`agents/review.md`) | **High** — full replacement | Upstream may add new review dimensions, change output format, fix prompt bugs, or update pipeline mode schema fields |
| Harness config (`harness/review.yaml`) | **High** — full replacement | Upstream may add new host files, change pre/post scripts, update the validation loop, or change the sandbox image |
| Custom skill (`skills/workspace-review/SKILL.md`) | **None** — repo-specific | No upstream equivalent to drift from |
| Built-in skills (`code-review`, `pr-review`, `docs-review`) | **None** — loaded from upstream | These come from the fullsend image, not from this repo |
| Workflow shim (`.github/workflows/fullsend.yaml`) | **Low** — stable interface | The `@v0` tag is a semver contract; breaking changes would be `@v1` |
| Config (`.fullsend/config.yaml`) | **None** — declarative | Role list is read directly by upstream dispatcher |

**How to check for drift:**

```bash
# Compare agent prompt against upstream baseline
# (the rhdh-agentic repo was last synced at fullsend v0.12.0)
diff <(gh api repos/fullsend-ai/fullsend/contents/.fullsend/agents/review.md \
  -H "Accept: application/vnd.github.raw" 2>/dev/null) \
  .fullsend/customized/agents/review.md

# Check current fullsend version tag
gh api repos/fullsend-ai/fullsend/releases/latest --jq '.tag_name'
```

**When to sync:**

- After a fullsend minor version bump (e.g., v0.12 → v0.13) — check the release notes for review agent changes
- If review agent behavior changes unexpectedly — diff against the upstream baseline
- If the pipeline mode output schema changes — the `agent-result.json` format is the most sensitive drift surface

**How to sync:**

1. Read the upstream agent prompt and compare with `agents/review.md`
2. Merge any new dimensions, output format changes, or schema field changes into the custom prompt
3. Preserve the custom 8th dimension (workspace & catalog correctness) and skill routing
4. Update `harness/review.yaml` if upstream adds new host files, changes scripts, or bumps the image
5. Note the synced version in a comment at the top of each file

The rhdh-agentic repo follows the same pattern with its `openspec-review` skill — coordinate drift checks across both repos.

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

### Layer 3: Sandbox logs

Available in the workflow run logs under the sandbox creation step. Look for `fullsend run` output.

### Common issues

| Symptom | Likely cause |
|---------|-------------|
| Slash command ignored | Commenter is not OWNER/MEMBER/COLLABORATOR |
| Review doesn't trigger | PR doesn't touch files in `workspaces/backstage-plugins-for-aws/` |
| 403 from mint | Repo not in mint's `ALLOWED_ORGS` — contact fullsend team |
| `aiplatform.endpoints.predict` denied | WIF IAM binding missing on GCP project |
| Agent produces no output | Check transcript artifact for agent errors |

## Reference

For a comprehensive deep-dive into fullsend agents, customization, and debugging, see the [fullsend-agents.md](https://github.com/redhat-developer/rhdh-agentic/blob/main/docs/fullsend-agents.md) in rhdh-agentic.
