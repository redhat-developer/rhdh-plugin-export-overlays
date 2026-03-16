import { defineConfig } from "rhdh-e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });
/**
 * Orchestrator plugin e2e test configuration.
 * Extends the base config from rhdh-e2e-test-utils.
 */
export default defineConfig({
  projects: [
    {
      name: "orchestrator",
      testMatch: "specs/**/*.spec.ts",
      testIgnore: "specs/**/*-rbac.spec.ts",
    },
    {
      name: "orchestrator-rbac",
      dependencies: ["orchestrator"],
      testMatch: "specs/**/*-rbac.spec.ts",
    },
  ],
});
