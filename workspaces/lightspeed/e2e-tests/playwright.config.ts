import { baseConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import { defineConfig as playwrightDefineConfig } from "@playwright/test";

/** Single project: both specs share one RHDH namespace (`lightspeed`). */
export default playwrightDefineConfig({
  ...baseConfig,
  workers: 1,
  projects: [
    {
      name: "lightspeed",
      workers: 1,
      testMatch: ["lightspeed.spec.ts", "notebook.spec.ts"],
      timeout: 5 * 60 * 1000,
    },
  ],
});
