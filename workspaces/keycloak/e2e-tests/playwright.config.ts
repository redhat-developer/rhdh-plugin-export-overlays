import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Keycloak catalog integration e2e test configuration.
 *
 * Projects:
 * - keycloak-app-next — namespace ends with -app-next, so e2e-test-utils merges
 *   NFS (app-next) secrets and default app-auth / app-integrations automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "keycloak-app-next",
    },
  ],
});
