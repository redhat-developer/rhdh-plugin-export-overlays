import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });

/**
 * Backstage workspace e2e test configuration.
 * Extends the base config from rhdh-e2e-test-utils.
 */
export default defineConfig({
  projects: [
    {
      name: "backstage-github-events",
      testMatch: /tests\/specs\/github-events-module\.spec\.ts/,
    },
  ],
});
