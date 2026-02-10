import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";
import dotenv from "dotenv";

dotenv.config({ path: `${import.meta.dirname}/.env` });
/**
 * Tech Radar plugin e2e test configuration.
 * Extends the base config from @red-hat-developer-hub/e2e-test-utils.
 */
export default defineConfig({
  projects: [
    {
      name: "tech-radar",
    },
    {
      name: "tech-radar-app-next",
    },
  ],
});
