import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

export default defineConfig({
  projects: [
    {
      name: "lightspeed",
      workers: 1,
      testMatch: "lightspeed.spec.ts",
      timeout: 5 * 60 * 1000,
    },
    {
      name: "lightspeed-notebook",
      workers: 1,
      testMatch: "notebook.spec.ts",
      timeout: 5 * 60 * 1000,
      dependencies: ["lightspeed"],
    },
    {
      name: "lightspeed-mcp",
      workers: 1,
      testMatch: "mcp.spec.ts",
      timeout: 5 * 60 * 1000,
      dependencies: ["lightspeed-notebook"],
    },
  ],
});
