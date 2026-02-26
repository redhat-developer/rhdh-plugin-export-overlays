import { defineConfig } from "rhdh-e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });
/**
 * Bulk import plugin e2e test configuration.
 * Extends the base config from rhdh-e2e-test-utils.
 */
export default defineConfig({
  projects: [
    {
      name: "bulk-import",
      timeout: 30 * 60 * 1000, // 30 min
    },
  ],
});
