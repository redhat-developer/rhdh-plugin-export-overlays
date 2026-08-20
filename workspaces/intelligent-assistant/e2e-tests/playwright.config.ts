import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

export default defineConfig({
  projects: [
    {
      name: "intelligent-assistant",
      workers: 1,
      testMatch: ["lightspeed.spec.ts", "notebook.spec.ts"],
      timeout: 5 * 60 * 1000,
    },
    {
      name: "intelligent-assistant-app-next",
      workers: 1,
      testMatch: ["lightspeed.spec.ts", "notebook.spec.ts"],
      timeout: 5 * 60 * 1000,
    },
  ],
});
