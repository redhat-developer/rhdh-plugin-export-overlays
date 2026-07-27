import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Tech Radar plugin e2e test configuration.
 *
 * Projects:
 * - tech-radar — legacy app shell (default RHIDP merge layers).
 * - tech-radar-app-next — namespace ends with -app-next, so e2e-test-utils merges
 *   NFS (app-next) secrets and default app-auth / app-integrations automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "tech-radar",
    },
    {
      name: "tech-radar-app-next",
    },
  ],
});
