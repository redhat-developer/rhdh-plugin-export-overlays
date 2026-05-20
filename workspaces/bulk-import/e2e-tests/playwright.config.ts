import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Bulk import plugin e2e test configuration.
 * Extends the base config from rhdh-e2e-test-utils.
 */
export default defineConfig({
  projects: [
    {
      name: "bulk-import",
      testMatch: "bulk-import.spec.ts",
      timeout: 30 * 60 * 1000,
    },
    {
      name: "bulk-import-orchestrator",
      testMatch: "bulk-import-orchestrator.spec.ts",
      timeout: 30 * 60 * 1000,
    },
  ],
});
