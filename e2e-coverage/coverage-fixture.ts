/**
 * Playwright fixture that collects Istanbul coverage (window.__coverage__)
 * from the browser after E2E tests.
 *
 * Enable by setting E2E_COLLECT_COVERAGE=1 in the environment.
 *
 * Usage in playwright.config.ts:
 *   import { coverageFixture } from '../e2e-coverage/coverage-fixture';
 *   export default defineConfig({
 *     use: { ...coverageFixture },
 *   });
 *
 * Or register as a global teardown:
 *   globalTeardown: '../e2e-coverage/coverage-fixture',
 */

import { test as base, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import {
  COLLECT_COVERAGE,
  COVERAGE_DIR,
  type CoverageData,
  mergeCoverage,
} from "./coverage-utils";

async function collectCoverage(page: Page): Promise<CoverageData | null> {
  try {
    const coverage = await page.evaluate(
      () => (window as unknown as { __coverage__?: CoverageData }).__coverage__,
    );
    return coverage ?? null;
  } catch {
    return null;
  }
}

let mergedCoverage: CoverageData = {};
let testCount = 0;

export const coverageTest = base.extend<{ coveragePage: Page }>({
  coveragePage: async ({ page }, use) => {
    if (!COLLECT_COVERAGE) {
      await use(page);
      return;
    }

    await use(page);

    const coverage = await collectCoverage(page);
    if (coverage) {
      mergedCoverage = mergeCoverage(mergedCoverage, coverage);
      testCount++;

      const workerFile = path.join(
        COVERAGE_DIR,
        `worker-${process.pid}-${testCount}.json`,
      );
      fs.mkdirSync(COVERAGE_DIR, { recursive: true });
      fs.writeFileSync(workerFile, JSON.stringify(coverage));
    }
  },
});

/**
 * Standalone coverage collector that can be used without extending fixtures.
 * Call this in afterEach or afterAll hooks.
 */
export async function collectAndSaveCoverage(
  page: Page,
  testName: string,
): Promise<void> {
  if (!COLLECT_COVERAGE) return;

  const coverage = await collectCoverage(page);
  if (!coverage) return;

  const sanitizedName = testName.replace(/[^a-zA-Z0-9-_]/g, "_");
  const outFile = path.join(COVERAGE_DIR, `${sanitizedName}.json`);
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(coverage));
}

/**
 * Merge all per-test coverage JSON files into a single coverage-final.json.
 * Call this in globalTeardown or after all tests complete.
 */
export function mergeCoverageFiles(coverageDir?: string): void {
  const dir = coverageDir || COVERAGE_DIR;
  if (!fs.existsSync(dir)) return;

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "coverage-final.json");

  if (files.length === 0) return;

  let merged: CoverageData = {};
  for (const file of files) {
    const data = JSON.parse(
      fs.readFileSync(path.join(dir, file), "utf-8"),
    ) as CoverageData;
    merged = mergeCoverage(merged, data);
  }

  const outFile = path.join(dir, "coverage-final.json");
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2));

  const fileCount = Object.keys(merged).length;
  console.log(
    `\n=== Coverage Summary ===\nFiles covered: ${fileCount}\nTests collected: ${files.length}\nOutput: ${outFile}\n`,
  );
}
