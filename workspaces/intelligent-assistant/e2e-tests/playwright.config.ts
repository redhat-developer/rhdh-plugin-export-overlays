import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Intelligent Assistant e2e test configuration.
 *
 * Projects:
 * - intelligent-assistant — legacy app shell (default RHIDP merge layers).
 * - intelligent-assistant-app-next — namespace ends with -app-next, so
 *   e2e-test-utils merges NFS (app-next) secrets and default app-auth /
 *   app-integrations automatically.
 *
 * Each project is its own Kubernetes namespace and RHDH install. workers: 1
 * keeps the serial chatbot/notebook specs on a single shared page per lane.
 */
const projectOptions = {
  workers: 1,
  testMatch: ["lightspeed.spec.ts", "notebook.spec.ts"],
  timeout: 5 * 60 * 1000,
};

export default defineConfig({
  projects: [
    {
      name: "intelligent-assistant",
      ...projectOptions,
    },
    {
      name: "intelligent-assistant-app-next",
      ...projectOptions,
    },
  ],
});
