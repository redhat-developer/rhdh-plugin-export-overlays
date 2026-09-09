import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Quickstart plugin e2e test configuration.
 *
 * NFS-only: project name `quickstart-app-next` makes e2e-test-utils merge NFS
 * (app-next) secrets and the default app-auth / app-integrations layers.
 */
export default defineConfig({
  projects: [
    {
      name: "quickstart-app-next",
    },
  ],
});
