import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { Page } from "@playwright/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { createDataIndexGuard } from "../support/utils/orchestrator-workflow-helpers.js";
import { restoreBaselineRole } from "../support/utils/test-helpers.js";

const ensureDataIndexOrSkip = createDataIndexGuard();

function jsonOk(value: string) {
  const headers: Record<string, string> = {};
  headers["content-type"] = "application/json";
  return {
    status: 200,
    headers,
    body: JSON.stringify({ value }),
  };
}

export function registerRetryWorkflowTests(): void {
  test.describe("Sample Retry Test ActiveTextInput fetch retries", () => {
    test.beforeAll(async ({ browser }, testInfo) => {
      await restoreBaselineRole(browser, testInfo);
    });

    test.beforeEach(async ({ loginHelper }, testInfo) => {
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test.afterEach(async ({ page }) => {
      await page.unroute("**/api/retry-test/**");
    });

    test("retryAllProps: 503 responses retry with delay 1500 and backoff 2 (three waits)", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(180_000);

      let allPropsHits = 0;
      let firstAllPropsAt = 0;
      let lastAllPropsSuccessAt = 0;

      await page.route("**/api/retry-test/**", async (route) => {
        const url = route.request().url();
        if (url.includes("all-props")) {
          const now = Date.now();
          if (allPropsHits === 0) {
            firstAllPropsAt = now;
          }
          allPropsHits += 1;
          if (allPropsHits <= 3) {
            await route.fulfill({ status: 404, body: "unavailable" });
          } else {
            await route.fulfill({ status: 200, body: "ok" });
            lastAllPropsSuccessAt = Date.now();
          }
          return;
        }
        if (
          url.includes("status-codes-no-404") ||
          url.includes("no-retry-props")
        ) {
          await route.fulfill(jsonOk("idle"));
          return;
        }
        await route.continue();
      });

      await openSampleRetryTestRunForm(page, uiHelper);
      await expect(
        page.getByTestId("root_retryAllProps-error-text"),
      ).toBeVisible({ timeout: 150_000 });

      expect(allPropsHits).toBe(4);
      const span = lastAllPropsSuccessAt - firstAllPropsAt;
      expect(span).toBeGreaterThanOrEqual(9_000);
    });

    test("retryStatusCodesNoMatch: 404 is not retried when omitted from fetch:retry:statusCodes", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(120_000);

      let statusEndpointHits = 0;

      await page.route("**/api/retry-test/**", async (route) => {
        const url = route.request().url();
        if (url.includes("status-codes-no-404")) {
          statusEndpointHits += 1;
          await route.fulfill({ status: 404, body: "not found" });
          return;
        }
        if (url.includes("all-props") || url.includes("no-retry-props")) {
          await route.fulfill(jsonOk("idle"));
          return;
        }
        await route.continue();
      });

      const started = Date.now();
      await openSampleRetryTestRunForm(page, uiHelper);
      await expect(
        page.getByTestId("root_retryStatusCodesNoMatch-error-text"),
      ).toBeVisible({
        timeout: 60_000,
      });
      const elapsed = Date.now() - started;
      expect(statusEndpointHits).toBe(1);
      expect(elapsed).toBeLessThan(8_000);
    });

    test("retryNoProps: single fetch when fetch:retry:maxAttempts is absent", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(120_000);

      let noRetryHits = 0;

      await page.route("**/api/retry-test/**", async (route) => {
        const url = route.request().url();
        if (url.includes("no-retry-props")) {
          noRetryHits += 1;
          await route.fulfill({ status: 503, body: "no retry" });
          return;
        }
        if (url.includes("all-props") || url.includes("status-codes-no-404")) {
          await route.fulfill(jsonOk("idle"));
          return;
        }
        await route.continue();
      });

      const started = Date.now();
      await openSampleRetryTestRunForm(page, uiHelper);
      await expect(
        page.getByTestId("root_retryNoProps-error-text"),
      ).toBeVisible({
        timeout: 60_000,
      });
      await new Promise((r) => setTimeout(r, 2_000));
      const elapsed = Date.now() - started;
      expect(noRetryHits).toBe(1);
      expect(elapsed).toBeLessThan(15_000);
    });
  });
}

async function openSampleRetryTestRunForm(page: Page, uiHelper: UIhelper) {
  await uiHelper.openSidebar("Orchestrator");
  const heading = page.getByRole("heading", { name: "Workflows" });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  const workflowLink = page.getByRole("link", { name: /Sample Retry Test/ });
  // if ((await workflowLink.count()) === 0) {
  //   test.skip(
  //     true,
  //     "Sample Retry Test workflow is not available in this environment",
  //   );
  // }
  await workflowLink.click();
  const runButton = page
    .getByRole("button", { name: "Run", exact: true })
    .first();
  await expect(runButton).toBeEnabled();
  await runButton.click();
}
