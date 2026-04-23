import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

// Optional `.env` (gitignored), e.g. `GIT_PR_NUMBER=<n>` for PR OCI plugin images during deploy.
dotenv.config({ path: `${import.meta.dirname}/.env` });

export default defineConfig({
  projects: [
    {
      name: "adoption-insights",
    },
  ],
});
