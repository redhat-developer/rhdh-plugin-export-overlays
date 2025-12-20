import { defineConfig } from "@playwright/test";
import { createPlaywrightConfig } from "rhdh-e2e-test-utils/playwright-config";
import "dotenv/config";

const workspaceName = import.meta.dirname.split("/").at(-2);

/**
 * Tech Radar plugin e2e test configuration.
 * Extends the base config from rhdh-e2e-test-utils.
 */
export default defineConfig(
  createPlaywrightConfig({
    projects: [
      {
        name: workspaceName,
      },
    ],
  })
);
