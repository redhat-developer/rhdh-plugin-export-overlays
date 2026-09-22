import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * scaffolder-backend-module-kubernetes E2E configuration. The abbreviated
 * project name keeps the OpenShift Route hostname within its 63-character limit.
 */
export default defineConfig({
  projects: [
    {
      name: "scaffolder-k8s",
    },
  ],
});
