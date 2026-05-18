import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

export default defineConfig({
  projects: [
    {
      name: "rbac",
      testMatch: "rbac.spec.ts",
      timeout: 120_000,
    },
    {
      name: "rbac-default-permissions",
      testMatch: "rbac-default-permissions.spec.ts",
      dependencies: ["rbac"],
    },
  ],
});
