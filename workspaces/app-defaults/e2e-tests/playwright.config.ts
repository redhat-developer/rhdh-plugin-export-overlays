import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * app-defaults workspace: project name `app-defaults-app-next` enables the app-next
 * shell (auto-detect). Package merges default OCI app-auth + app-integrations.
 */
export default defineConfig({
  projects: [
    {
      name: "app-defaults-app-next",
    },
  ],
});
