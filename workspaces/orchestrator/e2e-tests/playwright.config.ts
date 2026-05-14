import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });

// Temporary hard pin until Lightspeed {{inherit}} tpl handling is fixed.
// TODO(RHDHBUGS-3030): Remove this override and use the latest CI chart.
// e2e-test-utils resolves chart version from RHDH_VERSION.
process.env.RHDH_VERSION = "1.10-114-CI";

/**
 * Orchestrator plugin e2e test configuration.
 * Extends the base config from rhdh-e2e-test-utils.
 */
export default defineConfig({
  projects: [
    {
      name: "orchestrator",
    },
  ],
});
