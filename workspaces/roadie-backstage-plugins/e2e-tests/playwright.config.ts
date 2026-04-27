import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });

export default defineConfig({
  projects: [
    {
      name: "backstage-plugin-github-pull-requests",
      testMatch:
        /tests\/specs\/backstage-plugin-github-pull-requests\.spec\.ts/,
    },
    {
      name: "scaffolder-backend-module-http-request",
      testMatch:
        /tests\/specs\/scaffolder-backend-module-http-request\.spec\.ts/,
    },
  ],
});
