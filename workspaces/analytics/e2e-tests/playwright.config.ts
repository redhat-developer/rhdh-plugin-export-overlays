import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

process.env.SKIP_KEYCLOAK_DEPLOYMENT = "true";

export default defineConfig({
  projects: [
    {
      name: "analytics-segment",
    },
  ],
});
