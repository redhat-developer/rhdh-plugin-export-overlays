import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/** Single project: both specs share one RHDH namespace (`lightspeed`). */
export default defineConfig({
  projects: [
    {
      name: "lightspeed",
      workers: 1,
      testMatch: ["lightspeed.spec.ts", "notebook.spec.ts"],
      timeout: 5 * 60 * 1000,
    },
  ],
});
