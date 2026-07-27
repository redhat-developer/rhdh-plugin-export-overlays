---
name: playwright-trace
description: Inspect Playwright trace files from the command line — list actions, view requests, console, errors, snapshots and screenshots.
allowed-tools: Bash(playwright:*),Bash(npx:*)
---

# Playwright Trace CLI

Inspect `.zip` trace files produced by Playwright tests without opening a browser.

`playwright` is installed globally at `/usr/bin/playwright` in the sandbox — use it directly (fallback on `npx` when needed). The harness sets `PLAYWRIGHT_BROWSERS_PATH=/tmp/playwright-browsers` which points to pre-installed Chromium for `trace snapshot`.

Use `playwright trace <cmd>` for everything below. Fall back to `playwright trace <cmd>` only if the global binary is unavailable.

## Workflow

1. Start with `trace open <trace.zip>` to extract the trace and see its metadata.
2. Use `trace actions` to see all actions with their action IDs.
3. Use `trace action <action-id>` to drill into a specific action — see parameters, logs, source location, and available snapshots.
4. Use `trace requests`, `trace console`, or `trace errors` for cross-cutting views.
5. Use `trace snapshot <action-id>` to get the DOM snapshot, or run a browser command against it.
6. Use `trace close` to remove the extracted trace data when done.

All commands after `open` operate on the currently opened trace — no need to pass the trace file again. Opening a new trace replaces the previous one.

## Commands

### Open a trace

```bash
# Extract trace and show metadata: browser, viewport, duration, action/error counts
playwright trace open <trace.zip>
```

### Close a trace

```bash
# Remove extracted trace data
playwright trace close
```

### Actions

```bash
# List all actions as a tree with action IDs and timing
playwright trace actions

# Filter by action title (regex, case-insensitive)
playwright trace actions --grep "click"

# Only failed actions
playwright trace actions --errors-only
```

### Action details

```bash
# Show full details for one action: params, result, logs, source, snapshots
playwright trace action <action-id>
```

The `action` command displays available snapshot phases (before, input, after) and the exact command to extract them.

### Requests

```bash
# All network requests: method, status, URL, duration, size
playwright trace requests

# Filter by URL pattern
playwright trace requests --grep "api"

# Filter by HTTP method
playwright trace requests --method POST

# Only failed requests (status >= 400)
playwright trace requests --failed
```

### Request details

```bash
# Show full details for one request: headers, body, security
playwright trace request <request-id>
```

### Console

```bash
# All console messages and stdout/stderr
playwright trace console

# Only errors
playwright trace console --errors-only

# Only browser console (no stdout/stderr)
playwright trace console --browser

# Only stdout/stderr (no browser console)
playwright trace console --stdio
```

### Errors

```bash
# All errors with stack traces and associated actions
playwright trace errors
```

### Snapshots

The `snapshot` command loads the DOM snapshot for an action into a headless browser and runs a single browser command against it. Without a browser command, it returns the accessibility snapshot.

```bash
# Get the accessibility snapshot (default)
playwright trace snapshot <action-id>

# Use a specific phase
playwright trace snapshot <action-id> --name before

# Run eval to query the DOM
playwright trace snapshot <action-id> -- eval "document.title"
playwright trace snapshot <action-id> -- eval "document.querySelector('#error').textContent"

# Eval on a specific element ref (from the snapshot)
playwright trace snapshot <action-id> -- eval "el => el.getAttribute('data-testid')" e5

# Take a screenshot of the snapshot
playwright trace snapshot <action-id> -- screenshot

# Redirect output to a file
playwright trace snapshot <action-id> -- eval "document.body.outerHTML" --filename=page.html
playwright trace snapshot <action-id> -- screenshot --filename=screenshot.png
```

Only three browser commands are useful on a frozen snapshot: `snapshot`, `eval`, and `screenshot`.

### Attachments

```bash
# List all trace attachments
playwright trace attachments

# Extract an attachment by its number
playwright trace attachment 1
playwright trace attachment 1 -o out.png
```

## Typical investigation

```bash
# 1. Open the trace and see what's inside
playwright trace open test-results/my-test/trace.zip

# 2. What actions ran?
playwright trace actions

# 3. Which action failed?
playwright trace actions --errors-only

# 4. What went wrong?
playwright trace action 12

# 5. What did the page look like at that moment?
playwright trace snapshot 12

# 6. Query the DOM for more detail
playwright trace snapshot 12 -- eval "document.querySelector('.error-message').textContent"

# 7. Any relevant network failures?
playwright trace requests --failed

# 8. Any console errors?
playwright trace console --errors-only
```
