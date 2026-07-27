import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

export default defineConfig({
  projects: [
    {
      name: "scorecard",
      testMatch: "scorecard.spec.ts",
      timeout: 10 * 60 * 1000,
    },
    {
      name: "scorecard-filecheck",
      testMatch: "scorecard-filecheck.spec.ts",
      timeout: 15 * 60 * 1000,
    },
  ],
});
