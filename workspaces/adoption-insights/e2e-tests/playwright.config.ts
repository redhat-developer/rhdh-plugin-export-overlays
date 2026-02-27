import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });

export default defineConfig({
  projects: [
    {
      name: "adoption-insights",
      // Allow deploy (waitUntilReady ~500s in e2e-test-utils) to complete in e2e-ocp-helm
      timeout: 600_000,
    },
  ],
});
