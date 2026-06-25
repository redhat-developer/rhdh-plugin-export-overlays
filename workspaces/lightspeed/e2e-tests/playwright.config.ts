import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

export default defineConfig({
  projects: [
    {
      name: "lightspeed",
      workers: 1,
      testMatch: ["lightspeed.spec.ts", "notebook.spec.ts", "mcp.spec.ts"],
      timeout: 5 * 60 * 1000,
    },
  ],
});