import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * scaffolder-backend-module-kubernetes plugin e2e test configuration.
 *
 * Projects:
 * - scaffolder-backend-module-kubernetes — legacy app shell (default RHIDP merge layers).
 * - scaffolder-backend-module-kubernetes-app-next — namespace ends with -app-next, so
 *   e2e-test-utils merges NFS (app-next) secrets and default app-auth / app-integrations
 *   automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "scaffolder-backend-module-kubernetes",
    },
    {
      name: "scaffolder-backend-module-kubernetes-app-next",
    },
  ],
});
