# Playwright Test Authoring

How to write Playwright tests whose failures are diagnosable, and how to review assertions so a green test actually proves the behaviour it claims. The framework and runtime are in [e2e-testing.md](./e2e-testing.md); triaging a failing nightly is [e2e-fix-workflow.md](./e2e-fix-workflow.md).

## Assert, then act

Verify an element is visible before interacting with it. This turns a generic 30-second Playwright timeout and an unhelpful "locator not found" into an immediate, descriptive assertion failure — the difference that makes automated failure analysis useful.

```typescript
// ❌ A generic timeout if the element does not exist
await uiHelper.clickLink("ACR images");

// ✅ Fails immediately with "Expected link 'ACR images' to be visible"
const link = page.getByRole("link", { name: "ACR images" });
await expect(link).toBeVisible();
await link.click();
```

This matters most for elements that depend on plugin loading, dynamic content, or layout variants — NFS versus legacy navigation — since those are the first to disappear when something breaks.

**Match the role explicitly.** When the ARIA role is known, use `page.getByRole()` rather than text-only helpers like `clickLink()` or `clickTab()`. That catches role changes early, such as an element that was a tab in the legacy layout becoming a link under NFS.

```typescript
const button = page.getByRole("button", { name: "Save" });
await expect(button).toBeVisible();
await button.click();

const tab = page.getByRole("tab", { name: "Overview" });
await expect(tab).toBeVisible();
await tab.click();
```

The `uiHelper` convenience methods remain fine for elements always present in the layout — sidebar navigation, standard catalog tabs. Reserve assert-then-act for elements whose presence depends on plugin state, dynamic content, or conditional rendering.

## Retry with `toPass()`, not a hand-rolled loop

For retry-with-backoff, use Playwright's `expect(async () => { ... }).toPass()` rather than a `for` loop with `try`/`catch`. That is the established convention here.

```typescript
import { expect } from "@playwright/test";

await expect(async () => {
  await someFlakeyOperation();
}).toPass({
  intervals: [2_000, 4_000],
  timeout: 10_000,
});
```

See `workspaces/topology/`, `workspaces/bulk-import/`, and `workspaces/global-header/` for examples.

## Navigate to stable routes

In `beforeEach` or setup, prefer a content-loaded route like `/catalog` over `/`. The root route involves redirects, dynamic loading states, and plugin initialisation delays that produce flaky timeouts. Navigate to `/` only when the test is specifically about root-route behaviour. This applies to any `page.goto()` used as setup rather than as the action under test.

## Budget timeouts for expensive `beforeAll` work

When a `beforeAll` includes operations taking over 60 seconds — operator installation, external service deployment, complex cluster setup — set a timeout explicitly:

1. Call `test.setTimeout(timeout_ms)` at the top of `beforeAll`.
2. Pass the same value to `rhdh.deploy({ timeout: timeout_ms })`.

Use **900,000 ms (15 minutes)** as the standard for blocks containing operator installs. `workspaces/argocd/e2e-tests/tests/specs/argocd.spec.ts` is the reference pattern.

The Playwright default of 30 seconds is far short of an operator install, which typically runs 5–10 minutes across CRD registration, webhook readiness, and endpoint availability.

## Reviewing test assertions

Three anti-patterns are common and easy to miss.

### Does the assertion prove the behaviour?

Check that each assertion would **fail** if the feature were broken. This matters most in distributed flows — Kafka, webhooks, async event processing — where several intermediate states sit between "request sent" and "end-to-end success".

**Watch `.or()` unions that accept failure or pre-condition states as success.** A union passes if *any* branch matches. If one branch matches a state that exists before the feature runs — an "event triggered" alert that appears before any consumer processes it — or matches an error condition such as `accessDenied` in a test where access is configured to be allowed, the test passes while the feature is completely broken.

- Does the assertion prove end-to-end behaviour — event published, consumed, workflow started, status visible — or only an intermediate step such as an accepted HTTP POST?
- If it uses `.or()`, could a weaker branch satisfy it while the primary path is broken? Each branch should be a valid success state, not a fallback that masks failure.
- Does any branch match a condition RBAC or configuration is meant to prevent? An `accessDenied` match where the user has access cannot distinguish working from broken.

### Timeout budgeting

When a test sets both a test-level timeout and an assertion-level timeout, the assertion must leave room for the setup that precedes it.

Login, navigation, and UI interaction consume time before the assertion starts retrying. If both timeouts are equal, Playwright kills the test before the assertion can exhaust its budget, and the error is "Test timeout exceeded" — no locator, no page state, nothing diagnostic.

Keep the assertion timeout at or below **50%** of the test timeout:

```typescript
// Good: the assertion has room to fail diagnostically
test.setTimeout(600_000);
await expect(locator).toBeVisible({ timeout: 300_000 });

// Bad: the assertion can never exhaust its retries
test.setTimeout(600_000);
await expect(locator).toBeVisible({ timeout: 600_000 });
```

With a shorter assertion timeout, the failure names the locator that was not found.

### Trace configurable values across files

When a PR introduces a configurable value that crosses files — an environment variable, a function parameter, a Helm value — trace it from definition through every consumer, including shell scripts, TypeScript, YAML manifests, and app-config templates.

A value can be configurable in one place and hardcoded in another. The bug then appears only with non-default values and is invisible in the default test path: a shell script may accept `KAFKA_CLUSTER_NAME` and patch RHDH's app-config accordingly, while a workflow manifest consumed by the same plugin hardcodes `my-cluster-kafka-bootstrap:9092`. With the default name everything works; with any other name one component publishes to one address and another consumes from a different one.

- Identify every file referencing the value.
- Check whether each consumer reads it or hardcodes a default.
- Flag any divergence, even when the hardcoded value currently matches the test configuration.
- Look especially at upstream manifests applied through overlays or `kubectl apply` — they are easy to miss because they are not TypeScript and may not appear in the PR's main file list.