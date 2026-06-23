import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

export default defineConfig({
  projects: [
    {
      name: "lightspeed",
      workers: 1,
      testMatch: "ordered/*.ordered.spec.ts",
      timeout: 5 * 60 * 1000,
    },
  ],
});
