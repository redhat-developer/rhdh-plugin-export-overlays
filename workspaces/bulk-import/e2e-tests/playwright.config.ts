import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Bulk import plugin E2E test configuration using the current RHDH frontend.
 *
 * The additional projects cover the orchestrator, scaffolder-template, and
 * guest-auth deployment variants.
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
    {
      name: "bulk-import-scaffolder-template",
      testMatch: "bulk-import-scaffolder-template.spec.ts",
      timeout: 30 * 60 * 1000,
    },
    {
      name: "bulk-import-permission",
      testMatch: "bulk-import-permission.spec.ts",
      timeout: 30 * 60 * 1000,
    },
  ],
});
