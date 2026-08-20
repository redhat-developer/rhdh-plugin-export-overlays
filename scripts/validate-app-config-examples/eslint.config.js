import js from "@eslint/js";
import tseslint from "typescript-eslint";

// A CLI, not a Playwright suite — so the shared e2e config (which pulls in
// eslint-plugin-playwright) does not apply here. Recommended rules only.
export default tseslint.config(
  { ignores: ["dist/", "dist-tests/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
