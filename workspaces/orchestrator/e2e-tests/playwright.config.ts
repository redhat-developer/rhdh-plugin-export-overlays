import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Orchestrator E2E configuration using the current RHDH frontend.
 */
export default defineConfig({
  projects: [
    {
      name: "orchestrator",
      // Playwright bounds beforeAll/afterAll hooks with the project timeout,
      // not the test.describe.configure() timeout. The orchestrator beforeAll
      // installs SonataFlow, configures Loki and redeploys RHDH, which needs
      // far more than the 90s base default.
      timeout: 60 * 60 * 1000,
    },
  ],
});
