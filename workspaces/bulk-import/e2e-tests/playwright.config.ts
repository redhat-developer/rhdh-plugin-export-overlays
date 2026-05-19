import { defineConfig } from "@playwright/test";
import { baseConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Bulk import plugin e2e test configuration.
 * Extends the base config from rhdh-e2e-test-utils.
 */
export default defineConfig({
  ...baseConfig,
  use: {
    ...baseConfig.use,
  },
  workers: 1,
  projects: [
    {
      name: "bulk-import",
      testMatch: "**/tests/specs/bulk-import.spec.ts",
      timeout: 30 * 60 * 1000,
      // use: {
      //   viewport: null,
      // },
    },
    {
      name: "bulk-import-orchestrator",
      testMatch: "**/tests/specs/bulk-import-orchestrator.spec.ts",
      timeout: 30 * 60 * 1000,
      // use: {
      //   viewport: null,
      // },
    },
  ],
});
