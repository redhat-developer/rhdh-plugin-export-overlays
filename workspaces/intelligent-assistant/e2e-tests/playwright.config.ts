import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Smoke checks that Intelligent Assistant is installed and can answer.
 * Detailed IA flows live in the ai-rolling-demo-gitops e2e suite.
 */
export default defineConfig({
  projects: [
    {
      name: "intelligent-assistant",
      workers: 1,
      testMatch: [
        "lightspeed.spec.ts",
        "notebook.spec.ts",
        "saved-prompts.spec.ts",
        "screen-context.spec.ts",
        "mcp.spec.ts",
      ],
      timeout: 5 * 60 * 1000,
    },
  ],
});
