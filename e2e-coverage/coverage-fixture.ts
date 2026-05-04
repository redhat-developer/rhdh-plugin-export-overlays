/**
 * Playwright fixture that collects Istanbul coverage (window.__coverage__)
 * from the browser after E2E tests.
 *
 * Enable by setting E2E_COLLECT_COVERAGE=1 in the environment.
 *
 * Usage in playwright.config.ts:
 *   import { coverageTest } from '../e2e-coverage/coverage-fixture';
 *   // use coverageTest instead of test
 *
 * Or use the standalone function in afterEach:
 *   import { collectAndSaveCoverage } from '../e2e-coverage/coverage-fixture';
 */

import { test as base, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  COLLECT_COVERAGE,
  COVERAGE_DIR,
  type CoverageData,
} from "./coverage-utils";

async function collectCoverage(page: Page): Promise<CoverageData | null> {
  try {
    const coverage = await page.evaluate(
      () =>
        (globalThis as unknown as { __coverage__?: CoverageData }).__coverage__,
    );
    return coverage ?? null;
  } catch {
    return null;
  }
}

export const coverageTest = base.extend<{ coveragePage: Page }>({
  coveragePage: async ({ page }, use) => {
    if (!COLLECT_COVERAGE) {
      await use(page);
      return;
    }

    await use(page);

    const coverage = await collectCoverage(page);
    if (coverage) {
      const workerFile = path.join(
        COVERAGE_DIR,
        `worker-${process.pid}-${Date.now()}.json`,
      );
      fs.mkdirSync(COVERAGE_DIR, { recursive: true });
      fs.writeFileSync(workerFile, JSON.stringify(coverage));
    }
  },
});

export async function collectAndSaveCoverage(
  page: Page,
  testName: string,
): Promise<void> {
  if (!COLLECT_COVERAGE) return;

  const coverage = await collectCoverage(page);
  if (!coverage) return;

  const sanitizedName = testName.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const outFile = path.join(COVERAGE_DIR, `${sanitizedName}.json`);
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(coverage));
}
