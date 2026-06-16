---
name: e2e-failure-analysis
description: "Debug and analyze E2E test failures when the user shares a gcsweb URL or asks to investigate a PR check / e2e-ocp-helm failure."
---

# E2E Failure Analysis

Debug test failures in the rhdh-plugin-export-overlays E2E testing system.

## CRITICAL: Context Management Rules

**NEVER read entire log files.** Log files (backstage-backend.log, install-dynamic-plugins.log,
build-log.txt) can be 5,000–50,000+ lines. Reading them wastes context and finds nothing useful.

Instead:
- **grep + tail** — `grep -i "error\|fail\|crash" file.log | tail -30`
- **tail** — `tail -50 file.log` for most-recent entries
- **Read with offset+limit** — `Read(file, offset=N, limit=50)` for targeted sections
- **grep -n** — find line numbers first, then read narrow ranges

**NEVER `cat` or `Read` without limit on**: backstage-backend.log, install-dynamic-plugins.log,
build-log.txt, events.txt, describe-pods.txt, or any file that could be large.

## Investigation Workflow

### Step 0: Download Artifacts

```bash
SKILL_DIR="$HOME/.claude/skills/e2e-failure-analysis"
ARTIFACTS=$(python3 "$SKILL_DIR/scripts/download-artifacts.py" "<PROW_OR_GCSWEB_URL>")
```

The script parses both PR check and nightly (periodic) prow/gcsweb URLs, downloads
artifacts via `gcloud storage cp`, caches them locally, and prints the `ARTIFACTS` path.
Subsequent runs with the same URL skip the download.

### Step 1: Diagnostic Summary

Run the diagnostics script from the skill's scripts directory:

```bash
SKILL_DIR="$HOME/.claude/skills/e2e-failure-analysis"
python3 "$SKILL_DIR/scripts/diagnostics.py" "$ARTIFACTS"

# Filter to a specific project:
python3 "$SKILL_DIR/scripts/diagnostics.py" "$ARTIFACTS" --project techdocs
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

**Classify each failure before proceeding:**
- **UI failure** (Playwright assertions) → proceed to Step 2
- **Setup/beforeAll failure** (CLI commands, deployment errors) → skip to **Step 5b**

Setup failures have no useful page snapshots, screenshots, or traces. **Go to
build-log.txt first** — it captures the full stdout/stderr of every deployment script
and CLI command, so it shows *why* the setup failed. Cluster logs only show the
resulting state (what was or wasn't running). The cause is almost always in the build
log, not the cluster logs.

### Step 2: Read error-context.md for Failed Tests

**This is the PRIMARY artifact for understanding UI failures.** Each failed test has an
auto-generated `error-context.md` containing:
- Test source code with the failing line marked
- Full error message and call log
- YAML page snapshot showing exactly what was on screen at failure time

```bash
# Find all error-context files for failed tests
find "$ARTIFACTS/e2e-test-results" -name "error-context.md" | sort
```

**IMPORTANT: Read ONE error-context first, then deduplicate.** Page snapshots can be very large
(500-1000+ lines for content-heavy pages like TechDocs). Before reading a second error-context:
- Check if it's from the same project and spec file as one you already read
- Check if the error message is the same (visible from Step 1 output)
- If both match, **skip it** — the root cause is the same

Read the first error-context.md. The page snapshot tells you immediately:
- Is the page loaded? Or is it a blank/error page?
- Is the expected element missing, or is it present with different text?
- Did login succeed? (Check for user button vs login form)
- Are sidebar items visible? (Plugin loaded vs not)

#### ALWAYS view screenshots for UI failures

Each failed test also saves a screenshot (`test-failed-1.png`) captured at the moment of
failure. **Always read screenshots for every UI test failure** — don't skip them. They are
small files (5-130KB) and give instant visual context that page snapshots can miss.

```bash
# Find screenshots for failed tests
find "$ARTIFACTS/e2e-test-results" -name "test-failed-*.png" | sort
```

Read each screenshot file with the Read tool to see exactly what the browser showed.
Screenshots reveal things the YAML page snapshot may not:
- Visual layout, styling, or overlay positioning
- Popups, modals, or dropdowns that the YAML snapshot doesn't capture well
- UI controls (search fields, filters, pagination) that inform fix suggestions
- Loading states, spinners, or partially rendered content
- The overall page context at a glance vs parsing hundreds of YAML lines

**Do this alongside reading error-context.md, not as a fallback.**

### Step 3: Compare Expected vs Deployed Config

**When Step 1 shows config warnings** (missing YAML files, missing config sections), compare
what the workspace's config files define against what was actually deployed:

```bash
# Read the workspace's config files to see what SHOULD be deployed
cat workspaces/<WORKSPACE>/e2e-tests/tests/config/<SUBDIR>/app-config-rhdh.yaml 2>/dev/null
cat workspaces/<WORKSPACE>/e2e-tests/tests/config/<SUBDIR>/rhdh-secrets.yaml 2>/dev/null

# Compare against the App Config dump from Step 1 output
# Look for sections present in the file but missing from the dump
```

Common mismatches:
- **Missing `integrations:` section** — secrets file not loaded, so token env vars unavailable
- **Missing `catalog.providers:` section** — app-config file path wrong in configure()
- **Secret path mismatch** — configure() uses default `tests/config/rhdh-secrets.yaml` but
  the file is in a subdirectory like `tests/config/techdocs/rhdh-secrets.yaml`

**Check the configure() call in the spec file:**
```bash
grep -A10 'rhdh.configure' workspaces/<WORKSPACE>/e2e-tests/tests/specs/<SPEC>.spec.ts
```

Verify that `appConfig`, `dynamicPlugins`, AND `secrets` all point to the correct paths.
A common bug is specifying `appConfig` and `dynamicPlugins` with a subdirectory but forgetting
the `secrets` parameter, causing it to fall back to the default path.

### Step 4: Trace Analysis with pwtrace

**Use pwtrace for UI interaction failures** — when the page loaded but an action failed
(click, navigation, element interaction). **Skip traces ONLY when:**
- Step 1 already revealed config/deployment warnings (missing YAML, missing config sections)
- The failure is clearly a config issue (missing integration, wrong secret path)

In those cases, the root cause is in the deployment config, not the browser interaction.
Traces add no value — go straight to Step 3 (config comparison) or Step 5 (cluster logs).

**When traces ARE valuable:**
- Login failures, click/navigation issues, popup handling problems
- Element interaction timeouts where the page state is ambiguous, flaky timing issues
- **Element not found / timeout when the page loaded correctly** — use `pwtrace dom
  --interactive` to discover what IS on the page (search fields, filters, pagination
  controls, alternative elements) that could inform the fix. Don't just diagnose why the
  element is missing — look for what the test COULD use instead.

#### Finding and preparing traces

Traces live in `e2e-test-results/specs-<slug>/trace.zip`, mapped to test names via
`results.json`. **Important:** newer Playwright versions use `0-trace.trace` inside the zip
instead of `trace.trace`, which pwtrace cannot read directly. Use the find-traces script
to locate traces and create pwtrace-compatible copies:

```bash
SKILL_DIR="$HOME/.claude/skills/e2e-failure-analysis"

# List traces and check format:
python3 "$SKILL_DIR/scripts/find-traces.py" "$ARTIFACTS"

# Filter to a project:
python3 "$SKILL_DIR/scripts/find-traces.py" "$ARTIFACTS" --project techdocs

# Fix traces for pwtrace (creates fixed copies in $ARTIFACTS/fixed-traces/):
python3 "$SKILL_DIR/scripts/find-traces.py" "$ARTIFACTS" --project techdocs --fix
```

The `--fix` flag creates copies with `trace.trace` added alongside `0-trace.trace`,
outputs the fixed paths, and prints ready-to-use `npx pwtrace show <path>` commands.

**ALWAYS run find-traces.py with --fix before attempting pwtrace commands.** If pwtrace
reports "trace.trace is empty" or "Invalid trace file", the trace needs fixing first.

#### Progressive investigation:

```bash
# 1. Overview — which steps passed/failed and what actions were taken
npx pwtrace show <path/to/trace.zip>

# 2. Drill into the failed step — see details, timing, errors
npx pwtrace step <path/to/trace.zip> <STEP_NUMBER>

# 3. Inspect DOM at the failed step — what elements exist?
npx pwtrace dom <path/to/trace.zip> --step <N> --interactive

# 4. Search for a specific element in the DOM
npx pwtrace dom <path/to/trace.zip> --step <N> --selector "text=Expected Text"

# 5. Check for JavaScript errors
npx pwtrace console <path/to/trace.zip> --level error

# 6. Check for failed network requests (API errors)
npx pwtrace network <path/to/trace.zip> --failed

# 7. Get a screenshot at a specific step
npx pwtrace screenshot <path/to/trace.zip> --step <N> --list
npx pwtrace screenshot <path/to/trace.zip> --step <N> --index <I>
```

#### pwtrace decision tree:

```
Test failed → pwtrace show → identify failed step(s)
     ↓
Step N failed → pwtrace step N → understand what happened
     ↓
Element not found? → pwtrace dom --step N --interactive → see what exists
     |                  └→ --selector "button" to find similar elements
     ↓
JS errors? → pwtrace console --level error → find exceptions
     ↓
API failing? → pwtrace network --failed → find 4xx/5xx/timeout
     ↓
👁️ Visual check → pwtrace screenshot --step N --list → choose screenshot
                  └→ pwtrace screenshot --step N --index <I> → extract & view with Read tool
```

### Step 5: Cluster Log Search

Check cluster logs **alongside** other steps, not only as a last resort. UI failures often
originate from backend issues (plugin load failures, missing config, crashed pods) that only
show up in cluster logs. **Use grep and tail — never read full log files.**

```bash
# Find the right namespace's logs
ls "$ARTIFACTS/e2e-test-results/logs/"
# Each directory = a project/namespace name

# Pod status — this file is small, safe to read
cat "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/pods.txt"
```

#### Pod restarts

If `RESTARTS` is non-zero, a previous container instance ran and was killed mid-flight.
Check why it was killed and what it left behind before reading the current pod's logs:

```bash
# Why was the previous pod killed?
grep -i "kill\|probe\|evict\|OOM" "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/events.txt"

# What was the previous pod doing when it died?
PREV_LOG=$(find "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/pods" -name "backstage-backend.previous.log" | head -1)
if [ -f "$PREV_LOG" ]; then
  grep -E "finished|started|Pulling|Stopping|error|warn" "$PREV_LOG" | tail -40
fi
```

Work that started in the previous pod but never completed can directly explain what
is missing in the current pod — with no error visible in the current pod's own logs.

```bash
# Backend errors — grep, then read last 100 lines for context
BACKEND_LOG=$(find "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/pods" -name "backstage-backend.log" | head -1)
grep -i "error\|fail\|crash" "$BACKEND_LOG" | grep -v "node_modules\|trace_id" | tail -30
# If grep reveals issues, read the tail for surrounding context:
# Read(file=$BACKEND_LOG, offset=<total_lines - 100>, limit=100)

# Plugin install issues — common cause of "element not found" UI failures
INSTALL_LOG=$(find "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/pods" -name "install-dynamic-plugins.log" | head -1)
grep -i "error\|fail\|skip" "$INSTALL_LOG" | tail -20

# K8s events — last 50 lines (most recent events at bottom)
tail -50 "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/events.txt"
```

**When to check logs early (alongside Steps 1-2):**
- UI test timed out waiting for a plugin element → check `install-dynamic-plugins.log` for load failures
- Page shows error/blank state → check `backstage-backend.log` for startup crashes
- Pod never became ready → check `events.txt` for ImagePullBackOff, CrashLoopBackOff

**Reading log context around errors:** When grep finds something interesting, use
`Read` with `offset` and `limit` to read ~100 lines around the error for context.
Never read the full file — backend logs can be 5,000-50,000+ lines.

#### build-log.txt searches

The build log contains the full CI output — deployment sequences, config dumps, warnings,
and the complete stdout/stderr of every CLI command run during setup. It is a **single
file covering all projects for the entire run**, so one grep pass can surface context
for multiple failures at once.

**For setup/beforeAll failures, start here — before cluster logs.** The build log shows
*why* something failed (the actual error output from the failing command). Cluster logs
only show what state things ended up in after the failure.

```bash
BUILD_LOG="$(dirname "$ARTIFACTS")/../build-log.txt"

# For setup failures: grep for the project name + errors in one pass
# This often reveals the exact CLI command that failed and its output
grep -n -i "error\|fail\|warn\|NotFound" "$BUILD_LOG" | grep -i "${PROJECT}" | head -20

# If multiple projects have setup failures, scan all at once
grep -n -i "error\|fail\|warn\|NotFound" "$BUILD_LOG" | grep -i "proj1\|proj2\|proj3" | head -30

# Find the deployment sequence / config table for a project
grep -n "${PROJECT}" "$BUILD_LOG" | head -20
# Then Read with offset+limit around those line numbers to see surrounding context

# Find env vars / mode
grep -E "GIT_PR_NUMBER|E2E_NIGHTLY|VAULT_" "$BUILD_LOG" | head -10

# Find config dump — look for "App Config" section near project mention
grep -n "App Config\|${PROJECT}" "$BUILD_LOG" | head -20
```

After the build log explains the cause, confirm the resulting cluster state:
```bash
cat "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/pods.txt"
cat "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/deployments.txt"
tail -50 "$ARTIFACTS/e2e-test-results/logs/${PROJECT}/events.txt"
```

## Architecture Reference

### e2e-test-utils

All E2E tests use `@red-hat-developer-hub/e2e-test-utils` — a shared package that provides
fixtures (`rhdh`, `uiHelper`, `loginHelper`), RHDH deployment logic, K8s helpers, and
Playwright configuration. When debugging unexpected deployment behavior, config merging,
or fixture internals, consult the source and docs:
- **Repo**: https://github.com/redhat-developer/rhdh-e2e-test-utils
- **Docs**: https://github.com/redhat-developer/rhdh-e2e-test-utils/tree/main/docs

To check which version a failing run used:
```bash
grep -i "e2e-test-utils" "$BUILD_LOG" | head -5
```

### Project = Namespace = RHDH Deployment

Each Playwright project creates a separate K8s namespace. Project name = namespace name.
The project name tells you which log directory to check.

### Deployment Modes

| Mode | Detection | Plugins | Config Injection |
|------|-----------|---------|-----------------|
| PR check | `GIT_PR_NUMBER` set | OCI `pr_{N}__{version}` | Yes — metadata appConfigExamples |
| Nightly | `E2E_NIGHTLY_MODE=true` | Released OCI refs | No |
| Local | Neither | Local paths | Yes |

### Deployment Flow (rhdh.deploy())

```
1. Config Merge: Package defaults → Auth config → Workspace overrides (deep merge)
2. Secrets: envsubst on rhdh-secrets.yaml only ($VAR → value)
3. Dynamic Plugins: auto-generate from metadata or use explicit file; resolve OCI URLs
4. Helm Install: helm upgrade -i
5. Readiness: Pod Ready + HTTP health check → sets RHDH_BASE_URL
```

### Secret Flow

```
CI env ($VAULT_TOKEN=abc) → rhdh-secrets.yaml (TOKEN: $VAULT_TOKEN) → app-config (token: ${TOKEN})
                                ↓ envsubst                                ↓ K8s Secret reference
                            TOKEN: abc                                token: abc (runtime)
```

## Common Failure Patterns

### Plugin Not Loading
**Grep for**: `grep -i "error\|fail" install-dynamic-plugins.log | tail -20`
**Causes**: OCI not published (`/publish` not run), version mismatch, wrapper not disabled

### Deployment Failure (CrashLoopBackOff)
**Grep for**: `tail -50 events.txt` + `grep -i "error\|crash" backstage-backend.log | tail -20`
**Causes**: Bad plugin config, missing env var, image pull failure

### Login Failure
**Check**: error-context.md page snapshot — is it login page or error?
**Causes**: Keycloak not deployed, wrong secret, RHDH not ready

### Timeout Waiting for Element
**Check**: error-context.md → screenshot → pwtrace dom --interactive → adjacent tests in spec file
**Causes**: Data not loaded, backend failing, wrong selector, element not on visible page
**Before suggesting a fix**: `grep -A5 '<element text>' <spec-file>` — check if sibling
tests already handle this element.

### Config/Secret Mismatch
**Detected in Step 1**: `YAML file ... does not exist` warning or missing config sections in dump
**Causes**: Inconsistent paths in `rhdh.configure()` — one param points to a subdirectory
while another falls back to the default path, or secrets file not loaded at all
**Fix pattern**: Verify `appConfig`, `dynamicPlugins`, and `secrets` all use consistent paths

### Worker Restart Lost State
**Symptom**: Retry fails differently than first attempt
**Check**: Was env var set inside runOnce? It's lost on worker restart.

## Artifact Directory Structure

```
artifacts/
├── playwright-report/
│   ├── results.json             # Test results with stdout/stderr + trace attachment mappings
│   └── data/                    # Hash-named trace/screenshot data (same content as e2e-test-results)
│       └── <sha1-hash>.zip      # Trace files (may use 0-trace.trace format)
├── e2e-test-results/
│   ├── logs/<project>/          # Per-namespace cluster diagnostics
│   │   ├── events.txt
│   │   ├── pods.txt
│   │   └── pods/<pod>/
│   │       ├── backstage-backend.log
│   │       └── install-dynamic-plugins.log
│   └── specs-<slug>-<project>/  # Per-test failure artifacts
│       ├── error-context.md     # Page snapshot (START HERE)
│       ├── trace.zip            # Playwright trace (may need --fix for pwtrace)
│       ├── test-failed-1.png    # Screenshot
│       └── video.webm           # Recording
└── fixed-traces/                # Created by find-traces.py --fix
    └── specs-<slug>.zip         # pwtrace-compatible copies
```

**Trace locations:** Both `e2e-test-results/specs-*/trace.zip` and `playwright-report/data/*.zip`
contain traces. The `e2e-test-results` traces are named by test slug (easier to identify).
The `playwright-report/data` traces are hash-named (mapped via results.json attachments).
Use `find-traces.py` to find and fix them — don't manually search for traces.

**Trace format:** Newer Playwright uses `0-trace.trace` (not `trace.trace`) inside the zip.
pwtrace expects `trace.trace`. Run `find-traces.py --fix` to create compatible copies.

## Discovery Commands

```bash
# Workspaces with e2e tests
ls -d workspaces/*/e2e-tests 2>/dev/null | cut -d'/' -f2

# What config a project uses
grep -A10 'rhdh.configure' workspaces/<name>/e2e-tests/tests/specs/*.spec.ts

# What secrets a workspace needs
cat workspaces/<name>/e2e-tests/.env.sample 2>/dev/null
```

## When the structured steps don't resolve the RCA

If after following the steps above you still don't have a clear root cause — or your
conclusion feels uncertain — set aside the hypothesis you've formed and reason freely.

Keep the context of what you've already looked at: it tells you what's been ruled out
and where the answer isn't. What you discard is the conclusion drawn from those steps,
not the investigation history.

1. **Re-read only the original error message** from Step 1.
2. **Reason from the error outward**: what has to be true for this error to occur? Work
   forward from the error itself, not backward from what the steps led you to look at.
3. **Use what you've already seen to eliminate paths** — if you've checked cluster logs
   and they were clean, the cause is upstream of runtime. If error-context showed the
   page loaded fine, the issue isn't deployment. Let ruled-out evidence narrow the space.
4. **Identify what you haven't checked yet** that could still explain the error, and go
   there directly.
5. **Confirm with one cross-check** before concluding — a single additional artifact that
   either supports or contradicts the new hypothesis.
