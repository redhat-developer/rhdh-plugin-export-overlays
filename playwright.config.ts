import { defineConfig, devices } from "@playwright/test";
import { generateProjects } from "./e2e-test-utils/generate-projects";
import "dotenv/config";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./workspaces",

  timeout: 90_000,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: 3,
  outputDir: "node_modules/.cache/e2e-test-results",

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ["html", { outputFolder: "e2e-test-report", open: "never" }],
    ["json", { outputFile: "e2e-test-report/results.json" }],
    ["list"],
  ],

  use: {
    baseURL: process.env.BASE_URL,
    ignoreHTTPSErrors: true,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1920, height: 1080 },
    video: {
      mode: "on",
      size: { width: 1920, height: 1080 },
    },
    actionTimeout: 10_000,
    navigationTimeout: 50_000,
  },
  expect: {
    timeout: 10_000, // Global expect timeout
  },

  projects: generateProjects(),
});
