import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });

export default defineConfig({
  projects: [
    {
      name: "quickstart",
    },
  ],
});