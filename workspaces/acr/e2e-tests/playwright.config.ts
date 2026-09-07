import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * ACR plugin e2e test configuration.
 *
 * Projects:
 * - acr — legacy app shell (default RHIDP merge layers).
 * - acr-app-next — namespace ends with -app-next, so e2e-test-utils merges
 *   NFS (app-next) secrets and default app-auth / app-integrations automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "acr",
    },
    {
      name: "acr-app-next",
    },
  ],
});
