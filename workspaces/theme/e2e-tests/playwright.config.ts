import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

process.env.SKIP_KEYCLOAK_DEPLOYMENT = "true";

/**
 * Theme plugin e2e test configuration (NFS only).
 *
 * The namespace suffix -app-next triggers e2e-test-utils to merge NFS secrets
 * (APP_CONFIG_app_packageName=app-next, ENABLE_STANDARD_MODULE_FEDERATION=true)
 * and default app-auth / app-integrations dynamic plugins automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "theme-app-next",
    },
  ],
});
