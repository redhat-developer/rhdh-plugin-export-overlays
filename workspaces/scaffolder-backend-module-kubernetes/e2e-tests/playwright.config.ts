import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * scaffolder-backend-module-kubernetes plugin e2e test configuration.
 *
 * Projects:
 * - scaffolder-k8s-app-next — abbreviated name to stay within the 63-char OpenShift Route
 *   hostname limit (redhat-developer-hub-<namespace> would exceed with the full name).
 *   The -app-next suffix triggers e2e-test-utils to merge NFS secrets and default
 *   app-auth / app-integrations automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "scaffolder-k8s-app-next",
    },
  ],
});
