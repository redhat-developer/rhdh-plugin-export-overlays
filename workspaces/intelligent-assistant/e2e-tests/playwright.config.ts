import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Project name must end with -app-next so e2e-test-utils enables the NFS shell
 * and merges app-auth / app-integrations.
 */
export default defineConfig({
  projects: [
    {
      name: "intelligent-assistant-app-next",
      workers: 1,
      testMatch: ["lightspeed.spec.ts", "notebook.spec.ts"],
      timeout: 5 * 60 * 1000,
    },
  ],
});
