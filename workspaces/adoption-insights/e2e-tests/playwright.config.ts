import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Adoption Insights e2e test configuration (NFS only).
 *
 * The namespace suffix -app-next triggers e2e-test-utils to merge NFS secrets
 * and default app-auth / app-integrations dynamic plugins automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "adoption-insights-app-next",
    },
  ],
});
