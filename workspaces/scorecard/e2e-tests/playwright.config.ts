import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Scorecard E2E configuration using the current RHDH frontend. The
 * scorecard-grouped project tests the grid layout with metric grouping.
 */
export default defineConfig({
  projects: [
    {
      name: "scorecard",
      testMatch: "scorecard.spec.ts",
      timeout: 10 * 60 * 1000,
    },
    {
      name: "scorecard-filecheck",
      testMatch: "scorecard-filecheck.spec.ts",
      timeout: 15 * 60 * 1000,
    },
    {
      name: "scorecard-grouped",
      testMatch: "scorecard-grouped.spec.ts",
      timeout: 10 * 60 * 1000,
    },
  ],
});
