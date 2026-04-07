import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });

process.env.SKIP_KEYCLOAK_DEPLOYMENT = "true";

export default defineConfig({
  projects: [
    {
      name: "quay", // Also used as Kubernetes namespace
    },
  ],
});
