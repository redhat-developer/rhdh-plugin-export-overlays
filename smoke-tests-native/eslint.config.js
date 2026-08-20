import js from "@eslint/js";
import tseslint from "typescript-eslint";

// A node:test harness, not a Playwright suite — so the shared
// @red-hat-developer-hub/e2e-test-utils/eslint config used by the e2e
// workspaces does not apply here. Recommended rules only.
export default tseslint.config(
  { ignores: ["dist/", "dist-tests/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
