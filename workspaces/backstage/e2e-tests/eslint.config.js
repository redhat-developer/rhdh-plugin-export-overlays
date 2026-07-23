import { createEslintConfig } from "@red-hat-developer-hub/e2e-test-utils/eslint";

export default [
  ...createEslintConfig(import.meta.dirname),
  {
    // Informational test diagnostics (resource IDs, retry notes) should not use warn.
    files: [
      "**/*.spec.ts",
      "**/*.test.ts",
      "**/tests/**/*.ts",
      "**/e2e/**/*.ts",
    ],
    rules: {
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
];
