import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Homepage plugin e2e — single project running the NFS (Backstage app) shell.
 * The spec uses the current RHDH frontend configuration.
 */
export default defineConfig({
  projects: [
    {
      name: "homepage",
    },
  ],
});
