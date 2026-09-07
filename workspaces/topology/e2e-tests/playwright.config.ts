import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

/**
 * Topology plugin e2e test configuration.
 *
 * Projects:
 * - topology — legacy app shell (default RHIDP merge layers).
 * - topology-app-next — namespace ends with -app-next, so e2e-test-utils merges
 *   NFS (app-next) secrets and default app-auth / app-integrations automatically.
 */
export default defineConfig({
  projects: [
    {
      name: "topology",
    },
    {
      name: "topology-app-next",
    },
  ],
});
