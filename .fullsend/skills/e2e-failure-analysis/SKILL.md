---
name: e2e-failure-analysis
description: "Debug and analyze E2E test failures when the user shares a gcsweb URL or asks to investigate a PR check / e2e-ocp-helm failure."
---

# E2E Failure Analysis

Debug test failures in the rhdh-plugin-export-overlays E2E testing system.

## CRITICAL: Context Management Rules

**Always check file size (`wc -l`) before reading any log file.**

- **Small files (under ~200 lines)**: read in full — complete context beats targeted grep.
- **Large files (200+ lines)**: grep for error patterns first, note line numbers, then
  read narrow ranges around them. Never read a large file in full.
  - **grep + tail** — `grep -i "error\|fail\|crash" file.log | tail -30`
  - **tail** — `tail -50 file.log` for most-recent entries
  - **Read with offset+limit** — `Read(file, offset=N, limit=50)` for targeted sections
  - **grep -n** — find line numbers first, then read narrow ranges

Files like backstage-backend.log and build-log.txt can be 5,000–50,000+ lines.
Auxiliary pod logs are often under 200 lines and safe to read entirely.

## Investigation Workflow

### Step 0: Download Artifacts

```bash
SKILL_DIR="${SKILL_DIR:-.claude/skills/e2e-failure-analysis}"
ARTIFACTS=$(python3 "$SKILL_DIR/scripts/download-artifacts.py" "<PROW_OR_GCSWEB_URL>")
```

The script parses both PR check and nightly (periodic) prow/gcsweb URLs, downloads
artifacts via the public GCS JSON API (no gcloud dependency), caches them locally,
and prints the `ARTIFACTS` path. Subsequent runs with the same URL skip the download
(cache is validated for completeness, not just directory existence).

### Step 1: Diagnostic Summary

Run the diagnostics script from the skill's scripts directory:

```bash
SKILL_DIR="${SKILL_DIR:-.claude/skills/e2e-failure-analysis}"
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
- **Setup/beforeAll failure** (CLI commands, deployment errors) → skip to **Step 5, build-log.txt**

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

### Step 4: Trace Analysis

**MANDATORY for every UI test failure.** You MUST inspect the trace for each failed test
that involves browser interaction (Playwright assertions, timeouts, element waits) before
drawing any conclusions about root cause.

Screenshots and error-context show the *end state* — what the page looked like when the
test failed. Traces show the *timeline* — what happened between navigation and failure.
You cannot distinguish a timing flake from a real bug without the timeline. Specific
things only traces reveal:
- Background async operations (popup listeners, event waiters) running concurrently
  with test actions — these can interfere with or mask the actual failure
- The exact duration of each step in the action chain — pinpoints which step is slow
  vs which step actually fails
- Network request timing relative to UI actions — shows whether data arrived but
  rendering was slow, or data never arrived
- Console errors that fire during the test (not just at page load)

**Skip traces ONLY when ALL of these are true:**
- The failure is a setup/beforeAll error with no browser involvement (exit code from a
  shell script, deployment failure, pod crash)
- No trace.zip file exists in the test's artifact directory
- Step 1 revealed config/deployment warnings that fully explain the failure AND the
  error-context confirms the page never loaded (blank page, error page, config error)

**If in doubt, open the trace.** A 30-second `trace actions` check is cheaper than a
wrong classification.

#### Finding traces

```bash
find "$ARTIFACTS/e2e-test-results" -name "trace.zip" | sort
```

#### Invoking the playwright-trace skill

**You MUST invoke `/playwright-trace` before running any trace commands.** The skill
provides the complete command reference for `npx playwright trace` — all subcommands,
flags, filters, and workflows. Do not rely on memory for trace CLI usage.

#### Minimum trace inspection for every UI failure

After invoking the skill and opening a trace, do at minimum:

1. `trace actions` — the **full** action list, not just `--errors-only`. Background
   operations that succeed but take a long time (like a 15s popup listener) won't
   show up in errors-only but are critical for understanding the failure timeline.
2. `trace action <id>` — for each failed action and any action with a suspiciously
   long duration
3. `trace console --errors-only` — browser errors during the test
4. `trace requests --failed` — failed network requests

Then go deeper based on what you find (snapshots, request details, filtered requests).
The playwright-trace skill documents all available commands.

#### What to look for in traces

1. **The full action timeline** — not just errors. Look for:
   - Actions with unexpectedly long durations (> 5s for simple operations)
   - Background operations running in parallel with the main test flow
   - Gaps in the timeline where nothing happens (rendering delays, polling)

2. **Concurrent async operations** — `waitForEvent`, popup listeners, parallel
   promises. These appear as overlapping actions in the timeline. If a background
   operation times out during your main test action, it can disrupt the test even
   if the main action would otherwise succeed.

3. **Network timing vs UI timing** — compare when API responses arrive (fulfill
   requests, 200s) against when UI elements appear (expect toBeVisible resolves).
   A large gap between "data available" and "UI renders" indicates browser CPU
   saturation or widget rendering delays, not network issues.

4. **Retry accumulation** — check the trace metadata for page count and total
   requests. Multiple pages (e.g., Pages: 11) means the test was retried many
   times. Each retry loads a new page with hundreds of requests, degrading browser
   performance. The last attempt may fail purely from accumulated browser load.

5. **Element not found / timeout when the page loaded correctly** — use
   `trace snapshot <action-id>` to get the accessibility tree and discover what IS
   on the page that could inform the fix. Don't just diagnose why the element is
   missing — look for what the test COULD use instead.

### Step 5: Cluster Log Search

Check cluster logs **alongside** other steps, not only as a last resort. UI failures
often originate from backend issues (plugin load failures, missing config, crashed pods)
that only show up in cluster logs.

Logs are at `$ARTIFACTS/e2e-test-results/logs/<project>/`. Start with `pods.txt` to see
what's running, then investigate relevant pod logs.

#### What to check and what it tells you

- **`pods.txt`** — pod status, restarts, readiness. Always safe to read in full.
- **`events.txt`** — K8s events: ImagePullBackOff, CrashLoopBackOff, probe failures.
  Most recent events are at the bottom.
- **`backstage-backend.log`** — RHDH startup errors, plugin failures, config issues.
  Almost always a large file — grep first. Filter out `node_modules` and `trace_id` noise.
- **`install-dynamic-plugins.log`** — plugin installation: OCI pull failures, version
  mismatches, disabled wrappers. Usually medium-sized.
- **Pod restarts** — if `RESTARTS` is non-zero in `pods.txt`, check the `.previous.log`
  for that pod. Work that started in the killed instance but never completed explains
  what's missing in the current pod.

**When to check early (alongside Steps 1-2):**
- UI test timed out waiting for a plugin element → plugin install log
- Page shows error/blank state → backstage-backend log
- Pod never became ready → events.txt

#### Auxiliary pod logs

Namespaces often contain pods beyond RHDH (workflow engines, databases, mock services).
When RHDH pod logs don't explain the failure, scan all other pod logs in the namespace
for errors. Check `pods.txt` to see what's running, then grep their logs the same way
you would for RHDH pods.

**When to check:**
- RHDH logs are clean but the test expects data from an external service
- Test interacts with a service deployed by the workspace (workflows, APIs)
- The error message references a non-RHDH service endpoint or component

#### build-log.txt

The build log contains the full CI output — deployment sequences, config dumps, and
the complete stdout/stderr of every CLI command run during setup. It is a single file
covering all projects, so one grep pass can surface context for multiple failures.

**For setup/beforeAll failures, start here — before cluster logs.** The build log shows
*why* something failed. Cluster logs only show the resulting state.

Location: `$(dirname "$ARTIFACTS")/build-log.txt`

The build log covers all projects in one file. Filter by project name to avoid noise
from other projects. Also check env vars (`GIT_PR_NUMBER`, `E2E_NIGHTLY_MODE`) to
determine the deployment mode — it affects how plugins are resolved.

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
**Check**: error-context.md → screenshot → `trace snapshot <action-id>` → adjacent tests in spec file
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
│       └── <sha1-hash>.zip      # Trace files
├── e2e-test-results/
│   ├── logs/<project>/          # Per-namespace cluster diagnostics
│   │   ├── events.txt
│   │   ├── pods.txt
│   │   └── pods/<pod>/              # One directory per pod in the namespace
│   │       ├── backstage-backend.log
│   │       ├── install-dynamic-plugins.log
│   │       └── ...                  # Other pods: workflow engines, databases, services
│   └── specs-<slug>-<project>/  # Per-test failure artifacts
│       ├── error-context.md     # Page snapshot (START HERE)
│       ├── trace.zip            # Playwright trace
│       ├── test-failed-1.png    # Screenshot
│       └── video.webm           # Recording
```

**Trace locations:** Both `e2e-test-results/specs-*/trace.zip` and `playwright-report/data/*.zip`
contain traces. The `e2e-test-results` traces are named by test slug (easier to identify).
Use `find "$ARTIFACTS/e2e-test-results" -name "trace.zip"` to locate them.

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

1. **Ask: did the operation succeed but produce wrong results?** If logs are clean and
   all inputs were accepted, don't assume "slow." The operation may have completed
   and produced the wrong outcome. Read the test helpers and the code that processes
   the trigger to understand what it actually did with the input.
2. **Re-read only the original error message** from Step 1.
3. **Reason from the error outward**: what has to be true for this error to occur? Work
   forward from the error itself, not backward from what the steps led you to look at.
4. **Use what you've already seen to eliminate paths** — if you've checked cluster logs
   and they were clean, the cause is upstream of runtime. If error-context showed the
   page loaded fine, the issue isn't deployment. Let ruled-out evidence narrow the space.
5. **Identify what you haven't checked yet** that could still explain the error, and go
   there directly.
6. **Confirm with one cross-check** before concluding — a single additional artifact that
   either supports or contradicts the new hypothesis.
