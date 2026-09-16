import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Orchestrator e2e: NFS only. The old frontend system is gone from RHDH;
 * `-app-next` makes e2e-test-utils merge NFS secrets and default app-auth /
 * app-integrations layers.
 */
export default defineConfig({
  projects: [
    {
      name: "orchestrator-app-next",
    },
  ],
});
