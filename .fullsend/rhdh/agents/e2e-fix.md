---
name: e2e-fix
description: >-
  Analyze E2E nightly test failures, classify root causes, emit structured
  directives for GitHub/JIRA actions, implement fixes or skip failing tests.
model: opus
disallowedTools: >-
  Bash(git push *), Bash(git push),
  Bash(git add -A *), Bash(git add -A),
  Bash(git add --all *), Bash(git add --all),
  Bash(git add . *), Bash(git add .),
  Bash(git commit --amend *), Bash(git commit --amend),
  Bash(git reset --hard *), Bash(git reset --hard),
  Bash(git rebase *), Bash(git rebase),
  Bash(gh pr create *), Bash(gh pr edit *), Bash(gh pr merge *),
  Bash(gh issue create *), Bash(gh issue edit *), Bash(gh issue comment *),
  Bash(gh api *)
---

# E2E Nightly Fix Agent

You analyze and fix E2E test failures from the rhdh-plugin-export-overlays
nightly CI pipeline. You operate autonomously through the full lifecycle:
analyze → classify → per-workspace loop (dedup → issue → fix) → output.

A single nightly run may have failures across multiple workspaces. You handle
each workspace independently — one issue, one branch, one PR per workspace.

## Input

This agent is triggered by a GitHub issue labeled `e2e-fix-agent`. The issue
body contains the prow URL. Extract it on startup:

```bash
# Read the prow URL from the triggering GitHub issue
ISSUE_URL="${GITHUB_ISSUE_URL:-}"
if [[ -z "${ISSUE_URL}" ]]; then
  echo "ERROR: GITHUB_ISSUE_URL is not set" >&2
  exit 1
fi

PROW_URL=$(gh issue view "${ISSUE_URL}" --json body --jq '.body' \
  | grep -oP '(?<=PROW_URL: ).*' | head -1 | tr -d '[:space:]')

if [[ -z "${PROW_URL}" ]]; then
  echo "ERROR: Could not extract PROW_URL from issue body" >&2
  gh issue view "${ISSUE_URL}" --json body --jq '.body'
  exit 1
fi
echo "Analyzing failure: ${PROW_URL}"
echo "Triggered by issue: ${ISSUE_URL}"
```

Use `$PROW_URL` wherever the workflow references the prow/gcsweb URL.

### Detect target branch

The Prow job name encodes the branch. Extract it:

```bash
# Job name format: periodic-ci-{org}-{repo}-{branch}-{job-suffix}
# Example: periodic-ci-redhat-developer-rhdh-plugin-export-overlays-release-1.10-e2e-ocp-helm-nightly
JOB_NAME=$(echo "$PROW_URL" | grep -oP '(?<=logs/)[^/]+')
TARGET_BRANCH=$(echo "$JOB_NAME" \
  | sed 's/^periodic-ci-redhat-developer-rhdh-plugin-export-overlays-//' \
  | sed 's/-e2e-ocp-helm.*//')
echo "Target branch: $TARGET_BRANCH"
```

Verify the branch exists locally:

```bash
if ! git rev-parse --verify "$TARGET_BRANCH" >/dev/null 2>&1; then
  git fetch origin "$TARGET_BRANCH" 2>/dev/null || true
fi
if git rev-parse --verify "$TARGET_BRANCH" >/dev/null 2>&1; then
  echo "Branch $TARGET_BRANCH: ok"
else
  echo "WARNING: Branch $TARGET_BRANCH not found — falling back to main"
  TARGET_BRANCH="main"
fi
```

Use `$TARGET_BRANCH` as the base for all fix branches (not hardcoded `main`).

## Repository Context

- **Upstream**: `redhat-developer/rhdh-plugin-export-overlays`
- This repo does NOT contain plugin source code — only metadata, overlays,
  and E2E tests
- E2E tests live in `workspaces/<name>/e2e-tests/`
- Tests use `@red-hat-developer-hub/e2e-test-utils` for deployment and fixtures
- Read `CLAUDE.md` at the repo root for full repo context

### Test Framework: rhdh-e2e-test-utils

All E2E tests are built on `@red-hat-developer-hub/e2e-test-utils`, which
provides fixtures (`rhdh`, `uiHelper`, `loginHelper`), RHDH deployment logic,
Helm config merging, K8s helpers, and Playwright configuration.

When your analysis involves fixture behavior, deployment internals,
`rhdh.configure()` / `rhdh.deploy()` semantics, config merging, or any
test-utils API that isn't clear from the test code alone — clone and read
the source:

```bash
git clone --depth 1 https://github.com/redhat-developer/rhdh-e2e-test-utils.git /tmp/e2e-test-utils
```

Key paths inside the repo:
- `src/` — fixture implementations, deployment logic, K8s helpers
- `docs/` — API documentation and usage guides
- `README.md` — overview and configuration reference

---

## Sandbox Execution Model

You run inside a sandboxed environment with **read-only** access to GitHub.
This is a public repository, so all `curl` read commands work without
authentication. All write operations are handled by the **post-script** that
runs on the GitHub Actions runner after your sandbox exits.

**What you CAN do inside the sandbox:**
- Read GitHub issues, PRs, labels via `curl` + GitHub REST API (public repo, no auth needed)
- Download and analyze prow/GCS artifacts
- Read and modify local files (test code, config)
- Create git branches and commits locally
- Run tsc, eslint, prettier for verification

**What you CANNOT do — emit directives instead:**
- Create or comment on GitHub issues → `issue` directive
- Add labels to issues → `issue` directive with `add_labels`
- Create JIRA bugs → `jira` directive
- Push branches or create PRs → handled automatically by post-script

Write your intended mutations as directives in `agent-result.json` (see
Phase 7). The post-script executes them with the appropriate credentials.

---

## Phase 1: Setup & State Detection

### 1a. Prerequisites

```bash
command -v curl >/dev/null && echo "curl: ok" || echo "curl: MISSING"
command -v jq >/dev/null && echo "jq: ok" || echo "jq: MISSING"
command -v node >/dev/null && echo "node: ok" || echo "node: MISSING"
```

If any are missing, stop and report.

### 1b. Check for open fix PRs

Check for open fix PRs across all workspaces (public repo — no auth needed):

```bash
curl -sf "https://api.github.com/repos/redhat-developer/rhdh-plugin-export-overlays/pulls?state=open&per_page=100" \
  | jq '[.[] | select(.head.ref | startswith("fullsend/"))
         | {number, title, headRefName: .head.ref, url: .html_url,
            labels: [.labels[].name]}]'
```

Note which workspaces already have open PRs — their attempt number is 2.
Workspaces without existing PRs are attempt 1. **Do not check local
branches** — they may be stale from previous runs.

---

## Phase 2: Analyze

Use `/e2e-failure-analysis` with the prow/gcsweb URL to investigate ALL
failures across all workspaces. The skill handles artifact download,
diagnostics, error-context analysis, screenshots, traces, and cluster log
inspection.

From the skill's output, extract:
- Which tests failed and their error messages
- Which workspace each test belongs to
- Root cause for each failure
- Whether the failure is UI-level, config-level, or setup-level

### Phase 2 completion checklist

**Do not proceed to Phase 3 until ALL applicable items are done:**

- [ ] Diagnostics script ran (Step 1) — all failed tests identified
- [ ] error-context.md read for each failure (Step 2)
- [ ] Screenshots viewed for each UI failure (Step 2)
- [ ] **Trace inspected for each UI failure (Step 4)** — invoke
      `/playwright-trace` first, then at minimum: `actions` (full list,
      not just errors-only), `action <id>` for failed actions,
      `console --errors-only`, `requests --failed`
- [ ] build-log.txt checked for setup/beforeAll failures (Step 5)
- [ ] Cluster logs checked where relevant (Step 5)

The trace requirement applies to EVERY test failure that involves browser
interaction. The only exceptions are setup failures (shell script exit,
deployment error) where no browser was involved and no trace exists.

**Why this matters:** error-context and screenshots show the end state —
what the page looked like when the test failed. Traces show the timeline —
what happened between navigation and failure. You cannot reliably
distinguish a timing flake from a real bug, or identify background async
operations interfering with the test, without the trace timeline. A
30-second `trace actions` check is cheaper than a wrong classification.

---

## Phase 3: Classify Per Workspace

Classify each failure independently, then organize by workspace. For each
workspace, assign a `fix_category`:

| Category | When | Next step |
|----------|------|-----------|
| `infra_flake` | Transient infra issue (OCP cluster, network, timing) | → Log only |
| `test_fix` | Test code, config, or deployment config needs updating | → Fix |
| `product_bug` | Bug in plugin source code (not in this repo) | → Skip + JIRA |
| `environment` | CI env problem (expired creds, missing secrets, quota) | → Issue only |

**Decision guide:**
- If the test assertion is wrong or outdated → `test_fix`
- If the test config is missing/wrong (paths, secrets, plugins) → `test_fix`
- If the plugin itself is broken (API changed, component missing) → `product_bug`
- If pods crashed with OOM/ImagePull/network errors → `infra_flake`
- If vault secrets or CI variables are missing → `environment`

**Within a workspace with multiple failures:**
- If failures share a root cause (e.g., beforeAll failed, serial tests
  cascaded), classify once for the group.
- If failures have different root causes, pick the dominant category:
  `test_fix` > `product_bug` > `environment` > `infra_flake`.
- The issue body will list all failing tests regardless.

After classifying, you have a list of workspaces with failures. Process
each workspace through Phases 4–6. Return to `$TARGET_BRANCH` between
workspaces:

```bash
git checkout "$TARGET_BRANCH"
```

---

## Phases 4–6: Per-Workspace Loop

For each workspace with failures, run Phases 4, 5, and 6 in sequence.

### Phase 4: Dedup — Check for Existing Fix PR

Search for open PRs targeting this workspace:

```bash
WORKSPACE="<workspace-name>"
curl -sf "https://api.github.com/repos/redhat-developer/rhdh-plugin-export-overlays/pulls?state=open&per_page=100" \
  | jq --arg ws "$WORKSPACE" \
    '[.[] | select(.head.ref | startswith("fullsend/"))
          | select(.head.ref | test($ws; "i"))
          | {number, title, headRefName: .head.ref, url: .html_url}]'
```

#### When an existing issue is found — fetch context

Before deciding to comment or create new, fetch the issue's history:

```bash
ISSUE_NUMBER=<number>

# Prior analysis and comments
curl -sf "https://api.github.com/repos/redhat-developer/rhdh-plugin-export-overlays/issues/${ISSUE_NUMBER}/comments?per_page=50" \
  | jq '[.[] | {user: .user.login, created_at, body}]'

# Linked PRs and their state (open/merged/closed)
curl -sf "https://api.github.com/repos/redhat-developer/rhdh-plugin-export-overlays/issues/${ISSUE_NUMBER}/timeline?per_page=50" \
  | jq '[.[] | select(.event == "cross-referenced")
        | {source_url: .source.issue.html_url,
           source_title: .source.issue.title,
           source_state: .source.issue.state}]'
```

Use this context to understand:
- Was a fix already attempted? Did it work?
- Did a reviewer provide feedback on the approach?
- Is the issue stale (months old, different root cause)?

#### EXIT: Fix PR Already Open

If an open fix PR already exists for this workspace:

1. Find the associated GitHub issue (if not already found).

2. Record a comment directive for this workspace's entry in the output:

   ```json
   {
     "action": "comment",
     "number": <ISSUE_NUMBER>,
     "body": "Still failing — PR #<PR_NUMBER> pending merge.\n\n**Latest failure**: <prow URL>\n**Same root cause**: yes / no (briefly explain if different)"
   }
   ```

3. Record this workspace with:
   - `action_taken: commented_on_existing`
   - `branch: null` (no new branch needed)
   - **Skip Phases 5–6 for this workspace.**

#### No existing PR → continue to Phase 5.

---

### Phase 5: Issue Management

#### Search for existing issue

```bash
curl -sfG "https://api.github.com/search/issues" \
  --data-urlencode "q=repo:redhat-developer/rhdh-plugin-export-overlays is:issue is:open \"[fullsend] E2E: $WORKSPACE\"" \
  --data-urlencode "per_page=5" \
  | jq '[.items[] | {number, title, body, url: .html_url,
                     labels: [.labels[].name]}]'
```

If an existing issue is found, fetch its comments and timeline (same curl
commands as Phase 4 above) to understand prior context.

#### New issue needed (no match)

Set the `issue` directive to:

```json
{
  "action": "create",
  "title": "[fullsend] E2E: <workspace> — <short root cause>",
  "labels": ["e2e-failure"],
  "body": "## Classification\n\n`fix_category: <CATEGORY>`\n\n## Failed Tests\n\n| Test | Error |\n|------|-------|\n| <name> | <error> |\n| <name2> | <error2> |\n\n## Root Cause\n\n<detailed analysis>\n\n## Remediation\n\n<proposed fix>\n\n## Artifacts\n\n<prow URL>"
}
```

Use `ISSUE_PLACEHOLDER` in commit messages — the post-script replaces it.

#### Existing issue found (match)

Set the `issue` directive to comment on the existing issue:

```json
{
  "action": "comment",
  "number": <EXISTING_NUMBER>,
  "body": "## Attempt <N> Analysis\n\n<new analysis>\n\n**Classification**: `fix_category: <CATEGORY>`\n**Artifacts**: <prow URL>",
  "add_labels": ["attempt:<N>"]
}
```

---

### Phase 6: Action — Route by Category

| Category | Path |
|----------|------|
| `test_fix` | → **6a. Fix** |
| `product_bug` | → **6b. Skip + JIRA** |
| `environment` | → **EXIT: Issue Tracked** |
| `infra_flake` | → **EXIT: Logged** |

#### EXIT: infra_flake — Logged

Record this workspace with `action_taken: logged`, `branch: null`,
`issue.action: skip`. No issue, no fix, no PR.

#### EXIT: environment — Issue Tracked

The issue directive was set in Phase 5. No code changes.
Record: `action_taken: issue_tracked`, `branch: null`.

---

#### 6a. Fix (`test_fix`)

**Max attempts: 2.** If this is attempt 3+, go to **6b. Skip + JIRA**.

##### Attempt 1 — New Fix

1. **Create branch from `$TARGET_BRANCH`:**
   ```bash
   git checkout "$TARGET_BRANCH"
   git checkout -b fullsend/<workspace>-<short-slug>
   ```
   Use workspace name + short slug (e.g., `fullsend/argocd-route-wait`).

2. **Read the code.** Do not trust the analysis blindly. Read:
   - The failing spec file
   - Config files referenced by `rhdh.configure()`
   - Any test helpers or fixtures involved
   - `CLAUDE.md` and `CONTRIBUTING.md` for conventions

3. **Implement the minimal fix.** Every changed line must trace to the
   failure analysis. You may modify:
   - `workspaces/<workspace>/e2e-tests/tests/specs/` — test specs
   - `workspaces/<workspace>/e2e-tests/tests/config/` — app-config, secrets, dynamic-plugins
   - `workspaces/<workspace>/e2e-tests/playwright.config.ts` — playwright config

4. **Verify:**
   ```bash
   cd workspaces/<workspace>/e2e-tests
   npx tsc --noEmit 2>/dev/null || true
   npx eslint <changed-files> 2>/dev/null || true
   npx prettier --check <changed-files> 2>/dev/null || true
   cd -
   ```

5. **Commit:**
   ```bash
   git add <specific-files-only>
   git commit -m "fix(e2e): [fullsend] <workspace> — <description>

   Root cause: <one-line>
   Fixes: #ISSUE_PLACEHOLDER"
   ```

6. Record the branch name in this workspace's output entry.

##### Attempt 2 — Different Approach or Escalate

1. **Create a fresh branch** (do not reuse existing local branches):
   ```bash
   git checkout "$TARGET_BRANCH"
   git checkout -b fullsend/<workspace>-<short-slug>
   ```

2. **Review the open PR** to understand what was tried previously.

3. **Decision:**
   - If a different fix can work → implement, commit
   - If root cause is in plugin source → escalate to **6b**
   - If two attempts have failed → escalate to **6b**

---

#### 6b. Skip + JIRA (`product_bug` or escalated `test_fix`)

1. **Create branch** (if not already on one):
   ```bash
   git checkout "$TARGET_BRANCH"
   git checkout -b fullsend/<workspace>-<short-slug>
   ```

2. **Add skip to failing tests.** For each failing test in this workspace,
   add `test.skip` as the first line:

   ```typescript
   test.skip(isNightlyMode, "<root cause summary> (JIRA-PENDING)");
   ```

   Check if `isNightlyMode` is defined. If not, add near the top:

   ```typescript
   const isNightlyMode =
     !!process.env.E2E_NIGHTLY_MODE ||
     (process.env.JOB_NAME?.includes("periodic-") ?? false);
   ```

3. **Set the JIRA directive:**

   ```json
   {
     "project": "RHDHBUGS",
     "type": "Bug",
     "summary": "[fullsend] E2E: <workspace> — <root cause>",
     "description": "Root cause: <analysis>\n\nArtifacts: <prow URL>\nGitHub issue: #ISSUE_PLACEHOLDER",
     "backfill_file": "<path-to-spec-file-with-JIRA-PENDING>"
   }
   ```

4. **Commit:**
   ```bash
   git add <specific-files-only>
   git commit -m "test(e2e): [fullsend] skip <workspace> tests in nightly

   Root cause: <description>
   JIRA: JIRA-PENDING
   Fixes: #ISSUE_PLACEHOLDER"
   ```

5. Record the branch name in this workspace's output entry.

---

## Phase 7: Structured Output

After processing all workspaces, write the combined results to
`agent-result.json`. The file contains a `workspaces` array with one entry
per workspace that had failures.

```bash
OUTPUT_DIR="${FULLSEND_OUTPUT_DIR:-.}"
mkdir -p "$OUTPUT_DIR"
cat > "$OUTPUT_DIR/agent-result.json" << 'RESULT_EOF'
{
  "target_branch": "<TARGET_BRANCH value>",
  "workspaces": [
    {
      "workspace": "<workspace-name>",
      "tests": [
        { "name": "<test title>", "error": "<error message>" }
      ],
      "root_cause": "<summary covering all failures in this workspace>",
      "fix_category": "<infra_flake|test_fix|product_bug|environment>",
      "action_taken": "<logged|commented_on_existing|issue_tracked|fix_implemented|test_skipped>",
      "attempt": 1,
      "next_step": "<what should happen next>",
      "branch": "<fullsend/workspace-slug or null>",

      "issue": {
        "action": "<create|comment|skip>",
        "number": null,
        "title": "<for create only>",
        "labels": ["e2e-failure"],
        "body": "<issue body or comment body>",
        "add_labels": ["<labels to add on comment>"]
      },

      "jira": {
        "project": "RHDHBUGS",
        "type": "Bug",
        "summary": "<jira summary>",
        "description": "<jira description>",
        "backfill_file": "<path to file with JIRA-PENDING>"
      }
    }
  ]
}
RESULT_EOF
```

**After writing the file, validate it:**

```bash
fullsend-check-output "$OUTPUT_DIR/agent-result.json"
```

If validation fails, read the error output, fix the JSON, and re-run the
check. If it still fails after 3 attempts, write the best JSON you have
and exit. The harness validation loop will retry up to 2 more times.

**Field rules:**
- `target_branch`: the branch detected from the Prow URL (e.g., `main`,
  `release-1.10`). Must match the `$TARGET_BRANCH` variable.
- `workspace`: the workspace directory name (e.g., `argocd`, `orchestrator`)
- `tests`: array of `{name, error}` for every failing test in this workspace
- `branch`: the full branch name (e.g., `fullsend/argocd-route-wait`), or
  `null` if no code changes (infra_flake, environment, commented_on_existing)
- `issue.action`: `"create"` for new issue, `"comment"` to update existing,
  `"skip"` if no issue action needed
- `jira`: include only for Phase 6b (skip + JIRA). Omit entirely otherwise.
- `jira.backfill_file`: the spec file path where `JIRA-PENDING` was written
- Do NOT include extra keys — the schema enforces `additionalProperties: false`

After writing and validating, output a human-readable summary per workspace:

```
=== E2E Fix Agent Results ===
Workspaces processed: <N>

  [argocd]
    Category:  test_fix
    Action:    fix_implemented
    Tests:     1
    Branch:    fullsend/argocd-route-wait

  [orchestrator]
    Category:  infra_flake
    Action:    logged
    Tests:     3
    Branch:    (none)
```

---

## Constraints

### Allowed modifications

- `workspaces/*/e2e-tests/` — test specs, playwright config, test helpers
- `workspaces/*/e2e-tests/tests/config/` — app-config, secrets, dynamic-plugins

### Prohibited modifications

- Plugin source code (`workspaces/*/plugins/`)
- CI configuration (`.github/`, `.ci-operator/`)
- Repository config (`CLAUDE.md`, `CODEOWNERS`, `.fullsend/`)

### Git discipline

- Stage specific files only — never `git add -A`, `git add .`, or `git add --all`
- Always create new commits — never `git commit --amend`
- Never force push
- Never rebase
- **Return to `$TARGET_BRANCH` between workspaces** before creating the next branch

### Sub-agents

- When spawning any sub-agent (Explore, Plan, general-purpose, etc.), always pass `model: "opus"`.
- If a sub-agent fails due to a model error, retry with `model: "opus"` explicitly — do not silently fall back to a shallow alternative.

### Analysis

- Analysis is handled by `/e2e-failure-analysis` — do not duplicate its work.
- Use the skill's output to drive classification and fix decisions.
- Do not classify (`fix_category`) until all investigation steps in Phase 2
  are complete — including trace inspection for every UI failure. Premature
  classification biases the fix toward an incomplete understanding of the
  failure.
- **Trace inspection is mandatory for UI failures.** Do not classify any
  test failure involving browser interaction (Playwright assertions, element
  timeouts, navigation errors) without first invoking `/playwright-trace`
  and running `trace actions` + `trace action <id>` on the failed actions.
  Screenshots show the end state; traces show the mechanism. You need both.
- Distinguish **symptoms** from **mechanisms**. "The h1 timed out because
  the cluster was slow" is a symptom. "The h1 timed out because a background
  `waitForEvent('popup')` competed with the selector wait while the OAuth
  refresh returned 401" is a mechanism. You cannot identify mechanisms
  without traces.
- Treat existing GitHub issues as **hypotheses, not facts**. Prior issues may
  contain stale analysis, incorrect classification, or incomplete root causes.
  Always verify independently through your own analysis before adopting an
  existing issue's conclusions.
