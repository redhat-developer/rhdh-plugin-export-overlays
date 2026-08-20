import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * roadie-backstage-plugins e2e test configuration.
 *
 * Projects:
 * - backstage-plugin-github-pull-requests-app-next — namespace ends with -app-next, so
 *   e2e-test-utils merges NFS (app-next) secrets and default app-auth / app-integrations
 *   automatically.
 * - scaffolder-backend-module-http-request-app-next — same NFS enablement via -app-next suffix.
 */
export default defineConfig({
  projects: [
    {
      name: "backstage-plugin-github-pull-requests-app-next",
      testMatch:
        /tests\/specs\/backstage-plugin-github-pull-requests\.spec\.ts/,
    },
    {
      name: "scaffolder-backend-module-http-request-app-next",
      testMatch:
        /tests\/specs\/scaffolder-backend-module-http-request\.spec\.ts/,
    },
  ],
});
