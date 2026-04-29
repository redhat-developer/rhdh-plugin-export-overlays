import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Keycloak catalog integration e2e test configuration.
 * Extends the base config from e2e-test-utils.
 */
export default defineConfig({
  projects: [
    {
      name: "keycloak",
    },
  ],
});
