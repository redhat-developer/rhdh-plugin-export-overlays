import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * The app-defaults workspace verifies the default app-auth and app-integrations
 * dynamic plugins using the current RHDH frontend configuration.
 */
export default defineConfig({
  projects: [
    {
      name: "app-defaults",
    },
  ],
});
