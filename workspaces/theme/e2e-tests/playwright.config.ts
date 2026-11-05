import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

process.env.SKIP_KEYCLOAK_DEPLOYMENT = "true";

/**
 * Theme plugin E2E test configuration using the current RHDH frontend.
 */
export default defineConfig({
  projects: [
    {
      name: "theme",
    },
  ],
});
