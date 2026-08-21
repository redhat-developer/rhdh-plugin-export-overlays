import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Bulk import plugin e2e test configuration.
 * Extends the base config from rhdh-e2e-test-utils.
 *
 * Projects:
 * - bulk-import — legacy app shell (default RHIDP merge layers).
 * - bulk-import-app-next — namespace ends with -app-next, so e2e-test-utils merges
 *   NFS (app-next) secrets and default app-auth / app-integrations automatically.
 *   Runs the same spec as the legacy lane; the rationale for why its locators need
 *   no branching is next to BULK_IMPORT_HEADING in support/constants.
 * - bulk-import-orchestrator — legacy shell, orchestrator-mode config. Deliberately
 *   has no app-next counterpart: it also needs the orchestrator operator.
 */
export default defineConfig({
  projects: [
    {
      name: "bulk-import",
      testMatch: "bulk-import.spec.ts",
      timeout: 30 * 60 * 1000,
    },
    {
      name: "bulk-import-app-next",
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
