import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * NFS-only configuration: all projects use the `-app-next` suffix to enable
 * the New Frontend System. The scorecard-grouped project tests the grid layout
 * with metric grouping (NFS extension).
 */
export default defineConfig({
  projects: [
    {
      name: "scorecard-app-next",
      testMatch: "scorecard.spec.ts",
      timeout: 10 * 60 * 1000,
    },
    {
      name: "scorecard-filecheck-app-next",
      testMatch: "scorecard-filecheck.spec.ts",
      timeout: 15 * 60 * 1000,
    },
    {
      name: "scorecard-grouped-app-next",
      testMatch: "scorecard-grouped.spec.ts",
      timeout: 10 * 60 * 1000,
    },
  ],
});
