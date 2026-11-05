import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * ACR plugin E2E test configuration using the current RHDH frontend.
 */
export default defineConfig({
  projects: [
    {
      name: "acr",
    },
  ],
});
