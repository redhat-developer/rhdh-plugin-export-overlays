import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/** Single project: UI + conversation tests share one RHDH namespace (`lightspeed`). */
export default defineConfig({
  projects: [
    {
      name: "lightspeed",
      testMatch: "lightspeed.spec.ts",
      timeout: 5 * 60 * 1000,
    },
  ],
});
