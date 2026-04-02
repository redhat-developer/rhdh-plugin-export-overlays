import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });

export default defineConfig({
  projects: [
    {
      name: "global-header-default",
      testMatch: "**/tests/specs/default-global-header.spec.ts",
    },
    {
      name: "global-header-header-mount-points",
      testMatch: "**/tests/specs/header-mount-points.spec.ts",
    },
  ],
});
