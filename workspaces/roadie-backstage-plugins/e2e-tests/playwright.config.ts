import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * roadie-backstage-plugins e2e test configuration.
 *
 * Projects:
 * - gh-pull-requests — abbreviated name to stay within the 63-char OpenShift Route
 *   hostname limit (redhat-developer-hub-<namespace>).
 * - scaffolder-http-request — abbreviated name to stay within hostname limit.
 */
export default defineConfig({
  projects: [
    {
      name: "gh-pull-requests",
      testMatch:
        /tests\/specs\/backstage-plugin-github-pull-requests\.spec\.ts/,
    },
    {
      name: "scaffolder-http-request",
      testMatch:
        /tests\/specs\/scaffolder-backend-module-http-request\.spec\.ts/,
    },
  ],
});
