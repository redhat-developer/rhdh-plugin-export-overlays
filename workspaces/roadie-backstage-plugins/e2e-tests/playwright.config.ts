import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * roadie-backstage-plugins e2e test configuration.
 *
 * Projects:
 * - gh-pull-requests-app-next — abbreviated name to stay within the 63-char OpenShift Route
 *   hostname limit (redhat-developer-hub-<namespace>). The -app-next suffix triggers
 *   e2e-test-utils to merge NFS (app-next) secrets and default app-auth / app-integrations
 *   automatically.
 * - scaffolder-http-request-app-next — abbreviated name to stay within hostname limit.
 *   Same NFS enablement via -app-next suffix.
 */
export default defineConfig({
  projects: [
    {
      name: "gh-pull-requests-app-next",
      testMatch:
        /tests\/specs\/backstage-plugin-github-pull-requests\.spec\.ts/,
    },
    {
      name: "scaffolder-http-request-app-next",
      testMatch:
        /tests\/specs\/scaffolder-backend-module-http-request\.spec\.ts/,
    },
  ],
});
