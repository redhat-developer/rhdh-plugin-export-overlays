import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

process.env.SKIP_KEYCLOAK_DEPLOYMENT = "true";

/**
 * Theme plugin e2e test configuration.
 *
 * Projects:
 * - theme — legacy app shell (default RHIDP merge layers).
 * - theme-app-next — namespace ends with -app-next, so e2e-test-utils merges
 *   NFS (app-next) secrets and default app-auth / app-integrations automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "theme",
    },
    {
      name: "theme-app-next",
    },
  ],
});
