---
name: e2e-failure-analysis
description: "Debug and analyze E2E test failures when the user shares a gcsweb URL or asks to investigate a PR check / e2e-ocp-helm failure."
allowed-tools: Bash(playwright:*),Bash(npx:*)
---

# E2E Failure Analysis

Orchestrate the analysis of E2E test failures — from artifact download
through per-workspace root cause analysis.

## Step 0: Download Artifacts

If `$ARTIFACTS` is already set and the directory exists, skip the download:

```bash
if [[ -n "${ARTIFACTS:-}" ]] && [[ -d "$ARTIFACTS" ]]; then
  echo "Artifacts already available at $ARTIFACTS — skipping download"
else
  SKILL_DIR="${SKILL_DIR:-.claude/skills/e2e-failure-analysis}"
  ARTIFACTS=$(node --experimental-strip-types "$SKILL_DIR/scripts/download-artifacts.ts" "<PROW_OR_GCSWEB_URL>")
fi
BUILD_LOG="$(dirname "$ARTIFACTS")/build-log.txt"
echo "ARTIFACTS=${ARTIFACTS}"
echo "BUILD_LOG=${BUILD_LOG}"
```

The script parses both PR check and nightly (periodic) prow/gcsweb URLs, downloads
artifacts via the public GCS JSON API (no gcloud dependency), and prints the
`ARTIFACTS` path. Each run re-downloads artifacts fresh (any previous cache for the
same URL is cleared first).

### Step 1: Diagnostic Summary

Run the diagnostics script from the skill's scripts directory:

```bash
SKILL_DIR="${SKILL_DIR:-.claude/skills/e2e-failure-analysis}"
node --experimental-strip-types "$SKILL_DIR/scripts/diagnostics.ts" "$ARTIFACTS"

# Filter to a specific project:
node --experimental-strip-types "$SKILL_DIR/scripts/diagnostics.ts" "$ARTIFACTS" --project techdocs
```

This script gives you:
- All failed tests with error messages
- Config table dumps (App Config, Dynamic Plugins, deployment config)
- Deployment warnings auto-filtered (missing YAML files, errors, CrashLoopBackOff, etc.)

**Key warnings to watch for in the output:**
- `YAML file ... does not exist` — Missing config/secrets file (wrong path or missing `secrets:` in configure())
- Config dump missing expected sections (e.g., no `integrations:`) — config file not loaded
- `CrashLoopBackOff` / `ImagePullBackOff` — pod-level failures
- Failed helm install or pod readiness timeout

**All failure types proceed to Step 3 (Group and Analyze)**, which delegates to
`workspace-analysis.md` for the full analysis methodology — including which
artifact to check first for UI failures, setup/beforeAll failures, and
deployment timeouts (see "Cluster Log Search" and "build-log.txt" there).

## Step 2: Prepare

Clone the test utilities repo once (if not already present):

```bash
if [[ ! -d /tmp/e2e-test-utils ]]; then
  git clone --depth 1 https://github.com/redhat-developer/rhdh-e2e-test-utils.git /tmp/e2e-test-utils
fi
```

## Step 3: Group and Analyze

### Single workspace

If diagnostics identified failures in only one workspace (or you were
given a specific workspace to analyze), read the analysis methodology at
`$SKILL_DIR/reference/workspace-analysis.md` and follow it inline for
that workspace.

### Multiple workspaces

When failures span multiple workspaces, group them by **error signature**
before analyzing. Two workspaces share an error signature when they fail
with:
- The same error message pattern (modulo test name, selector text, or URL)
- The same failing helper function (e.g., `uiHelper.clickTab`,
  `clickBtnInCard`)
- The same stack trace shape (same origin in test-utils or test code)

Common groupings: all `clickTab` failures across `*-app-next` projects;
all `clickBtnInCard` detachment errors; all deployment timeouts with the
same pod status.

For each error-signature group:
- Select one **representative workspace** for full analysis
- Prefer the workspace with the most context (most tests, richest logs)

This grouping is a hypothesis based on error text alone, formed before
any artifact is opened — it can be wrong. The subagent verifies each
sibling against the representative's findings and may pull a workspace
back out of the group and analyze it separately (see "Analyzing Grouped
Workspaces" in `reference/workspace-analysis.md`). Treat a subagent's
returned findings as the source of truth for group membership, not the
grouping you formed here.

**Fan out one subagent per error-signature group** (not per workspace).
Workspaces with unique errors get their own subagent. Send all Agent
calls in a single response so they run concurrently. Always pass
`model: "opus"`.

Each subagent prompt should include:
- `ARTIFACTS` and `BUILD_LOG` paths
- `SKILL_DIR` path (so the subagent can read reference files)
- The workspace name (representative) and ALL sibling workspaces
  in the group, with their failed tests and error messages
- Instruction to read `$SKILL_DIR/reference/workspace-analysis.md`
  for the analysis methodology
- Instruction to skip Step 0 (artifacts already downloaded) and use
  `--project <workspace>` when running diagnostics
- Instruction to return per-test **evidence** (not classification):
  test name, root cause mechanism, key evidence, and these
  classification inputs:
  - What is unique about this test's code path compared to other tests?
  - Did the same infrastructure component work for other tests in this
    workspace?
  - Could a test code change prevent this failure?
- If covering a group: note any differences between sibling workspaces
  (different selectors, config, test structure) that might require
  per-workspace remediation
- The path to pre-cloned e2e-test-utils: `/tmp/e2e-test-utils` — do
  not re-clone
- **Do not suggest a `fix_category`** — classification requires
  cross-workspace context that subagents lack

If a subagent fails or returns unusable output, analyze that workspace
inline as a fallback (read the reference file and follow it yourself).

### Completion gate

**Do not return results until ALL of the following are done for every
workspace:**
- Diagnostics identified all failed tests
- The analysis methodology in `workspace-analysis.md` was followed
  through all applicable steps (error-context, screenshots, trace,
  cluster logs)
- Evidence includes the classification inputs listed above
