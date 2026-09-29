import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Global Header plugin e2e — single project running the NFS (Backstage app) shell.
 */
export default defineConfig({
  projects: [
    {
      name: "global-header",
      testMatch: "**/tests/specs/default-global-header.spec.ts",
    },
  ],
});
